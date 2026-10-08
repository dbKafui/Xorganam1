import { query, withTransaction } from '../db/pool.js'
import { queryTransactionStatus, EganowApiError, isGatewaySuccess, isGatewayFailure } from './eganowClient.js'
import { enqueueCollectForMeJob } from '../queue/queue.js'
import { sendMerchantSms } from './notificationService.js'
import { markCreditInstallmentCollected } from './creditInstallmentSettlement.js'
import { markStorefrontOrderPaid } from './storefrontOrderService.js'
import { updateTransactionStatus } from './transactionStateService.js'
import { validateProviderResult } from './providerResultValidation.js'

/**
 * Forces an immediate status re-check against Eganow for a transaction
 * that's stuck in a non-terminal state, instead of waiting for a webhook.
 * Idempotent: calling this on an already-terminal transaction is a no-op.
 */
export async function reconcileTransaction(transactionId, callerTenantId) {
  const { rows } = await query(
    `SELECT t.id, t.tenant_id, t.merchant_id, t.parent_transaction_id, t.type, t.status, t.amount, t.currency,
            t.internal_reference, t.payout_msisdn, p.status AS parent_status
       FROM transactions t
       LEFT JOIN transactions p ON p.id = t.parent_transaction_id
      WHERE t.id = $1`,
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
  let providerResult
  try {
    providerResult = await queryTransactionStatus(txn.tenant_id, txn.internal_reference, { merchantId: txn.merchant_id })
    upstreamStatus = providerResult.status
  } catch (err) {
    if (err instanceof EganowApiError) {
      throw err
    }
    throw new EganowApiError(`Status query failed: ${err.message}`, txn.tenant_id)
  }

  const validation = validateProviderResult({
    expectedAmount: String(txn.amount),
    expectedCurrency: txn.currency,
    expectedReference: txn.internal_reference,
    actualAmount: providerResult?.amount ?? providerResult?.transactionAmount ?? providerResult?.TransactionAmount,
    actualCurrency: providerResult?.currency ?? providerResult?.transCurrencyIso ?? providerResult?.currencyCode,
    actualReference: providerResult?.reference ?? providerResult?.eganowReference
  })

  if (!validation.valid) {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE transactions SET payment_gateway_status = $2, failure_reason = $3,
                updated_at = now()
          WHERE id = $1 AND status = 'PENDING'`,
        [txn.id, upstreamStatus, `Provider result mismatch for ${validation.mismatches.join(', ')}. Reconcile manually before retrying.`]
      )
    })
    return {
      ...txn,
      status: 'PENDING',
      payment_gateway_status: upstreamStatus,
      failure_reason: `Provider result mismatch for ${validation.mismatches.join(', ')}. Reconcile manually before retrying.`
    }
  }

  if (isGatewayFailure(upstreamStatus)) {
    await withTransaction(async (client) => {
      await updateTransactionStatus(client, {
        id: txn.id,
        type: txn.type,
        currentStatus: txn.status,
        nextStatus: 'FAILED',
        fields: {
          payment_gateway_status: upstreamStatus,
          failure_reason: 'Reconciled as failed from Eganow status query.',
          completed_at: new Date()
        }
      })
    })
    return { ...txn, status: 'FAILED' }
  }

  if (isGatewaySuccess(upstreamStatus)) {
    if (txn.type === 'INTERNAL_TRANSFER') {
      await withTransaction(async (client) => {
        await updateTransactionStatus(client, {
          id: txn.id,
          type: txn.type,
          currentStatus: txn.status,
          nextStatus: 'SWEPT_INTERNAL',
          fields: {
            payment_gateway_status: upstreamStatus,
            completed_at: new Date()
          }
        })
        if (txn.parent_transaction_id) {
          await updateTransactionStatus(client, {
            id: txn.parent_transaction_id,
            type: 'COLLECTION',
            currentStatus: txn.parent_status || 'RECEIVED',
            nextStatus: 'SWEPT_INTERNAL',
            fields: {}
          })
          await markCreditInstallmentCollected(client, txn.parent_transaction_id)
        }
      })
      if (txn.parent_transaction_id) {
        await enqueueCollectForMeJob({ tenantId: txn.tenant_id, merchantId: txn.merchant_id, transactionId: txn.parent_transaction_id })
      }
      return { ...txn, status: 'SWEPT_INTERNAL', payment_gateway_status: upstreamStatus }
    }

    if (txn.type === 'PAYOUT') {
      await withTransaction(async (client) => {
        await updateTransactionStatus(client, {
          id: txn.id,
          type: txn.type,
          currentStatus: txn.status,
          nextStatus: 'PAID_OUT',
          fields: {
            payment_gateway_status: upstreamStatus,
            completed_at: new Date()
          }
        })
      })
      const rootCollectionId = await findRootCollectionId(txn.id)
      if (rootCollectionId) {
        const { rows: parentRows } = await query('SELECT status FROM transactions WHERE id = $1', [rootCollectionId])
        await updateTransactionStatus(query, {
          id: rootCollectionId,
          type: 'COLLECTION',
          currentStatus: parentRows[0]?.status || 'PENDING',
          nextStatus: 'PAID_OUT',
          fields: {}
        })
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
    await withTransaction(async (tx) => {
      await updateTransactionStatus(tx, {
        id: txn.id,
        type: txn.type,
        currentStatus: txn.status,
        nextStatus: 'RECEIVED',
        fields: {
          payment_gateway_status: upstreamStatus,
          completed_at: new Date()
        }
      })
      await markStorefrontOrderPaid(tx, txn.id)
    })

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
