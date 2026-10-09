import { Worker } from 'bullmq'
import { getRedisConnection, COLLECTION_STATUS_POLL_QUEUE, enqueueCollectForMeJob } from '../queue/queue.js'
import { query, withTransaction } from '../db/pool.js'
import { queryTransactionStatus, EganowApiError, isGatewayPending, isGatewaySuccess, isGatewayFailure } from '../services/eganowClient.js'
import { notifyMerchant } from '../services/notificationService.js'
import { refreshSplitParentStatus } from '../services/splitPaymentService.js'
import { markCreditInstallmentCollected } from '../services/creditInstallmentSettlement.js'
import { markStorefrontOrderPaid } from '../services/storefrontOrderService.js'
import { MAX_SPLIT_PAYOUT_RETRIES, updateTransactionStatus } from '../services/transactionStateService.js'
import { updateInstitutionTransactionStatus } from '../services/institutionStateService.js'
import { recordOperationalFailure } from '../services/operationalFailureService.js'

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

async function markCollectionFailed(transactionId, reason, gatewayStatus = null, currentStatus = 'PENDING') {
  await updateTransactionStatus(query, {
    id: transactionId,
    type: 'COLLECTION',
    currentStatus,
    nextStatus: 'FAILED',
    fields: {
      payment_gateway_status: gatewayStatus,
      failure_reason: reason,
      completed_at: new Date()
    }
  })
}

async function markGenericFailed(transactionId, reason, gatewayStatus = null, currentStatus = 'PENDING') {
  await withTransaction(async (client) => {
    await updateTransactionStatus(client, {
      id: transactionId,
      type: 'PAYOUT',
      currentStatus,
      nextStatus: 'FAILED',
      fields: {
        payment_gateway_status: gatewayStatus,
        failure_reason: reason,
        completed_at: new Date()
      }
    })
    const { rows } = await client.query(
      `SELECT id, institution_id, status FROM institution_transactions
        WHERE counterparty_transaction_id = $1 FOR UPDATE`, [transactionId]
    )
    for (const row of rows) {
      await updateInstitutionTransactionStatus(client, {
        id: row.id,
        institutionId: row.institution_id,
        currentStatus: row.status,
        nextStatus: 'FAILED',
        fields: {}
      })
    }
  })
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
  await withTransaction(async (client) => {
    await updateTransactionStatus(client, {
      id: txn.id,
      type: 'INTERNAL_TRANSFER',
      currentStatus: txn.status,
      nextStatus: 'SWEPT_INTERNAL',
      fields: { payment_gateway_status: gatewayStatus, completed_at: new Date() }
    })
    if (txn.parent_transaction_id) {
      await updateTransactionStatus(client, {
        id: txn.parent_transaction_id,
        type: 'COLLECTION',
        currentStatus: 'RECEIVED',
        nextStatus: 'SWEPT_INTERNAL',
        fields: {}
      })
      await markCreditInstallmentCollected(client, txn.parent_transaction_id)
    }
  })
}

async function markPayoutSuccessful(txn, gatewayStatus) {
  await withTransaction(async (client) => {
    await updateTransactionStatus(client, {
      id: txn.id,
      type: 'PAYOUT',
      currentStatus: txn.status,
      nextStatus: 'PAID_OUT',
      fields: { payment_gateway_status: gatewayStatus, completed_at: new Date() }
    })
    const { rows } = await client.query(
      `SELECT id, institution_id, status FROM institution_transactions
        WHERE counterparty_transaction_id = $1 FOR UPDATE`, [txn.id]
    )
    for (const row of rows) {
      await updateInstitutionTransactionStatus(client, {
        id: row.id,
        institutionId: row.institution_id,
        currentStatus: row.status,
        nextStatus: 'RECEIVED',
        fields: { eganow_reference: txn.eganow_reference || null }
      })
    }
  })

  const rootCollectionId = await findRootCollectionId(txn.id)
  if (rootCollectionId) {
    if (txn.payout_leg === 'VENDOR' || txn.payout_leg === 'INSTITUTION') {
      await refreshSplitParentStatus(rootCollectionId)
    } else {
      await updateTransactionStatus(query, {
        id: rootCollectionId,
        type: 'COLLECTION',
        currentStatus: 'RECEIVED',
        nextStatus: 'PAID_OUT',
        fields: {}
      })
    }
  }

  if (txn.payout_leg !== 'INSTITUTION') {
    await notifyMerchant(txn.tenant_id, txn.merchant_id, {
      toMsisdn: txn.payout_msisdn || txn.mobile_money_number,
      message: `GHS ${Number(txn.amount).toFixed(2)} has been sent to your Mobile Money account. Ref: ${txn.internal_reference}.`,
      subject: 'Payout completed'
    })
  }
}

