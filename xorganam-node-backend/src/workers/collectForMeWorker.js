import { Worker } from 'bullmq'
import crypto from 'node:crypto'
import { getRedisConnection, COLLECT_FOR_ME_QUEUE } from '../queue/queue.js'
import { query, withTransaction } from '../db/pool.js'
import { sweepToPayoutAccount, disburseToMobileMoney, EganowApiError } from '../services/eganowClient.js'
import { TenantCredentialsError } from '../services/credentialsService.js'
import { sendMerchantSms } from '../services/notificationService.js'

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '10', 10)

/**
 * A job carries only IDs - never credentials, never amounts trusted from
 * the job payload alone. Everything financial is re-read from the
 * database at execution time, scoped by tenant_id + merchant_id, so a
 * stale or tampered job can't move money using outdated numbers.
 */
async function processCollectForMeJob(job) {
  const { tenantId, merchantId, transactionId } = job.data

  if (!tenantId || !merchantId || !transactionId) {
    // A malformed job is a bug in the enqueuer, not a transient failure -
    // fail permanently rather than retrying something that can never succeed.
    throw new Error(`Malformed job payload: ${JSON.stringify(job.data)}`)
  }

  const context = await loadJobContext(tenantId, merchantId, transactionId)

  if (!context) {
    console.warn(`[collect-for-me] job ${job.id} references missing tenant/merchant/transaction - dropping.`)
    return { skipped: true }
  }

  const { merchant, collectionTxn } = context

  if (collectionTxn.status !== 'RECEIVED') {
    console.log(`[collect-for-me] transaction ${transactionId} already at status ${collectionTxn.status} - skipping (idempotent).`)
    return { skipped: true, reason: 'not-in-received-state' }
  }

  // ---- Step 1: Internal Transfer - collection account -> payout account
  const transferTxn = await createChildTransaction({
    tenantId,
    merchantId,
    parentTransactionId: collectionTxn.id,
    type: 'INTERNAL_TRANSFER',
    amount: collectionTxn.amount,
    currency: collectionTxn.currency
  })

  try {
    const transferResult = await sweepToPayoutAccount(tenantId, {
      reference: transferTxn.internal_reference,
      amount: collectionTxn.amount,
      currency: collectionTxn.currency,
      network: merchant.network_provider
    })

    await markTransactionResult(transferTxn.id, {
      success: true,
      status: 'SWEPT_INTERNAL',
      eganowReference: transferResult.reference,
      eganowTransactionId: transferResult.transactionId
    })
    await markTransactionResult(collectionTxn.id, { success: true, status: 'SWEPT_INTERNAL' })
  } catch (err) {
    await markTransactionResult(transferTxn.id, { success: false, status: 'FAILED', failureReason: err.message })
    await markTransactionResult(collectionTxn.id, { success: false, status: 'FAILED', failureReason: `Sweep failed: ${err.message}` })
    // Re-throw as a tagged, tenant-scoped error - this is what gives BullMQ
    // a clean per-job failure. It does NOT touch any other job's promise,
    // connection, or state; Tenant B/C jobs on this same worker process
    // continue unaffected because each job invocation is independent.
    throw taggedError(err, tenantId, 'InternalTransfer')
  }

  // ---- Step 2: External Disbursal - payout account -> merchant's MoMo -
  const payoutTxn = await createChildTransaction({
    tenantId,
    merchantId,
    parentTransactionId: transferTxn.id,
    type: 'PAYOUT',
    amount: collectionTxn.amount,
    currency: collectionTxn.currency
  })

  try {
    const payoutResult = await disburseToMobileMoney(tenantId, {
      reference: payoutTxn.internal_reference,
      amount: collectionTxn.amount,
      currency: collectionTxn.currency,
      accountNoOrCardNoOrMsisdn: merchant.mobile_money_number,
      network: merchant.network_provider,
      narration: `Payout for collection ${collectionTxn.internal_reference}`
    })

    await markTransactionResult(payoutTxn.id, {
      success: true,
      status: 'PAID_OUT',
      eganowReference: payoutResult.reference,
      eganowTransactionId: payoutResult.transactionId
    })
    await markTransactionResult(collectionTxn.id, { success: true, status: 'PAID_OUT' })
  } catch (err) {
    await markTransactionResult(payoutTxn.id, { success: false, status: 'FAILED', failureReason: err.message })
    // Note: collectionTxn stays at SWEPT_INTERNAL, not FAILED - the money
    // really did leave the collection account. That needs a human to
    // reconcile/retry the payout leg specifically, not a fresh sweep.
    throw taggedError(err, tenantId, 'Payout')
  }

  // ---- Step 3: notify the merchant ------------------------------------
  const message = `GHS ${Number(collectionTxn.amount).toFixed(2)} has been sent to your Mobile Money account. Ref: ${payoutTxn.internal_reference}.`
  await sendMerchantSms(tenantId, merchant.mobile_money_number, message)

  return { success: true, payoutTransactionId: payoutTxn.id }
}

