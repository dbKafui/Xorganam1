import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'

const { makeResetToken, validateResetToken } = await import('../src/services/passwordResetService.js')

describe('password reset token generation', () => {
  it('generates cryptographically random, URL-safe tokens', () => {
    const first = makeResetToken()
    const second = makeResetToken()

    assert.notEqual(first, second)
    assert.match(first, /^[A-Za-z0-9_-]+$/)
    assert.equal(first.length, 43)
    assert.equal(validateResetToken(first), true)
  })

  it('rejects malformed, truncated, and non-URL-safe reset tokens', () => {
    assert.equal(validateResetToken('short'), false)
    assert.equal(validateResetToken('a'.repeat(42)), false)
    assert.equal(validateResetToken('a'.repeat(42) + '!'), false)
    assert.equal(validateResetToken(null), false)
  })
})
