function positiveInteger(environment, name, fallback) {
  const raw = environment[name] ?? String(fallback)
  const parsed = Number(raw)
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return parsed
}

export function parsePaymentRecoveryPolicy(environment = process.env) {
  return Object.freeze({
    workerConcurrency: positiveInteger(environment, 'PAYMENT_WORKER_CONCURRENCY', environment.WORKER_CONCURRENCY ?? 5),
    statusPollDelayMs: positiveInteger(environment, 'COLLECTION_STATUS_POLL_DELAY_MS', 5000),
    statusPollMaxAttempts: positiveInteger(environment, 'COLLECTION_STATUS_POLL_ATTEMPTS', 12),
    statusPollQueueAttempts: positiveInteger(environment, 'COLLECTION_STATUS_QUEUE_ATTEMPTS', 3),
    statusPollQueueBackoffMs: positiveInteger(environment, 'COLLECTION_STATUS_QUEUE_BACKOFF_MS', 2000),
    collectionQueueAttempts: positiveInteger(environment, 'COLLECT_FOR_ME_QUEUE_ATTEMPTS', 5),
    collectionQueueBackoffMs: positiveInteger(environment, 'COLLECT_FOR_ME_QUEUE_BACKOFF_MS', 2000),
    splitPayoutMaxRetries: positiveInteger(environment, 'SPLIT_PAYOUT_MAX_RETRIES', 5)
  })
}

export const paymentRecoveryPolicy = parsePaymentRecoveryPolicy()