async function processCollectionStatusPollJob(job) {
  const { tenantId, merchantId, transactionId } = job.data
  if (!tenantId || !merchantId || !transactionId) {
    throw new Error('Malformed status poll job data.')
  }

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    const txn = await loadTransactionContext(transactionId, tenantId, merchantId)
    if (!txn) {
      return { skipped: true }
    }

    if (txn.status !== 'PENDING') {
      return { skipped: true, status: txn.status }
    }

    let result
    try {
      // Use internal_reference by default for status queries, since the Eganow
      // status API expects the original transactionId we sent in the collection
      // request.
      const referenceToQuery = txn.internal_reference || txn.eganow_reference
      result = await queryTransactionStatus(tenantId, referenceToQuery, { merchantId })
    } catch (err) {
      if (err instanceof EganowApiError) {
        if (attempt < MAX_POLL_ATTEMPTS) {
          await sleep(POLL_DELAY_MS)
          continue
        }
        throw err
      }
      throw err
    }

    if (isGatewayPending(result.status)) {
      if (attempt < MAX_POLL_ATTEMPTS) {
        await sleep(POLL_DELAY_MS)
        continue
      }

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
        if (txn.type === 'PAYOUT' && ['VENDOR', 'INSTITUTION'].includes(txn.payout_leg)) {
          const { rows: retryRows } = await query(
            'SELECT payout_retry_count FROM transactions WHERE id = $1', [transactionId]
          )
          const rootCollectionId = await findRootCollectionId(transactionId)
          const retryCount = Number(retryRows[0]?.payout_retry_count || 0)
          if (rootCollectionId && retryCount < MAX_SPLIT_PAYOUT_RETRIES) {
            await enqueueCollectForMeJob({ tenantId, merchantId, transactionId: rootCollectionId, retryToken: `split-retry-${txn.id}-${retryCount + 1}` })
          } else if (rootCollectionId) {
            await refreshSplitParentStatus(rootCollectionId, true)
          }
        }
      }
      return { status: 'FAILED' }
    }

    if (isGatewaySuccess(result.status)) {
      if (txn.type === 'INTERNAL_TRANSFER') {
        await markInternalTransferSuccessful(txn, result.status)
        const rootCollectionId = await findRootCollectionId(txn.id)
        if (rootCollectionId) {
          await enqueueCollectForMeJob({ tenantId, merchantId, transactionId: rootCollectionId })
        }
        return { status: 'SWEPT_INTERNAL' }
      }

      if (txn.type === 'PAYOUT') {
        await markPayoutSuccessful(txn, result.status)
        return { status: 'PAID_OUT' }
      }

      // Gateway success confirms the collection. The payout lifecycle is
      // tracked separately as SWEPT_INTERNAL / PAID_OUT.
      await withTransaction(async (tx) => {
        await updateTransactionStatus(tx, {
          id: transactionId,
          type: 'COLLECTION',
          currentStatus: 'PENDING',
          nextStatus: 'RECEIVED',
          fields: {
            payment_gateway_status: result.status,
            completed_at: new Date()
          }
        })
        await markStorefrontOrderPaid(tx, transactionId)
      })

      if (txn.payout_mode === 'AUTO_SWEEP') {
        await enqueueCollectForMeJob({ tenantId, merchantId, transactionId })
      } else {
        await notifyMerchant(tenantId, merchantId, {
          toMsisdn: txn.mobile_money_number,
          message: `Payment of GHS ${Number(txn.amount).toFixed(2)} received. Ref: ${txn.internal_reference}.`,
          subject: 'Payment received'
        })
      }

      return { status: 'RECEIVED', queuedAutoSweep: txn.payout_mode === 'AUTO_SWEEP' }
    }

    // Unexpected terminal status; keep polling just in case.
    if (attempt < MAX_POLL_ATTEMPTS) {
      await sleep(POLL_DELAY_MS)
      continue
    }

    return { status: result.status }
  }
}

export const collectionStatusPollWorker = new Worker(
  COLLECTION_STATUS_POLL_QUEUE,
  async (job) => {
    try {
      return await processCollectionStatusPollJob(job)
    } catch (err) {
      console.error('[status-poll] job failed', { code: err?.code || 'WORKER_ERROR' })
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
    console.error('[status-poll] job exhausted retries', { attempts: job.attemptsMade, code: err?.code || 'WORKER_ERROR' })
    recordOperationalFailure({ queueName: COLLECTION_STATUS_POLL_QUEUE, job, error: err })
      .catch((error) => console.error('[status-poll] failure alert persistence failed', { code: error?.code || 'DB_ERROR' }))
  }
})

collectionStatusPollWorker.on('error', (err) => {
  console.error('[status-poll] worker connection error', { code: err?.code || 'WORKER_ERROR' })
})

console.log(`[status-poll] worker started, concurrency=${WORKER_CONCURRENCY}`)

process.on('unhandledRejection', (reason) => {
  console.error('[status-poll] unhandled rejection', { name: reason?.name || typeof reason, code: reason?.code || 'UNEXPECTED' })
})

process.on('uncaughtException', (err) => {
  console.error('[status-poll] uncaught exception', { name: err?.name || 'Error', code: err?.code || 'UNEXPECTED' })
})

process.on('SIGTERM', async () => {
  console.log('[status-poll] SIGTERM received, closing worker gracefully…')
  await collectionStatusPollWorker.close()
  process.exit(0)
})
