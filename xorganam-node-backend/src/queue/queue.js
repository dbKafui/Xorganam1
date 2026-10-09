import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '../config/env.js'
import { filterQueueFailuresByTenant } from '../services/operationalHealthService.js'
import { replayCreditWebhookJob } from '../services/creditWebhookReplay.js'
import { query } from '../db/pool.js'
import { serializeEmailMessageForQueue } from '../email/emailMessagePolicy.js'

// One shared Redis connection, one shared queue, used by every tenant.
// Tenant isolation for job PROCESSING happens at the job-data level
// (each job carries tenantId + merchantId and looks up that tenant's own
// credentials at execution time) and at the error-boundary level in the
// worker - not by having a queue per tenant, which wouldn't scale past a
// handful of tenants.
let connection = null
let collectForMeQueue = null
let collectionStatusPollQueue = null
let periodicSettlementQueue = null
let creditWebhookQueue = null
let creditReminderQueue = null
let creditCashSweepQueue = null
let institutionLoanRecoveryQueue = null
let emailDeliveryQueue = null
let connectError = null

function createRedisConnection() {
  if (connection) {
    return connection
  }

  connection = new IORedis(env.redis.url, {
    lazyConnect: true,
    maxRetriesPerRequest: null, // required by BullMQ's blocking connections
    retryStrategy: () => null // fail fast instead of retrying
  })

  connection.on('error', (err) => {
    connectError = err
    console.error('[queue] Redis connection failed', { code: err?.code || 'CONNECTION_ERROR' })
  })

  connection.on('connect', () => {
    connectError = null
    console.log('[queue] Redis connection established')
  })

  return connection
}

export function getRedisConnection() {
  return createRedisConnection()
}

export const COLLECT_FOR_ME_QUEUE = 'collect-for-me'
export const COLLECTION_STATUS_POLL_QUEUE = 'collection-status-poll'
export const PERIODIC_SETTLEMENT_QUEUE = 'periodic-settlement'
export const CREDIT_WEBHOOK_QUEUE = 'credit-webhook-delivery'
export const CREDIT_REMINDER_QUEUE = 'credit-installment-reminders'
export const CREDIT_CASH_SWEEP_QUEUE = 'credit-cash-installment-sweeps'
export const INSTITUTION_LOAN_RECOVERY_QUEUE = 'institution-loan-recovery'
export const TENANT_EMAIL_DELIVERY_QUEUE = 'tenant-email-delivery'

export function getRedisHealth() {
  return {
    available: !connectError,
    error: connectError?.message || null
  }
}

export async function getQueueHealth() {
  const queues = [
    COLLECT_FOR_ME_QUEUE,
    COLLECTION_STATUS_POLL_QUEUE,
    PERIODIC_SETTLEMENT_QUEUE,
    CREDIT_WEBHOOK_QUEUE,
    CREDIT_REMINDER_QUEUE,
    CREDIT_CASH_SWEEP_QUEUE,
    INSTITUTION_LOAN_RECOVERY_QUEUE,
    TENANT_EMAIL_DELIVERY_QUEUE
  ]

  const entries = {}
  for (const name of queues) {
    try {
      const queue = new Queue(name, { connection: getRedisConnection() })
      entries[name] = await queue.getJobCounts('waiting', 'delayed', 'active', 'failed', 'completed')
      await queue.close()
    } catch (error) {
      entries[name] = { waiting: 0, delayed: 0, active: 0, failed: 0, completed: 0, error: error?.message || 'queue unavailable' }
    }
  }
  return entries
}

