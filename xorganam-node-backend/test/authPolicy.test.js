import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { parseAuthPolicy } = await import('../src/config/authPolicy.js')

describe('authentication policy', () => {
  it('uses validated lockout defaults and accepts configured positive values', () => {
    assert.deepEqual(parseAuthPolicy({}), {
      loginFailureThreshold: 5,
      loginLockoutDurationMs: 900000,
      maxActiveSessions: 5,
      globalSearchResultLimit: 20,
      emailVerificationTokenTtlMs: 1800000,
      emailVerificationRequestLimit: 3,
      emailVerificationRateWindowMs: 3600000,
      passwordResetTokenTtlMs: 1800000,
      passwordResetRequestLimit: 3,
      passwordResetRateWindowMs: 3600000
    })
    assert.deepEqual(parseAuthPolicy({ LOGIN_FAILURE_THRESHOLD: '8', LOGIN_LOCKOUT_DURATION_MS: '1200000' }), {
      loginFailureThreshold: 8,
      loginLockoutDurationMs: 1200000,
      maxActiveSessions: 5,
      globalSearchResultLimit: 20,
      emailVerificationTokenTtlMs: 1800000,
      emailVerificationRequestLimit: 3,
      emailVerificationRateWindowMs: 3600000,
      passwordResetTokenTtlMs: 1800000,
      passwordResetRequestLimit: 3,
      passwordResetRateWindowMs: 3600000
    })
  })

  it('rejects invalid lockout policy values', () => {
    assert.throws(() => parseAuthPolicy({ LOGIN_FAILURE_THRESHOLD: '0' }), /positive integer/)
    assert.throws(() => parseAuthPolicy({ LOGIN_LOCKOUT_DURATION_MS: 'many' }), /positive integer/)
  })
})
