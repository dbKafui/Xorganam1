import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePaymentRecoveryPolicy } from '../src/config/paymentRecoveryPolicy.js'

test('uses validated defaults and allows payment recovery retry tuning', () => {
  assert.deepEqual(parsePaymentRecoveryPolicy({}), {
    workerConcurrency: 5,
    statusPollDelayMs: 5000,
    statusPollMaxAttempts: 12,
    statusPollQueueAttempts: 3,
    statusPollQueueBackoffMs: 2000,
    collectionQueueAttempts: 5,
    collectionQueueBackoffMs: 2000,
    splitPayoutMaxRetries: 5
  })
  const configured = parsePaymentRecoveryPolicy({
    WORKER_CONCURRENCY: '7', COLLECTION_STATUS_POLL_DELAY_MS: '9000',
    COLLECTION_STATUS_POLL_ATTEMPTS: '16', COLLECTION_STATUS_QUEUE_ATTEMPTS: '4',
    COLLECTION_STATUS_QUEUE_BACKOFF_MS: '3000', COLLECT_FOR_ME_QUEUE_ATTEMPTS: '8',
    COLLECT_FOR_ME_QUEUE_BACKOFF_MS: '2500', SPLIT_PAYOUT_MAX_RETRIES: '6'
  })
  assert.equal(configured.workerConcurrency, 7)
  assert.equal(configured.statusPollDelayMs, 9000)
  assert.equal(configured.statusPollMaxAttempts, 16)
  assert.equal(configured.statusPollQueueAttempts, 4)
  assert.equal(configured.collectionQueueAttempts, 8)
  assert.equal(configured.splitPayoutMaxRetries, 6)
})

test('rejects invalid payment retry, backoff, and concurrency configuration', () => {
  for (const environment of [
    { COLLECTION_STATUS_POLL_ATTEMPTS: '0' },
    { COLLECTION_STATUS_QUEUE_BACKOFF_MS: 'nope' },
    { WORKER_CONCURRENCY: '2.5' },
    { SPLIT_PAYOUT_MAX_RETRIES: '-1' }
  ]) assert.throws(() => parsePaymentRecoveryPolicy(environment), /must be a positive integer/)
})
