import crypto from 'node:crypto'

function dateAndTime(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T.Z]/g, '')
  return { date: stamp.slice(0, 8), time: stamp.slice(8, 14) }
}

export function vendorNameCode(displayName) {
  const letters = String(displayName || '').normalize('NFKD').replace(/[^a-z]/gi, '').toUpperCase()
  return (letters.length >= 3 ? letters.slice(0, 4) : 'VEND')
}

export function createVendorReference(displayName, purpose = '') {
  const { date, time } = dateAndTime()
  const suffix = String(purpose || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  const uniqueId = crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()
  return [vendorNameCode(displayName), suffix, date, time, uniqueId].filter(Boolean).join('-')
}
