import { Worker } from 'bullmq'
import { getRedisConnection, COLLECTION_STATUS_POLL_QUEUE, enqueueCollectForMeJob } from '../queue/queue.js'
import { query } from '../db/pool.js'
import { queryTransactionStatus, EganowApiError, isGatewayPending, isGatewaySuccess, isGatewayFailure } from '../services/eganowClient.js'
import { sendMerchantSms } from '../services/notificationService.js'
import { refreshSplitParentStatus } from '../services/splitPaymentService.js'

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10)
const POLL_DELAY_MS = parseInt(process.env.COLLECTION_STATUS_POLL_DELAY_MS || '5000', 10)
const MAX_POLL_ATTEMPTS = parseInt(process.env.COLLECTION_STATUS_POLL_ATTEMPTS || '12', 10)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function loadTransactionContext(transactionId, tenantId, merchantId) {
  const { rows } = await query(
    `SELECT t.id, t.tenant_id, t.merchant_id, t.parent_transaction_id, t.type, t.payout_leg, t.status, t.amount, t.currency, t.internal_reference,
            t.eganow_reference, t.eganow_transaction_id, t.payout_msisdn,
            m.payout_mode, m.mobile_money_number
       FROM transactions t
       JOIN merchants m ON m.id = t.merchant_id
      WHERE t.id = $1 AND t.tenant_id = $2 AND t.merchant_id = $3`,
    [transactionId, tenantId, merchantId]
  )
  return rows[0] || null
}

async function updateCollectionTransactionFields(transactionId, { reference, transactionId: upstreamTxnId, gatewayStatus }) {
  await query(
    `UPDATE transactions
        SET eganow_reference = COALESCE($2, eganow_reference),
            eganow_transaction_id = COALESCE($3, eganow_transaction_id),
            payment_gateway_status = COALESCE($4, payment_gateway_status),
            updated_at = now()
      WHERE id = $1`,
    [transactionId, reference || null, upstreamTxnId || null, gatewayStatus || null]
  )
}

async function markCollectionFailed(transactionId, reason, gatewayStatus = null) {
  await query(
    `UPDATE transactions
        SET status = 'FAILED',
            payment_gateway_status = COALESCE($3, payment_gateway_status),
            failure_reason = $2,
            updated_at = now(),
            completed_at = now()
      WHERE id = $1`,
    [transactionId, reason, gatewayStatus]
  )
}

async function markGenericFailed(transactionId, reason, gatewayStatus = null) {
  await query(
    `UPDATE transactions
        SET status = 'FAILED',
            payment_gateway_status = COALESCE($3, payment_gateway_status),
            failure_reason = $2,
            updated_at = now(),
            completed_at = now()
      WHERE id = $1`,
    [transactionId, reason, gatewayStatus]
  )
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

async function markInternalTransferSuccessful(txn, gatewayStatus) {
  await query(
    `UPDATE transactions
        SET status = 'SWEPT_INTERNAL',
            payment_gateway_status = $2,
            completed_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [txn.id, gatewayStatus]
  )

  if (txn.parent_transaction_id) {
    await query(
      `UPDATE transactions
          SET status = 'SWEPT_INTERNAL',
              updated_at = now()
        WHERE id = $1 AND status IN ('RECEIVED', 'PENDING')`,
      [txn.parent_transaction_id]
    )
  }
}

async function markPayoutSuccessful(txn, gatewayStatus) {
  await query(
    `UPDATE transactions
        SET status = 'PAID_OUT',
            payment_gateway_status = $2,
            completed_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [txn.id, gatewayStatus]
  )

  const rootCollectionId = await findRootCollectionId(txn.id)
  if (rootCollectionId) {
    if (txn.payout_leg === 'VENDOR' || txn.payout_leg === 'INSTITUTION') {
      await refreshSplitParentStatus(rootCollectionId)
    } else {
      await query(
        `UPDATE transactions
            SET status = 'PAID_OUT',
                updated_at = now()
          WHERE id = $1`,
        [rootCollectionId]
      )
    }
  }

  if (txn.payout_leg !== 'INSTITUTION') {
    await sendMerchantSms(
      txn.tenant_id,
      txn.payout_msisdn || txn.mobile_money_number,
      `GHS ${Number(txn.amount).toFixed(2)} has been sent to your Mobile Money account. Ref: ${txn.internal_reference}.`
    )
  }
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

    if (txn.status !== 'PENDING') {
      console.log(`[status-poll] transaction ${transactionId} no longer PENDING; skipping (status=${txn.status})`)
      return { skipped: true, status: txn.status }
    }

    console.log(`[status-poll] attempt ${attempt}/${MAX_POLL_ATTEMPTS} for txn=${transactionId} internal_reference=${txn.internal_reference} eganow_reference=${txn.eganow_reference}`)

    let result
    try {
      // Use internal_reference by default for status queries, since the Eganow
      // status API expects the original transactionId we sent in the collection
      // request.
      const referenceToQuery = txn.internal_reference || txn.eganow_reference
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
      upstreamTransactionId: result.transactionId,
      raw: result.raw
    })

    if (isGatewayPending(result.status)) {
      if (attempt < MAX_POLL_ATTEMPTS) {
        await sleep(POLL_DELAY_MS)
        continue
      }

      console.log(`[status-poll] transaction ${transactionId} still pending after ${MAX_POLL_ATTEMPTS} attempts`)
      return { pending: true }
    }

    await updateCollectionTransactionFields(transactionId, {
      reference: result.reference,
      transactionId: result.transactionId,
      gatewayStatus: result.status
    })

    if (isGatewayFailure(result.status)) {
      const message = `Reconciled as failed from Eganow status query (${result.status}).`
      if (txn.type === 'COLLECTION') {
        await markCollectionFailed(transactionId, message, result.status)
      } else {
        await markGenericFailed(transactionId, message, result.status)
      }
      console.log(`[status-poll] transaction ${transactionId} marked FAILED`)
      return { status: 'FAILED' }
    }

    if (isGatewaySuccess(result.status)) {
      if (txn.type === 'INTERNAL_TRANSFER') {
        await markInternalTransferSuccessful(txn, result.status)
        console.log(`[status-poll] internal transfer ${transactionId} marked SWEPT_INTERNAL`)
        const rootCollectionId = await findRootCollectionId(txn.id)
        if (rootCollectionId) {
          await enqueueCollectForMeJob({ tenantId, merchantId, transactionId: rootCollectionId })
          console.log(`[status-poll] requeued collect-for-me after internal transfer success for collection=${rootCollectionId}`)
        }
        return { status: 'SWEPT_INTERNAL' }
      }

      if (txn.type === 'PAYOUT') {
        await markPayoutSuccessful(txn, result.status)
        console.log(`[status-poll] payout ${transactionId} marked PAID_OUT`)
        return { status: 'PAID_OUT' }
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
        [transactionId, result.status]
      )

      console.log(`[status-poll] transaction ${transactionId} marked RECEIVED`) 

      if (txn.payout_mode === 'AUTO_SWEEP') {
        await enqueueCollectForMeJob({ tenantId, merchantId, transactionId })
        console.log(`[status-poll] queued collect-for-me job for txn=${transactionId}`)
      } else {
        await sendMerchantSms(tenantId, txn.mobile_money_number, `Payment of GHS ${Number(txn.amount).toFixed(2)} received. Ref: ${txn.internal_reference}.`)
        console.log(`[status-poll] notified merchant ${txn.mobile_money_number} for txn=${transactionId}`)
      }

      return { status: 'RECEIVED', queuedAutoSweep: txn.payout_mode === 'AUTO_SWEEP' }
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
