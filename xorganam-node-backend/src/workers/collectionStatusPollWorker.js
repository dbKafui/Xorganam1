import { Worker } from 'bullmq'
import { getRedisConnection, COLLECTION_STATUS_POLL_QUEUE, enqueueCollectForMeJob } from '../queue/queue.js'
import { query } from '../db/pool.js'
import { queryTransactionStatus, EganowApiError } from '../services/eganowClient.js'
import { sendMerchantSms } from '../services/notificationService.js'

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10)
const POLL_DELAY_MS = parseInt(process.env.COLLECTION_STATUS_POLL_DELAY_MS || '5000', 10)
const MAX_POLL_ATTEMPTS = parseInt(process.env.COLLECTION_STATUS_POLL_ATTEMPTS || '12', 10)

const PENDING_STATUSES = new Set(['pending', 'received', 'processing', 'accepted'])
const SUCCESS_STATUSES = new Set(['success', 'successful', 'completed'])
const FAILURE_STATUSES = new Set(['failed', 'failure', 'declined'])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function loadTransactionContext(transactionId, tenantId, merchantId) {
  const { rows } = await query(
    `SELECT t.id, t.status, t.amount, t.currency, t.internal_reference, t.eganow_reference,
            t.eganow_transaction_id, m.payout_mode, m.mobile_money_number
       FROM transactions t
       JOIN merchants m ON m.id = t.merchant_id
      WHERE t.id = $1 AND t.tenant_id = $2 AND t.merchant_id = $3`,
    [transactionId, tenantId, merchantId]
  )
  return rows[0] || null
}

async function updateCollectionTransactionFields(transactionId, { reference, transactionId: upstreamTxnId }) {
  await query(
    `UPDATE transactions
        SET eganow_reference = COALESCE($2, eganow_reference),
            eganow_transaction_id = COALESCE($3, eganow_transaction_id),
            updated_at = now()
      WHERE id = $1`,
    [transactionId, reference || null, upstreamTxnId || null]
  )
}

async function markCollectionFailed(transactionId, reason) {
  await query(
    `UPDATE transactions
        SET status = 'FAILED', failure_reason = $2, updated_at = now(), completed_at = now()
      WHERE id = $1`,
    [transactionId, reason]
  )
}

async function processCollectionStatusPollJob(job) {
  const { tenantId, merchantId, transactionId } = job.data
  if (!tenantId || !merchantId || !transactionId) {
    throw new Error(`Malformed status poll job data: ${JSON.stringify(job.data)}`)
  }

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    const txn = await loadTransactionContext(transactionId, tenantId, merchantId)
    if (!txn) {
      console.warn(`[status-poll] transaction not found for job ${job.id} txn=${transactionId}`)
      return { skipped: true }
    }

    if (txn.status !== 'RECEIVED') {
      console.log(`[status-poll] transaction ${transactionId} no longer RECEIVED; skipping (status=${txn.status})`)
      return { skipped: true, status: txn.status }
    }

    console.log(`[status-poll] attempt ${attempt}/${MAX_POLL_ATTEMPTS} for txn=${transactionId} eganow_reference=${txn.eganow_reference}`)

    let result
    try {
      // Use eganow_reference (the Eganow-assigned reference) for status queries,
      // not internal_reference (our internal tracking id).
      const referenceToQuery = txn.eganow_reference || txn.internal_reference
      result = await queryTransactionStatus(tenantId, referenceToQuery)
    } catch (err) {
      if (err instanceof EganowApiError) {
        console.warn(`[status-poll] status query failed for txn=${transactionId} attempt=${attempt}:`, err.message)
        if (attempt < MAX_POLL_ATTEMPTS) {
          await sleep(POLL_DELAY_MS)
          continue
        }
        throw err
      }
      throw err
    }

    console.log('[status-poll] status query result', {
      tenantId,
      merchantId,
      transactionId,
      internalReference: txn.internal_reference,
      upstreamStatus: result.status,
      reference: result.reference,
      transactionId: result.transactionId,
      raw: result.raw
    })

    const status = result.status ? String(result.status).toLowerCase() : null

    if (!status || PENDING_STATUSES.has(status)) {
      if (attempt < MAX_POLL_ATTEMPTS) {
        await sleep(POLL_DELAY_MS)
        continue
      }

      console.log(`[status-poll] transaction ${transactionId} still pending after ${MAX_POLL_ATTEMPTS} attempts`)
      return { pending: true }
    }

    await updateCollectionTransactionFields(transactionId, {
      reference: result.reference,
      transactionId: result.transactionId
    })

    if (FAILURE_STATUSES.has(status)) {
      const message = `Reconciled as failed from Eganow status query (${result.status}).`
      await markCollectionFailed(transactionId, message)
      console.log(`[status-poll] transaction ${transactionId} marked FAILED`)
      return { status: 'FAILED' }
    }

    if (SUCCESS_STATUSES.has(status)) {
      // Update the transaction to reflect final status from Eganow
      await query(
        `UPDATE transactions
         SET status = 'PAID_OUT', completed_at = now(), updated_at = now()
         WHERE id = $1`,
        [transactionId]
      )

      console.log(`[status-poll] transaction ${transactionId} marked PAID_OUT`) 

      if (txn.payout_mode === 'AUTO_SWEEP') {
        await enqueueCollectForMeJob({ tenantId, merchantId, transactionId })
        console.log(`[status-poll] queued collect-for-me job for txn=${transactionId}`)
      } else {
        await sendMerchantSms(tenantId, txn.mobile_money_number, `Payment of GHS ${Number(txn.amount).toFixed(2)} received. Ref: ${txn.internal_reference}.`)
        console.log(`[status-poll] notified merchant ${txn.mobile_money_number} for txn=${transactionId}`)
      }

      return { status: 'PAID_OUT', queuedAutoSweep: txn.payout_mode === 'AUTO_SWEEP' }
    }

    // Unexpected terminal status; keep polling just in case.
    if (attempt < MAX_POLL_ATTEMPTS) {
      await sleep(POLL_DELAY_MS)
      continue
    }

    console.log(`[status-poll] transaction ${transactionId} returned unexpected status=${result.status}; giving up`)
    return { status: result.status }
  }
}

export const collectionStatusPollWorker = new Worker(
  COLLECTION_STATUS_POLL_QUEUE,
  async (job) => {
    try {
      return await processCollectionStatusPollJob(job)
    } catch (err) {
      console.error(`[status-poll] job ${job.id} failed (tenant=${job.data?.tenantId}, merchant=${job.data?.merchantId}):`, err.message)
      throw err
    }
  },
  {
    connection: getRedisConnection(),
    concurrency: WORKER_CONCURRENCY
  }
)

collectionStatusPollWorker.on('failed', (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    console.error(`[status-poll] job ${job.id} permanently failed after ${job.attemptsMade} attempts (tenant=${job.data?.tenantId}).`,
      err.message)
  }
})

collectionStatusPollWorker.on('error', (err) => {
  console.error('[status-poll] worker-level error (connection/infra, not job-specific):', err)
})

console.log(`[status-poll] worker started, concurrency=${WORKER_CONCURRENCY}`)

process.on('unhandledRejection', (reason) => {
  console.error('[status-poll] unhandledRejection', reason)
})

process.on('uncaughtException', (err) => {
  console.error('[status-poll] uncaughtException', err)
})

process.on('SIGTERM', async () => {
  console.log('[status-poll] SIGTERM received, closing worker gracefully…')
  await collectionStatusPollWorker.close()
  process.exit(0)
})
