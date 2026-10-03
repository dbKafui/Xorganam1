export default function StatusBadge({ value }) {
  const text = String(value || 'UNKNOWN').replaceAll('_', ' ').toLowerCase()
  const tone = text.includes('approv') || text.includes('settled') || text === 'active' || text === 'resolved'
    ? 'good'
    : text.includes('reject') || text.includes('failed') || text.includes('partial')
      ? 'bad'
      : text.includes('pending') || text.includes('review') || text.includes('accrued')
        ? 'warn'
        : 'neutral'
  return <span className={`badge badge-${tone}`}>{text}</span>
}
