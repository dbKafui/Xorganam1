import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'

const { isLoginLocked } = await import('../src/services/loginSecurityService.js')

describe('login lockout decision', () => {
  it('blocks only while the configured lockout timestamp is in the future', () => {
    const now = Date.parse('2026-10-09T12:00:00.000Z')
    assert.equal(isLoginLocked('2026-10-09T12:01:00.000Z', now), true)
    assert.equal(isLoginLocked('2026-10-09T11:59:00.000Z', now), false)
    assert.equal(isLoginLocked(null, now), false)
  })
})
