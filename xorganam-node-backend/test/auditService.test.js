import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'

const { validateAuditActor } = await import('../src/services/auditService.js')

describe('platform audit actor validation', () => {
  it('allows anonymous events and either authenticated actor type', () => {
    assert.deepEqual(validateAuditActor(null, null), { userActor: false, institutionActor: false })
    assert.deepEqual(
      validateAuditActor('11111111-1111-4111-8111-111111111111', null),
      { userActor: true, institutionActor: false }
    )
    assert.deepEqual(
      validateAuditActor(null, '22222222-2222-4222-8222-222222222222'),
      { userActor: false, institutionActor: true }
    )
  })

  it('rejects an audit event with both actor types', () => {
    assert.throws(
      () => validateAuditActor(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222'
      ),
      /at most one actor/
    )
  })
})
