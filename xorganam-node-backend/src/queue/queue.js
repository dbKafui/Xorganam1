import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '../config/env.js'

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

export function getRedisHealth() {
  return {
    available: !connectError,
    error: connectError?.message || null
  }
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
