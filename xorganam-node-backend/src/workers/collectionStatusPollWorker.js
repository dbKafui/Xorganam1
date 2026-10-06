import { Worker } from 'bullmq'
import { getRedisConnection, COLLECTION_STATUS_POLL_QUEUE, enqueueCollectForMeJob } from '../queue/queue.js'
import { query, withTransaction } from '../db/pool.js'
import { queryTransactionStatus, EganowApiError, isGatewayPending, isGatewaySuccess, isGatewayFailure } from '../services/eganowClient.js'
import { sendMerchantSms } from '../services/notificationService.js'
import { refreshSplitParentStatus, recordPeriodicAccrualAndVendorLeg } from '../services/splitPaymentService.js'
import { markCreditInstallmentCollected } from '../services/creditInstallmentSettlement.js'
import { markStorefrontOrderPaid } from '../services/storefrontOrderService.js'

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
  await query(
    `UPDATE institution_transactions SET status = 'FAILED', updated_at = now()
      WHERE counterparty_transaction_id = $1`, [transactionId]
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
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE transactions SET status = 'SWEPT_INTERNAL', payment_gateway_status = $2,
              completed_at = now(), updated_at = now() WHERE id = $1`, [txn.id, gatewayStatus]
    )
    if (txn.parent_transaction_id) {
      await client.query(
        `UPDATE transactions SET status = 'SWEPT_INTERNAL', updated_at = now()
          WHERE id = $1 AND status IN ('RECEIVED', 'PENDING')`, [txn.parent_transaction_id]
      )
      await markCreditInstallmentCollected(client, txn.parent_transaction_id)
      const { rows: contexts } = await client.query(
        `SELECT c.id, c.tenant_id, c.merchant_id, c.amount, c.base_amount, c.currency, c.internal_reference,
                c.payout_msisdn, c.fee_charged_amount, c.fee_charged_payer,
                m.mobile_money_number, r.id AS rule_id, r.mode, r.type, r.amount AS rule_amount,
                r.institution_id, i.settlement_msisdn, i.settlement_account_name,
                COALESCE(smc.vendor_payout_mode, 'PERIODIC') AS vendor_payout_mode
           FROM transactions c
           JOIN merchants m ON m.id = c.merchant_id AND m.tenant_id = c.tenant_id
           LEFT JOIN LATERAL (
             SELECT sr.* FROM split_rules sr
              WHERE sr.tenant_id = c.tenant_id AND sr.active AND sr.effective_from <= now()
                AND (sr.effective_to IS NULL OR sr.effective_to > now())
                AND ((sr.scope_level = 'MERCHANT_OVERRIDE' AND sr.merchant_id = c.merchant_id)
                  OR (sr.scope_level = 'TENANT_DEFAULT' AND sr.merchant_id IS NULL))
                AND EXISTS (SELECT 1 FROM tenant_institution_links l WHERE l.tenant_id = sr.tenant_id
                  AND l.institution_id = sr.institution_id AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED')
              ORDER BY CASE WHEN sr.merchant_id = c.merchant_id THEN 0 ELSE 1 END, sr.created_at DESC LIMIT 1
           ) r ON TRUE
           LEFT JOIN institutions i ON i.id = r.institution_id
           LEFT JOIN tenant_merchant_settlement_config smc ON smc.tenant_id = c.tenant_id
             AND smc.merchant_id = c.merchant_id AND smc.institution_id = r.institution_id
          WHERE c.id = $1`, [txn.parent_transaction_id]
      )
      const context = contexts[0]
      if (context?.mode === 'PERIODIC' && context.vendor_payout_mode === 'PER_TRANSACTION') {
        await recordPeriodicAccrualAndVendorLeg(client, {
          collectionTxn: context,
          merchant: { mobile_money_number: context.mobile_money_number },
          rule: {
            id: context.rule_id, mode: context.mode, type: context.type, amount: context.rule_amount,
            institution_id: context.institution_id, settlement_msisdn: context.settlement_msisdn,
            settlement_account_name: context.settlement_account_name
          }
        })
      }
    }
  })
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
  await query(
    `UPDATE institution_transactions SET status = 'RECEIVED', eganow_reference = COALESCE($2, eganow_reference), updated_at = now()
      WHERE counterparty_transaction_id = $1`, [txn.id, txn.eganow_reference || null]
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
      result = await queryTransactionStatus(tenantId, referenceToQuery)
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
            `UPDATE transactions SET payout_retry_count = payout_retry_count + 1, updated_at = now()
              WHERE id = $1 RETURNING payout_retry_count`, [transactionId]
          )
          const rootCollectionId = await findRootCollectionId(transactionId)
          const retryCount = Number(retryRows[0]?.payout_retry_count || 0)
          if (rootCollectionId && retryCount < 5) {
            await enqueueCollectForMeJob({ tenantId, merchantId, transactionId: rootCollectionId, retryToken: `split-retry-${txn.id}-${retryCount}` })
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
        await tx.query(
          `UPDATE transactions
           SET status = 'RECEIVED', payment_gateway_status = $2,
               completed_at = now(), updated_at = now()
           WHERE id = $1`, [transactionId, result.status]
        )
        await markStorefrontOrderPaid(tx, transactionId)
      })

      if (txn.payout_mode === 'AUTO_SWEEP') {
        await enqueueCollectForMeJob({ tenantId, merchantId, transactionId })
      } else {
        await sendMerchantSms(tenantId, txn.mobile_money_number, `Payment of GHS ${Number(txn.amount).toFixed(2)} received. Ref: ${txn.internal_reference}.`)
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
