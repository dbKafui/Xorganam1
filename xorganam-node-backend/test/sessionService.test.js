import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'

const { createSessionToken, validateSessionActor, validateSessionToken, revokeCurrentSession, listSessionsForUser } = await import('../src/services/sessionService.js')
const { pool } = await import('../src/db/pool.js')
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

  it('returns true only when the current session was revoked', async () => {
    const client = {
      query: mock.fn(async (sql) => {
        if (sql.startsWith('UPDATE sessions')) return { rowCount: 1 }
        return { rowCount: 1, rows: [] }
      }),
      release: mock.fn()
    }
    const connect = mock.method(pool, 'connect', async () => client)

    try {
      const revoked = await revokeCurrentSession(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        'TENANT',
        '22222222-2222-4222-8222-222222222222',
        'user_logout'
      )
      assert.equal(revoked, true)
    } finally {
      connect.mock.restore()
    }
  })

  it('lists only active sessions for the selected principal type', async () => {
    const activeSession = { id: '33333333-3333-4333-8333-333333333333' }
    const query = mock.method(pool, 'query', async (sql, params) => {
      assert.match(sql, /institution_staff_id = \$1 AND revoked_at IS NULL AND expires_at > now\(\)/)
      assert.deepEqual(params, ['22222222-2222-4222-8222-222222222222'])
      return { rows: [activeSession] }
    })

    try {
      assert.deepEqual(
        await listSessionsForUser('22222222-2222-4222-8222-222222222222', 'INSTITUTION'),
        [activeSession]
      )
      await assert.rejects(listSessionsForUser('invalid', 'INSTITUTION'), /valid session principal/)
    } finally {
      query.mock.restore()
    }
  })

  it('refreshes stale last-seen metadata while validating an active token', async () => {
    const session = createSessionToken({
      id: '11111111-1111-4111-8111-111111111111',
      tenant_id: '22222222-2222-4222-8222-222222222222',
      role: 'TENANT_ADMIN',
      token_version: 0
    })
    const query = mock.method(pool, 'query', async (sql, params) => {
      assert.match(sql, /UPDATE sessions SET last_seen_at = now\(\)/)
      assert.match(sql, /last_seen_at < now\(\) - interval '5 minutes'/)
      assert.deepEqual(params, [session.sessionId, '11111111-1111-4111-8111-111111111111', 0])
      return { rows: [{ id: session.sessionId }] }
    })

    try {
      const payload = await validateSessionToken(session.token)
      assert.equal(payload.sessionId, session.sessionId)
    } finally {
      query.mock.restore()
    }
  })
})
