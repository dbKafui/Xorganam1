export const PAYMENT_STATUS_CONTRACT = Object.freeze({
  PENDING: { value: 'PENDING', category: 'pending', terminal: false },
  RECEIVED: { value: 'RECEIVED', category: 'success', terminal: false },
  SWEPT_INTERNAL: { value: 'SWEPT_INTERNAL', category: 'success', terminal: false },
  PARTIALLY_SETTLED: { value: 'PARTIALLY_SETTLED', category: 'partial', terminal: false },
  PAID_OUT: { value: 'PAID_OUT', category: 'success', terminal: true },
  FAILED: { value: 'FAILED', category: 'failed', terminal: true },
  UNKNOWN: { value: 'UNKNOWN', category: 'pending', terminal: false },
  REJECTED: { value: 'REJECTED', category: 'failed', terminal: true },
  VERIFICATION_BLOCKED: { value: 'VERIFICATION_BLOCKED', category: 'blocked', terminal: false },
  MANUAL_RECONCILIATION_REQUIRED: { value: 'MANUAL_RECONCILIATION_REQUIRED', category: 'manual-reconciliation', terminal: false }
})

export function normalizePaymentStatus(status) {
  const raw = typeof status === 'string' ? status.trim().toUpperCase().replace(/[-\s]+/g, '_') : ''
  return PAYMENT_STATUS_CONTRACT[raw]?.value || raw || 'UNKNOWN'
}