export async function getFailedQueueJobs(limit = 20, tenantId = null) {
  const queues = [
    COLLECT_FOR_ME_QUEUE,
    COLLECTION_STATUS_POLL_QUEUE,
    PERIODIC_SETTLEMENT_QUEUE,
    CREDIT_WEBHOOK_QUEUE,
    CREDIT_REMINDER_QUEUE,
    CREDIT_CASH_SWEEP_QUEUE,
    INSTITUTION_LOAN_RECOVERY_QUEUE,
    TENANT_EMAIL_DELIVERY_QUEUE
  ]

  const failures = []
  for (const name of queues) {
    try {
      const queue = new Queue(name, { connection: getRedisConnection() })
      const jobs = await queue.getFailed(0, limit)
      for (const job of jobs) {
        const data = job?.data || {}
        failures.push({
          queue: name,
          id: String(job.id),
          name: String(job.name || ''),
          failedReason: String(job.failedReason || 'Unknown failure'),
          attemptsMade: Number(job.attemptsMade || 0),
          finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          tenantId: data.tenantId || null,
          merchantId: data.merchantId || null,
          transactionId: data.transactionId || null
        })
      }
      await queue.close()
    } catch {
      // Failures are reported by the health summary when the queue is unavailable.
    }
  }
  const scopedFailures = filterQueueFailuresByTenant(failures, tenantId)
  return scopedFailures.sort((a, b) => new Date(b.finishedAt || 0) - new Date(a.finishedAt || 0)).slice(0, limit)
}

function makeSafeJobId(prefix, id) {
  const cleanId = String(id || '').replace(/:/g, '-').replace(/\s+/g, '_')
  return `${prefix}-${cleanId}`
}

function getCollectForMeQueue() {
  if (collectForMeQueue) {
    return collectForMeQueue
  }

  try {
    const conn = getRedisConnection()
    collectForMeQueue = new Queue(COLLECT_FOR_ME_QUEUE, { connection: conn })
  } catch {
    console.warn('[queue] collection queue unavailable')
  }

  return collectForMeQueue
}

function getCollectionStatusPollQueue() {
  if (collectionStatusPollQueue) {
    return collectionStatusPollQueue
  }

  try {
    const conn = getRedisConnection()
    collectionStatusPollQueue = new Queue(COLLECTION_STATUS_POLL_QUEUE, { connection: conn })
  } catch {
    console.warn('[queue] status polling queue unavailable')
  }

  return collectionStatusPollQueue
}

export { getCollectForMeQueue, getCollectionStatusPollQueue }

/**
 * @param {{ tenantId: string, merchantId: string, transactionId: string }} jobData
 */
export async function enqueueCollectForMeJob(jobData) {
  const queue = getCollectForMeQueue()
  if (!queue) {
    console.warn('[queue] collection queue unavailable; work was not queued')
    return null
  }

  try {
    return await queue.add('process-collection', jobData, {
      // Idempotent: a redelivered webhook for the same transaction won't
      // queue a duplicate sweep+payout job. Use a sanitized jobId
      // (BullMQ forbids certain characters such as ':').
      jobId: makeSafeJobId('collect-for-me', jobData.retryToken ? `${jobData.transactionId}-${jobData.retryToken}` : jobData.transactionId),
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 60 * 60 * 24 * 7 }, // keep 7 days for audit
      removeOnFail: { age: 60 * 60 * 24 * 30 } // keep failures 30 days
    })
  } catch {
    console.warn('[queue] collection queue failed to enqueue work')
    return null
  }
}
export async function enqueueCollectionStatusPollJob(jobData) {
  const queue = getCollectionStatusPollQueue()
  if (!queue) {
    console.warn('[queue] status polling queue unavailable; work was not queued')
    return null
  }

  try {
    return await queue.add('poll-collection-status', jobData, {
      // Use sanitized jobId to avoid characters rejected by BullMQ.
      jobId: makeSafeJobId('status-poll', jobData.transactionId),
      attempts: 3,
      backoff: { type: 'fixed', delay: 2000 },
      removeOnComplete: { age: 60 * 60 * 24 * 7 },
      removeOnFail: { age: 60 * 60 * 24 * 30 }
    })
  } catch {
    console.warn('[queue] status polling queue failed to enqueue work')
    return null
  }
}

export async function enqueuePeriodicSettlementJob(jobData = {}) {
  if (!periodicSettlementQueue) {
    periodicSettlementQueue = new Queue(PERIODIC_SETTLEMENT_QUEUE, { connection: getRedisConnection() })
  }
  return periodicSettlementQueue.add('run-due-sweeps', jobData, {
    jobId: `periodic-settlement-${jobData.tenantId || 'all'}-${Date.now()}`,
    attempts: 20,
    backoff: { type: 'fixed', delay: 30_000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60 },
    removeOnFail: { age: 30 * 24 * 60 * 60 }
  })
}

