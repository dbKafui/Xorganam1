import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'
delete process.env.RESEND_API_KEY
delete process.env.RESEND_FROM_EMAIL

const { makeEmailVerificationToken, isValidEmailVerificationToken, verifyEmailAddress } =
  await import('../src/services/emailVerificationService.js')
const { sendEmailVerificationEmail } = await import('../src/services/notificationService.js')

describe('tenant email verification', () => {
  it('generates unique URL-safe 256-bit tokens', () => {
    const first = makeEmailVerificationToken()
    const second = makeEmailVerificationToken()
    assert.notEqual(first, second)
    assert.equal(first.length, 43)
    assert.equal(isValidEmailVerificationToken(first), true)
  })

  it('rejects malformed or missing tokens without a database lookup', async () => {
    assert.equal(isValidEmailVerificationToken('short'), false)
    assert.equal(isValidEmailVerificationToken(null), false)
    assert.deepEqual(await verifyEmailAddress('short'), { verified: false })
  })

  it('does not report email delivery when Resend is not configured', async () => {
    assert.equal(await sendEmailVerificationEmail({ email: 'person@example.test', firstName: 'Person', token: makeEmailVerificationToken() }), false)
  })
})
