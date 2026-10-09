import { Worker } from 'bullmq'
import { getRedisConnection, TENANT_EMAIL_DELIVERY_QUEUE } from '../queue/queue.js'
import { query } from '../db/pool.js'
import { emailDeliveryPolicy } from '../config/emailDelivery.js'
import { getMailSender } from '../email/mailSenderService.js'
import { classifyProviderFailure, deserializeEmailMessageFromQueue, resolveEmailJobFailure } from '../email/emailMessagePolicy.js'

function safeErrorCode(result) {
  const match = /HTTP (\d{3})/.exec(result.error || '')
  return match ? `HTTP_${match[1]}` : result.transient ? 'TEMPORARY_PROVIDER_FAILURE' : 'PERMANENT_PROVIDER_FAILURE'
}

async function updateDelivery(deliveryId, { status, providerMessageId = null, errorCode = null, attemptCount, completed = false }) {
  await query(
    `UPDATE email_delivery_records
        SET status = $2, provider_message_id = $3, error_code = $4,
            attempt_count = $5, completed_at = CASE WHEN $6 THEN now() ELSE NULL END
      WHERE id = $1`,
    [deliveryId, status, providerMessageId, errorCode, attemptCount, completed]
  )
}

async function deliverTenantEmail(job) {
  const { tenantId, message, deliveryId } = job.data || {}
  if (!deliveryId) return { delivered: false, permanentFailure: true }
  const { rows } = await query(
    'SELECT tenant_id, status FROM email_delivery_records WHERE id = $1',
    [deliveryId]
  )
  const record = rows[0]
  if (!record || !tenantId || String(record.tenant_id) !== String(tenantId)) {
    return { delivered: false, skipped: true }
  }
  if (!['PENDING', 'RETRYING'].includes(record.status)) return { delivered: false, skipped: true }
  if (!message) {
    await updateDelivery(deliveryId, {
      status: 'FAILED',
      errorCode: 'MALFORMED_JOB',
      attemptCount: Number(job.attemptsMade || 0),
      completed: true
    })
    return { delivered: false, permanentFailure: true }
  }
  const attemptCount = Number(job.attemptsMade || 0) + 1
  const maxAttempts = Number(job.opts?.attempts || emailDeliveryPolicy.retryAttempts)
  let result
  try {
    const sender = await getMailSender(tenantId)
    result = await sender.send(deserializeEmailMessageFromQueue(message), { signal: AbortSignal.timeout(emailDeliveryPolicy.sendTimeoutMs) })
  } catch (error) {
    result = classifyProviderFailure(error)
  }

  if (result.ok) {
    await updateDelivery(deliveryId, {
      status: 'DELIVERED',
      providerMessageId: result.providerMessageId || null,
      attemptCount,
      completed: true
    })
    return { delivered: true }
  }

  const willRetry = result.transient && attemptCount < maxAttempts
  await updateDelivery(deliveryId, {
    status: willRetry ? 'RETRYING' : 'FAILED',
    errorCode: safeErrorCode(result),
    attemptCount,
    completed: !willRetry
  })
  if (willRetry) throw new Error(result.error || 'Email provider is temporarily unavailable.')
  return { delivered: false, permanentFailure: true }
}

export const tenantEmailDeliveryWorker = new Worker(
  TENANT_EMAIL_DELIVERY_QUEUE,
  deliverTenantEmail,
  { connection: getRedisConnection(), concurrency: emailDeliveryPolicy.workerConcurrency }
)

tenantEmailDeliveryWorker.on('failed', async (job, error) => {
  if (!job?.data?.deliveryId) return
  const attemptCount = Number(job.attemptsMade || 0)
  const failure = resolveEmailJobFailure(attemptCount, Number(job.opts?.attempts || emailDeliveryPolicy.retryAttempts))
  try {
    await updateDelivery(job.data.deliveryId, {
      status: failure.status,
      errorCode: failure.completed ? 'RETRY_BUDGET_EXHAUSTED' : 'TEMPORARY_PROVIDER_FAILURE',
      attemptCount,
      completed: failure.completed
    })
  } catch (persistError) {
    console.error('[tenant-email] failure record update failed', { code: persistError?.code || 'DB_ERROR' })
  }
  console.error('[tenant-email] job failed', { deliveryId: job.data.deliveryId, code: error?.code || 'EMAIL_DELIVERY_FAILED' })
})

tenantEmailDeliveryWorker.on('error', (error) => {
  console.error('[tenant-email] worker error', { code: error?.code || 'WORKER_ERROR' })
})