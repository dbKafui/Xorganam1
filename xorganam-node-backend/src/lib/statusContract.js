export const TRANSACTION_STATUS_DEFINITIONS = Object.freeze({
  PENDING: { value: 'PENDING', category: 'pending', terminal: false, supportsFailure: true },
  RECEIVED: { value: 'RECEIVED', category: 'success', terminal: false, supportsFailure: false },
  SWEPT_INTERNAL: { value: 'SWEPT_INTERNAL', category: 'success', terminal: false, supportsFailure: false },
  PARTIALLY_SETTLED: { value: 'PARTIALLY_SETTLED', category: 'partial', terminal: false, supportsFailure: false },
  PAID_OUT: { value: 'PAID_OUT', category: 'success', terminal: true, supportsFailure: false },
  FAILED: { value: 'FAILED', category: 'failed', terminal: true, supportsFailure: false },
  UNKNOWN: { value: 'UNKNOWN', category: 'pending', terminal: false, supportsFailure: false },
  REJECTED: { value: 'REJECTED', category: 'failed', terminal: true, supportsFailure: false },
  VERIFICATION_BLOCKED: { value: 'VERIFICATION_BLOCKED', category: 'blocked', terminal: false, supportsFailure: false },
  MANUAL_RECONCILIATION_REQUIRED: { value: 'MANUAL_RECONCILIATION_REQUIRED', category: 'manual-reconciliation', terminal: false, supportsFailure: false }
})

export const TRANSACTION_STATUS_VALUES = Object.freeze(Object.keys(TRANSACTION_STATUS_DEFINITIONS))

export function normalizeTransactionStatus(status) {
  if (typeof status !== 'string') return ''
  const normalized = status.trim().toUpperCase().replace(/[-\s]+/g, '_')
  return TRANSACTION_STATUS_DEFINITIONS[normalized]?.value || normalized
}

export function isTerminalTransactionStatus(status) {
  return Boolean(TRANSACTION_STATUS_DEFINITIONS[normalizeTransactionStatus(status)]?.terminal)
}

export function isSuccessfulTransactionStatus(status) {
  const normalized = normalizeTransactionStatus(status)
  return ['RECEIVED', 'SWEPT_INTERNAL', 'PAID_OUT', 'PARTIALLY_SETTLED'].includes(normalized)
}

export function isFailedTransactionStatus(status) {
  const normalized = normalizeTransactionStatus(status)
  return ['FAILED', 'REJECTED'].includes(normalized)
}

export function isPendingTransactionStatus(status) {
  const normalized = normalizeTransactionStatus(status)
  return ['PENDING', 'UNKNOWN', 'VERIFICATION_BLOCKED', 'MANUAL_RECONCILIATION_REQUIRED'].includes(normalized)
}
