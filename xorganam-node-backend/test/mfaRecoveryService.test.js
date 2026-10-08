import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'

const { generateRecoveryCodes, isValidRecoveryCode, normalizeRecoveryCode } =
  await import('../src/services/mfaRecoveryService.js')

describe('MFA recovery codes', () => {
  it('generates ten unique codes with 96 bits of entropy each', () => {
    const codes = generateRecoveryCodes()
    assert.equal(codes.length, 10)
    assert.equal(new Set(codes).size, 10)
    for (const code of codes) {
      assert.match(code, /^(?:[A-F0-9]{4}-){5}[A-F0-9]{4}$/)
      assert.equal(isValidRecoveryCode(code), true)
    }
  })

  it('normalizes separators without accepting malformed codes', () => {
    assert.equal(normalizeRecoveryCode('a1b2-c3d4 e5f6-7890-abcd-ef12'), 'A1B2C3D4E5F67890AB CDEF12'.replaceAll(' ', ''))
    assert.equal(isValidRecoveryCode('short'), false)
    assert.equal(isValidRecoveryCode(null), false)
  })
})
