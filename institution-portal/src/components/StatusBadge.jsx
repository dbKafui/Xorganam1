import { normalizePaymentStatus } from '../lib/statusContract.js'

export default function StatusBadge({ value }) {
  const status = normalizePaymentStatus(value)
  const text = status.replaceAll('_', ' ').toLowerCase()
  const tone = status === 'PAID_OUT' || status === 'SETTLED' || status === 'ACTIVE' || status === 'APPROVED'
    ? 'good'
    : status === 'FAILED' || status === 'REJECTED' || status === 'PARTIALLY_SETTLED'
      ? 'bad'
      : status === 'PENDING' || status === 'UNDER_REVIEW' || status === 'ACCRUED_UNSWEPT' ||
          status === 'VERIFICATION_BLOCKED' || status === 'MANUAL_RECONCILIATION_REQUIRED'
        ? 'warn'
        : 'neutral'
  return <span className={`badge badge-${tone}`}>{text}</span>
}