/**
 * Wraps any error from an Eganow call (or a credentials problem) with the
 * tenant it belongs to, so worker-level logs and BullMQ's failed-job
 * inspector always show which tenant was affected without ever mixing
 * that context into another tenant's job.
 */
function taggedError(err, tenantId, stage) {
  if (err instanceof EganowApiError || err instanceof TenantCredentialsError) {
    return err
  }
  const wrapped = new Error(`[tenant:${tenantId}] ${stage} failed: ${err.message}`)
  wrapped.cause = err
  wrapped.tenantId = tenantId
  return wrapped
}

async function loadJobContext(tenantId, merchantId, transactionId) {
  const { rows } = await query(
    `SELECT
        m.id, m.eganow_collection_account_id, m.eganow_payout_account_id,
        m.mobile_money_number, m.network_provider,
        t.id AS txn_id, t.status AS txn_status, t.amount, t.currency, t.internal_reference
     FROM merchants m
     JOIN transactions t
       ON t.tenant_id = m.tenant_id AND t.merchant_id = m.id AND t.id = $3
     WHERE m.tenant_id = $1 AND m.id = $2`,
    [tenantId, merchantId, transactionId]
  )

  if (rows.length === 0) return null

  const row = rows[0]
  return {
    merchant: {
      id: row.id,
      eganow_collection_account_id: row.eganow_collection_account_id,
      eganow_payout_account_id: row.eganow_payout_account_id,
      mobile_money_number: row.mobile_money_number,
      network_provider: row.network_provider
    },
    collectionTxn: {
      id: row.txn_id,
      status: row.txn_status,
      amount: row.amount,
      currency: row.currency,
      internal_reference: row.internal_reference
    }
  }
}

async function createChildTransaction({ tenantId, merchantId, parentTransactionId, type, amount, currency }) {
  const internalReference = `${type === 'INTERNAL_TRANSFER' ? 'IT' : 'PO'}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, parent_transaction_id, type, status, amount, currency, internal_reference)
       VALUES ($1, $2, $3, $4, 'RECEIVED', $5, $6, $7)
       RETURNING id, internal_reference`,
      [tenantId, merchantId, parentTransactionId, type, amount, currency, internalReference]
    )
    return rows[0]
  })
}

async function markTransactionResult(transactionId, { success, status, eganowReference, eganowTransactionId, failureReason }) {
  await query(
    `UPDATE transactions
        SET status = $2,
            eganow_reference = COALESCE($3, eganow_reference),
            eganow_transaction_id = COALESCE($4, eganow_transaction_id),
            failure_reason = $5,
            completed_at = CASE WHEN $6 THEN now() ELSE completed_at END,
            updated_at = now()
      WHERE id = $1`,
    [transactionId, status, eganowReference || null, eganowTransactionId || null, failureReason || null, success]
  )
}

export const collectForMeWorker = new Worker(
  COLLECT_FOR_ME_QUEUE,
  async (job) => {
    try {
      return await processCollectForMeJob(job)
    } catch (err) {
      // Log with full tenant context, then re-throw so BullMQ records the
      // job as failed and applies its configured retry/backoff. Never
      // swallow here - swallowing would silently strand a merchant's
      // money mid-pipeline with no retry and no record of failure.
      console.error(
        `[collect-for-me] job ${job.id} failed (tenant=${job.data?.tenantId}, merchant=${job.data?.merchantId}, attempt=${job.attemptsMade}):`,
        err.message
      )
      throw err
    }
  },
  {
    connection: getRedisConnection(),
    concurrency: WORKER_CONCURRENCY
  }
)

collectForMeWorker.on('failed', (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    console.error(
      `[collect-for-me] job ${job.id} permanently failed after ${job.attemptsMade} attempts (tenant=${job.data?.tenantId}). Needs manual reconciliation.`,
      err.message
    )
    // In production: alert ops / write to a dead-letter table keyed by
    // tenant_id so one tenant's persistent failures are triageable
    // without scanning every other tenant's jobs.
  }
})

// A worker-level error (e.g. Redis connection drop) is NOT the same as a
// job failure - this must never crash the process, since that would take
// down every tenant's in-flight jobs at once rather than just the one
// that errored.
collectForMeWorker.on('error', (err) => {
  console.error('[collect-for-me] worker-level error (connection/infra, not job-specific):', err)
})

console.log(`[collect-for-me] worker started, concurrency=${WORKER_CONCURRENCY}`)

// Last line of defense: an unhandled rejection or exception anywhere in
// this process must be logged, not allowed to crash the worker - a crash
// here would drop every tenant's in-flight jobs, not just the one that
// triggered it. BullMQ's own job try/catch above should catch everything
// job-related; these two are for anything outside that boundary.
process.on('unhandledRejection', (reason) => {
  console.error('[collect-for-me] unhandledRejection', reason)
})

process.on('uncaughtException', (err) => {
  console.error('[collect-for-me] uncaughtException', err)
})

process.on('SIGTERM', async () => {
  console.log('[collect-for-me] SIGTERM received, closing worker gracefully…')
  await collectForMeWorker.close()
  process.exit(0)
})
