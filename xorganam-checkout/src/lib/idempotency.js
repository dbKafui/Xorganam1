export function createIdempotencyKey() {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function getOrCreateIdempotencyKey(storageKey) {
  const existing = sessionStorage.getItem(storageKey)
  if (existing) return existing
  const key = createIdempotencyKey()
  sessionStorage.setItem(storageKey, key)
  return key
}

export function clearIdempotencyKey(storageKey) {
  sessionStorage.removeItem(storageKey)
}
