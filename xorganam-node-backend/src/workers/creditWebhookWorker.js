import { Queue, Worker } from 'bullmq'
import { getRedisConnection, CREDIT_WEBHOOK_QUEUE, enqueueCreditWebhookDelivery } from '../queue/queue.js'
import { query } from '../db/pool.js'
import { deliverMerchantWebhook } from '../services/outboundWebhookService.js'
import { recordOperationalFailure } from '../services/operationalFailureService.js'

const connection = getRedisConnection()
const dispatcherQueue = new Queue(CREDIT_WEBHOOK_QUEUE, { connection })

async function dispatchPendingWebhookEvents() {
  const { rows } = await query(
    `SELECT id FROM credit_webhook_outbox WHERE delivered_at IS NULL
      ORDER BY created_at LIMIT 100`
  )
  for (const row of rows) await enqueueCreditWebhookDelivery(row.id)
  return { queued: rows.length }
}

dispatcherQueue.add('dispatch-pending-webhooks', {}, {
  repeat: { every: 30_000 },
  jobId: 'credit-webhook-outbox-dispatcher'
}).catch((error) => console.error('[credit-webhook] dispatcher scheduling failed', { code: error?.code || 'WORKER_ERROR' }))

export const creditWebhookWorker = new Worker(CREDIT_WEBHOOK_QUEUE, async (job) => {
  if (job.name === 'dispatch-pending-webhooks') return dispatchPendingWebhookEvents()
  const { eventId } = job.data || {}
  if (!eventId) throw new Error('Credit webhook job is missing eventId.')
  const { rows } = await query(
    `SELECT e.id, e.tenant_id, e.merchant_id, e.event_type, e.payload, c.url, c.secret_reference
       FROM credit_webhook_outbox e
       LEFT JOIN merchant_webhook_config c
         ON c.tenant_id = e.tenant_id AND c.merchant_id = e.merchant_id AND c.active
      WHERE e.id = $1 AND e.delivered_at IS NULL`, [eventId]
  )
  const event = rows[0]
  if (!event) return { skipped: true }
  if (!event.url || !event.secret_reference) {
    await query(`UPDATE credit_webhook_outbox SET delivered_at = now(), last_error = NULL WHERE id = $1`, [event.id])
    return { skipped: true, reason: 'no-active-webhook' }
  }
  try {
    await deliverMerchantWebhook({ config: event, eventType: event.event_type, eventId: event.id, payload: event.payload })
    await query(`UPDATE credit_webhook_outbox SET delivered_at = now(), last_error = NULL WHERE id = $1`, [event.id])
    return { delivered: true }
  } catch (error) {
    await query(`UPDATE credit_webhook_outbox SET last_error = $2 WHERE id = $1`, [event.id, String(error.message).slice(0, 2000)])
    throw error
  }
}, { connection, concurrency: 5 })

creditWebhookWorker.on('failed', (job, error) => {
  console.error('[credit-webhook] delivery job failed', { code: error?.code || 'WORKER_ERROR' })
  recordOperationalFailure({ queueName: CREDIT_WEBHOOK_QUEUE, job, error })
    .catch((persistError) => console.error('[credit-webhook] failure alert persistence failed', { code: persistError?.code || 'DB_ERROR' }))
})
creditWebhookWorker.on('error', (error) => console.error('[credit-webhook] worker error', { code: error?.code || 'WORKER_ERROR' }))
