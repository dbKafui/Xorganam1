import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'

const { createSessionToken, validateSessionActor } = await import('../src/services/sessionService.js')
const { verifyToken } = await import('../src/security/jwt.js')

describe('session token binding', () => {
  it('contains a unique session identifier and token version', () => {
    const first = createSessionToken({
      id: '11111111-1111-4111-8111-111111111111',
      tenant_id: '22222222-2222-4222-8222-222222222222',
      role: 'TENANT_ADMIN',
      token_version: 3,
      mfa: true
    })
    const second = createSessionToken({
      id: '11111111-1111-4111-8111-111111111111',
      tenant_id: '22222222-2222-4222-8222-222222222222',
      role: 'TENANT_ADMIN',
      token_version: 3,
      mfa: true
    })

    assert.notEqual(first.sessionId, second.sessionId)
    assert.equal(verifyToken(first.token).sessionId, first.sessionId)
    assert.equal(verifyToken(first.token).tokenVersion, 3)
    assert.equal(verifyToken(first.token).mfa, true)
  })

  it('requires exactly one valid session revocation actor', () => {
    const actorId = '11111111-1111-4111-8111-111111111111'
    assert.deepEqual(validateSessionActor(actorId, null), { userActor: true, institutionActor: false })
    assert.throws(() => validateSessionActor(actorId, actorId), /at most one actor/)
    assert.throws(() => validateSessionActor('not-a-uuid', null), /valid user actor ID/)
  })
})
