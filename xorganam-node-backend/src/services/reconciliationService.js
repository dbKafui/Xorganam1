import { query } from '../db/pool.js'
import { queryTransactionStatus, EganowApiError } from './eganowClient.js'
import { enqueueCollectForMeJob } from '../queue/queue.js'
import { sendMerchantSms } from './notificationService.js'

function mapStatus(eganowStatus) {
  switch (String(eganowStatus).toLowerCase()) {
    case 'success':
    case 'successful':
    case 'completed':
      return 'RECEIVED' // for a COLLECTION-type txn specifically; see caller
    case 'failed':
    case 'failure':
    case 'declined':
      return 'FAILED'
    default:
      return null // still pending upstream, nothing to change
  }
}

/**
 * Forces an immediate status re-check against Eganow for a transaction
 * that's stuck in a non-terminal state, instead of waiting for a webhook.
 * Idempotent: calling this on an already-terminal transaction is a no-op.
 */
export async function reconcileTransaction(transactionId, callerTenantId) {
  const { rows } = await query(
    `SELECT id, tenant_id, merchant_id, type, status, internal_reference
       FROM transactions WHERE id = $1`,
    [transactionId]
  )

  if (rows.length === 0) return null
  const txn = rows[0]

  if (callerTenantId && txn.tenant_id !== callerTenantId) {
    return null // ownership check - caller should treat this as "not found"
  }

  if (txn.status !== 'RECEIVED' || txn.type !== 'COLLECTION') {
    return txn // already terminal, or not a reconcilable leg - no-op
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

  if (String(upstreamStatus).toLowerCase() === 'failed' || String(upstreamStatus).toLowerCase() === 'declined') {
    await query(
      `UPDATE transactions SET status = 'FAILED', failure_reason = $2, updated_at = now(), completed_at = now() WHERE id = $1`,
      [txn.id, 'Reconciled as failed from Eganow status query.']
    )
    return { ...txn, status: 'FAILED' }
  }

  if (String(upstreamStatus).toLowerCase() === 'success' || String(upstreamStatus).toLowerCase() === 'successful') {
    // Transaction already lands as RECEIVED on creation for this schema
    // (money is in the collection account the moment Eganow accepts it) -
    // reconciling a "success" here means routing it into the same
    // AUTO_SWEEP / MANUAL fork the webhook uses, in case the webhook that
    // should have done this never arrived.
    const merchantRow = await query(
      `SELECT payout_mode, mobile_money_number FROM merchants WHERE id = $1`,
      [txn.merchant_id]
    )
    const merchant = merchantRow.rows[0]

    if (merchant?.payout_mode === 'AUTO_SWEEP') {
      await enqueueCollectForMeJob({ tenantId: txn.tenant_id, merchantId: txn.merchant_id, transactionId: txn.id })
    } else if (merchant) {
      await sendMerchantSms(txn.tenant_id, merchant.mobile_money_number, `Payment received. Ref: ${txn.internal_reference}.`)
    }
  }

  return txn // status stays RECEIVED either way; downstream legs report their own outcome
}
