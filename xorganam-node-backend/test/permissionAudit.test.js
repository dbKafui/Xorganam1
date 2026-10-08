import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'

const { writePlatformAudit } = await import('../src/services/auditService.js')

describe('permission audit records', () => {
  it('records the action, actor, and permission metadata for changes', async () => {
    const calls = []
    const audit = await writePlatformAudit({
      actorUserId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      merchantId: '33333333-3333-4333-8333-333333333333',
      action: 'permission.granted',
      resourceType: 'user_permission',
      resourceId: '44444444-4444-4444-8444-444444444444',
      details: {
        permissionType: 'VIEW_REPORTS',
        resourceId: '33333333-3333-4333-8333-333333333333',
        targetUserId: '55555555-5555-4555-8555-555555555555'
      },
      client: async (sql, params) => {
        calls.push({ sql, params })
        return { rows: [{ id: 'audit-1', created_at: '2026-10-08T00:00:00.000Z' }] }
      }
    })

    assert.deepEqual(calls[0].params[0], '11111111-1111-4111-8111-111111111111')
    assert.equal(calls[0].params[4], 'permission.granted')
    assert.equal(calls[0].params[6], '44444444-4444-4444-8444-444444444444')
    assert.equal(audit.id, 'audit-1')
    assert.equal(audit.created_at, '2026-10-08T00:00:00.000Z')
  })
})
