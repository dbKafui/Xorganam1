export function normalizePermissionExpiry(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error('expiresAt must be an ISO 8601 timestamp with a timezone.')
  }

  const expiry = new Date(value)
  if (!Number.isFinite(expiry.getTime())) {
    throw new Error('expiresAt must be a valid date and time.')
  }
  if (expiry.getTime() <= now.getTime()) {
    throw new Error('expiresAt must be in the future.')
  }
  return expiry.toISOString()
}