export function getCreditWebhookQueue() {
  if (!creditWebhookQueue) creditWebhookQueue = new Queue(CREDIT_WEBHOOK_QUEUE, { connection: getRedisConnection() })
  return creditWebhookQueue
}

export function getTenantEmailDeliveryQueue() {
  if (!emailDeliveryQueue) emailDeliveryQueue = new Queue(TENANT_EMAIL_DELIVERY_QUEUE, { connection: getRedisConnection() })
  return emailDeliveryQueue
}

export async function enqueueTenantEmail({ tenantId, message }) {
  const { emailDeliveryPolicy } = await import('../config/emailDelivery.js')
  const queue = getTenantEmailDeliveryQueue()
  const { rows } = await query(
    `INSERT INTO email_delivery_records (tenant_id, status, recipient_count)
     VALUES ($1, 'PENDING', $2)
     RETURNING id`,
    [tenantId, emailRecipientCount(message)]
  )
  const deliveryId = rows[0].id
  try {
    await queue.add('send-tenant-email', { tenantId, message: serializeEmailMessageForQueue(message), deliveryId }, {
      jobId: `tenant-email-${deliveryId}`,
      attempts: emailDeliveryPolicy.retryAttempts,
      backoff: { type: 'exponential', delay: emailDeliveryPolicy.retryBackoffMs },
      removeOnComplete: { age: emailDeliveryPolicy.deliveryRecordRetentionDays * 24 * 60 * 60 },
      removeOnFail: { age: emailDeliveryPolicy.deliveryRecordRetentionDays * 24 * 60 * 60 }
    })
  } catch (error) {
    await query(
      `UPDATE email_delivery_records SET status = 'FAILED', error_code = 'QUEUE_UNAVAILABLE', completed_at = now()
        WHERE id = $1`,
      [deliveryId]
    )
    throw error
  }
  return { deliveryId, status: 'QUEUED' }
}

function emailRecipientCount(message) {
  const values = [message?.to, message?.cc, message?.bcc].flatMap((value) => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value])
  return values.length
}

export async function enqueueCreditWebhookDelivery(eventId) {
  const queue = getCreditWebhookQueue()
  return queue.add('deliver-credit-webhook', { eventId }, {
    jobId: `credit-webhook-${String(eventId).replace(/:/g, '-')}`,
    attempts: 10,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60 },
    removeOnFail: { age: 30 * 24 * 60 * 60 }
  })
}

export async function replayCreditWebhookDelivery(eventId) {
  return replayCreditWebhookJob(getCreditWebhookQueue(), eventId)
}

export function getCreditReminderQueue() {
  if (!creditReminderQueue) creditReminderQueue = new Queue(CREDIT_REMINDER_QUEUE, { connection: getRedisConnection() })
  return creditReminderQueue
}

export async function enqueueCreditReminder(job) {
  const queue = getCreditReminderQueue()
  const jobId = job.type === 'OVERDUE'
    ? `credit-overdue-${job.installmentId}`
    : `credit-reminder-${job.installmentId}-${job.type}-${job.reminderDate}`
  return queue.add(job.type === 'OVERDUE' ? 'mark-installment-overdue' : 'send-installment-reminder', job, {
    jobId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60 },
    removeOnFail: { age: 30 * 24 * 60 * 60 }
  })
}

export function getCreditCashSweepQueue() {
  if (!creditCashSweepQueue) creditCashSweepQueue = new Queue(CREDIT_CASH_SWEEP_QUEUE, { connection: getRedisConnection() })
  return creditCashSweepQueue
}

export function getInstitutionLoanRecoveryQueue() {
  if (!institutionLoanRecoveryQueue) institutionLoanRecoveryQueue = new Queue(INSTITUTION_LOAN_RECOVERY_QUEUE, { connection: getRedisConnection() })
  return institutionLoanRecoveryQueue
}
