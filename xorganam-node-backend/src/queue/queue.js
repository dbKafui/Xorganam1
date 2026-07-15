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
    console.warn('[queue] Redis error:', err.message)
  })

  connection.on('connect', () => {
    connectError = null
  })

  return connection
}

export function getRedisConnection() {
  return createRedisConnection()
}

export const COLLECT_FOR_ME_QUEUE = 'collect-for-me'
export const COLLECTION_STATUS_POLL_QUEUE = 'collection-status-poll'

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
  } catch (err) {
    console.warn('[queue] Failed to initialize queue:', err.message)
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
  } catch (err) {
    console.warn('[queue] Failed to initialize status poll queue:', err.message)
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
    console.warn('[queue] collectForMeQueue not available (Redis offline), job will not be queued:', jobData)
    return null
  }

    try {
    return await queue.add('process-collection', jobData, {
      // Idempotent: a redelivered webhook for the same transaction won't
      // queue a duplicate sweep+payout job. Use a sanitized jobId
      // (BullMQ forbids certain characters such as ':').
      jobId: makeSafeJobId('collect-for-me', jobData.transactionId),
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 60 * 60 * 24 * 7 }, // keep 7 days for audit
      removeOnFail: { age: 60 * 60 * 24 * 30 } // keep failures 30 days
    })
  } catch (err) {
    console.warn('[queue] collectForMeQueue not available (Redis offline), job will not be queued:', jobData, err.message)
    return null
  }
}
export async function enqueueCollectionStatusPollJob(jobData) {
  const queue = getCollectionStatusPollQueue()
  if (!queue) {
    console.warn('[queue] status poll queue not available (Redis offline), job will not be queued:', jobData)
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
  } catch (err) {
    console.warn('[queue] status poll queue add failed:', jobData, err.message)
    return null
  }
}