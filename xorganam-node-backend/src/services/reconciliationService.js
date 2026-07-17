import { query } from '../db/pool.js'
import { queryTransactionStatus, EganowApiError, isGatewaySuccess, isGatewayFailure } from './eganowClient.js'
import { enqueueCollectForMeJob } from '../queue/queue.js'
import { sendMerchantSms } from './notificationService.js'

/**
 * Forces an immediate status re-check against Eganow for a transaction
 * that's stuck in a non-terminal state, instead of waiting for a webhook.
 * Idempotent: calling this on an already-terminal transaction is a no-op.
 */
export async function reconcileTransaction(transactionId, callerTenantId) {
  const { rows } = await query(
    `SELECT id, tenant_id, merchant_id, parent_transaction_id, type, status, amount, internal_reference, payout_msisdn
       FROM transactions WHERE id = $1`,
    [transactionId]
  )

  if (rows.length === 0) return null
  const txn = rows[0]

  if (callerTenantId && txn.tenant_id !== callerTenantId) {
    return null // ownership check - caller should treat this as "not found"
  }

  if (txn.status !== 'PENDING') {
    return txn // already terminal - no-op
  }

  let upstreamStatus
  try {
    const result = await queryTransactionStatus(txn.tenant_id, txn.internal_reference)
    upstreamStatus = result.status
  } catch (err) {
    if (err instanceof EganowApiError) {
      throw err
    }
    throw new EganowApiError(`Status query failed: ${err.message}`, txn.tenant_id)
  }

  if (isGatewayFailure(upstreamStatus)) {
    await query(
      `UPDATE transactions
          SET status = 'FAILED',
              payment_gateway_status = $3,
              failure_reason = $2,
              updated_at = now(),
              completed_at = now()
        WHERE id = $1`,
      [txn.id, 'Reconciled as failed from Eganow status query.', upstreamStatus]
    )
    return { ...txn, status: 'FAILED' }
  }

  if (isGatewaySuccess(upstreamStatus)) {
    if (txn.type === 'INTERNAL_TRANSFER') {
      await query(
        `UPDATE transactions
            SET status = 'SWEPT_INTERNAL',
                payment_gateway_status = $2,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [txn.id, upstreamStatus]
      )
      if (txn.parent_transaction_id) {
        await query(`UPDATE transactions SET status = 'SWEPT_INTERNAL', updated_at = now() WHERE id = $1`, [txn.parent_transaction_id])
        await enqueueCollectForMeJob({ tenantId: txn.tenant_id, merchantId: txn.merchant_id, transactionId: txn.parent_transaction_id })
      }
      return { ...txn, status: 'SWEPT_INTERNAL', payment_gateway_status: upstreamStatus }
    }

    if (txn.type === 'PAYOUT') {
      await query(
        `UPDATE transactions
            SET status = 'PAID_OUT',
                payment_gateway_status = $2,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [txn.id, upstreamStatus]
      )
      const rootCollectionId = await findRootCollectionId(txn.id)
      if (rootCollectionId) {
        await query(`UPDATE transactions SET status = 'PAID_OUT', updated_at = now() WHERE id = $1`, [rootCollectionId])
      }

      const merchantRow = await query(
        `SELECT mobile_money_number FROM merchants WHERE id = $1`,
        [txn.merchant_id]
      )
      const merchant = merchantRow.rows[0]
      if (merchant) {
        await sendMerchantSms(txn.tenant_id, txn.payout_msisdn || merchant.mobile_money_number, `GHS ${Number(txn.amount).toFixed(2)} has been sent to your Mobile Money account. Ref: ${txn.internal_reference}.`)
      }
      return { ...txn, status: 'PAID_OUT', payment_gateway_status: upstreamStatus }
    }

    // Gateway success confirms the collection. The payout lifecycle is
    // tracked separately as SWEPT_INTERNAL / PAID_OUT.
    await query(
      `UPDATE transactions
          SET status = 'RECEIVED',
              payment_gateway_status = $2,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [txn.id, upstreamStatus]
    )

    const merchantRow = await query(
      `SELECT payout_mode, mobile_money_number FROM merchants WHERE id = $1`,
      [txn.merchant_id]
    )
    const merchant = merchantRow.rows[0]

    if (merchant?.payout_mode === 'AUTO_SWEEP') {
      await enqueueCollectForMeJob({ tenantId: txn.tenant_id, merchantId: txn.merchant_id, transactionId: txn.id })
    } else if (merchant) {
      await sendMerchantSms(txn.tenant_id, merchant.mobile_money_number, `Payment of ${txn.amount} received. Ref: ${txn.internal_reference}.`)
    }
    return { ...txn, status: 'RECEIVED', payment_gateway_status: upstreamStatus }
  }

  return txn
}

async function findRootCollectionId(transactionId) {
  const { rows } = await query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_transaction_id, type
         FROM transactions
        WHERE id = $1
       UNION ALL
       SELECT t.id, t.parent_transaction_id, t.type
         FROM transactions t
         JOIN ancestors a ON a.parent_transaction_id = t.id
     )
     SELECT id FROM ancestors WHERE type = 'COLLECTION' LIMIT 1`,
    [transactionId]
  )
  return rows[0]?.id || null
}
