export function maskAccount(s) {
  if (!s) return '—'
  const str = String(s)
  const last = str.slice(-4)
  return '•••' + last
}
