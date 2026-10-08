import { normalizePaymentStatus } from '../lib/statusContract.js'

const MAP = {
  ACTIVE: 'chip-success',
  APPROVED: 'chip-success',
  PAID_OUT: 'chip-success',
  SWEPT_INTERNAL: 'chip-neutral',
  RECEIVED: 'chip-pending',
  PENDING: 'chip-pending',
  UNDER_REVIEW: 'chip-pending',
  PARTIALLY_SETTLED: 'chip-warning',
  FAILED: 'chip-failed',
  REJECTED: 'chip-failed',
  SUSPENDED: 'chip-failed',
  VERIFICATION_BLOCKED: 'chip-warning',
  MANUAL_RECONCILIATION_REQUIRED: 'chip-warning'
}

export default function StatusChip({ status }) {
  const normalized = normalizePaymentStatus(status)
  const cls = MAP[normalized] || 'chip-neutral'
  return <span className={`chip ${cls}`}>{normalized?.replaceAll('_', ' ')}</span>
}
