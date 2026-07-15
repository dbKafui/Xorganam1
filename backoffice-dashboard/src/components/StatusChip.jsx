const MAP = {
  ACTIVE: 'chip-success',
  APPROVED: 'chip-success',
  PAID_OUT: 'chip-success',
  SWEPT_INTERNAL: 'chip-neutral',
  RECEIVED: 'chip-pending',
  PENDING: 'chip-pending',
  UNDER_REVIEW: 'chip-pending',
  FAILED: 'chip-failed',
  REJECTED: 'chip-failed',
  SUSPENDED: 'chip-failed'
}

export default function StatusChip({ status }) {
  const cls = MAP[status] || 'chip-neutral'
  return <span className={`chip ${cls}`}>{status?.replace(/_/g, ' ')}</span>
}
