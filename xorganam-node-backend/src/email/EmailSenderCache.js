export class EmailSenderCache {
  constructor(maxEntries, now = () => Date.now()) {
    this.maxEntries = maxEntries
    this.now = now
    this.entries = new Map()
  }

  get(key) {
    const entry = this.entries.get(key)
    if (!entry || entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key, value, ttlMs) {
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs })
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value)
  }

  invalidate(key) {
    if (key === undefined) this.entries.clear()
    else this.entries.delete(key)
  }
}