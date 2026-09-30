export function ErrorMessage({ children }) {
  if (!children) return null
  return <div className="notice notice-error" role="alert"><strong>Could not complete request</strong><span>{children}</span></div>
}

export function SuccessMessage({ children }) {
  if (!children) return null
  return <div className="notice notice-success" role="status"><strong>Done</strong><span>{children}</span></div>
}

export function LoadingState({ label = 'Loading records...' }) {
  return <div className="state-card"><span className="loader" />{label}</div>
}

export function EmptyState({ title = 'Nothing to show yet', children }) {
  return <div className="state-card empty-state"><span className="empty-mark">—</span><strong>{title}</strong>{children && <span>{children}</span>}</div>
}
