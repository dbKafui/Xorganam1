import assert from 'node:assert'
import { describe, it } from 'node:test'

process.env.DATABASE_URL ??= 'postgresql://localhost/test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY ??= 'test-key'
process.env.JWT_SECRET ??= 'test-secret'

const { hasInstitutionPermission } = await import('../src/constants/institutionPermissions.js')
const { signToken, verifyToken } = await import('../src/security/jwt.js')
const { institutionLinkScope, institutionDisputeScope } = await import('../src/services/institutionScope.js')
const { institutionMembershipAdapterInternals } = await import('../src/services/institutionMembershipAdapterService.js')

describe('institution portal permissions', () => {
  it('grants the correct minimum roles for Track 2 permissions', () => {
    assert.equal(hasInstitutionPermission('FIELD_OFFICER', 'dashboard:view'), true)
    assert.equal(hasInstitutionPermission('FIELD_OFFICER', 'verification:action'), true)
    assert.equal(hasInstitutionPermission('FIELD_OFFICER', 'staff:manage'), false)
    assert.equal(hasInstitutionPermission('SUPERVISOR', 'staff:view'), true)
    assert.equal(hasInstitutionPermission('INSTITUTION_ADMIN', 'staff:manage'), true)
  })

  describe('institution row scope and membership adapter validation', () => {
    it('binds institution and staff IDs as parameters in row-level scopes', () => {
      const fieldScope = institutionLinkScope('l', {
        role: 'FIELD_OFFICER',
        institutionId: 'institution-1',
        id: 'staff-1'
      })
      assert.deepEqual(fieldScope.params, ['institution-1', 'staff-1'])
      assert.match(fieldScope.clause, /escalated_to_supervisor_id IS NULL/)

      const disputeScope = institutionDisputeScope('d', {
        role: 'SUPERVISOR',
        institutionId: 'institution-1',
        id: 'staff-1'
      }, 2)
      assert.deepEqual(disputeScope.params, ['institution-1', 'staff-1'])
      assert.match(disputeScope.clause, /d\.institution_id = \$2/)
    })

    it('rejects non-public or non-HTTPS membership adapter destinations', () => {
      assert.throws(() => institutionMembershipAdapterInternals.validateBaseUrl('http://membership.example.org'))
      assert.throws(() => institutionMembershipAdapterInternals.validateBaseUrl('https://localhost/api'))
      assert.throws(() => institutionMembershipAdapterInternals.validateBaseUrl('https://192.168.1.20/api'))
      assert.equal(institutionMembershipAdapterInternals.validateBaseUrl('https://membership.example.org/api').hostname, 'membership.example.org')
      assert.equal(institutionMembershipAdapterInternals.isBlockedAddress('127.0.0.1'), true)
      assert.equal(institutionMembershipAdapterInternals.isBlockedAddress('198.51.100.2'), true)
    })

    it('encodes member references and protects adapter authentication headers', () => {
      const request = institutionMembershipAdapterInternals.normalizeRequestTemplate({
        method: 'GET',
        path: '/members/{memberId}/status'
      }, 'member/123')
      assert.equal(request.path, '/members/member%2F123/status')
      assert.throws(() => institutionMembershipAdapterInternals.normalizeRequestTemplate({
        method: 'GET',
        path: '/members/status',
        headers: { Authorization: 'Bearer user-value' }
      }, 'member-1'))
    })
  })

  it('round-trips institution claims through the JWT without losing the institution context', () => {
    const token = signToken({
      id: 'staff-123',
      institutionId: 'institution-456',
      institutionStaffId: 'staff-123',
      role: 'SUPERVISOR'
    })

    const payload = verifyToken(token)

    assert.equal(payload.sub, 'staff-123')
    assert.equal(payload.institutionId, 'institution-456')
    assert.equal(payload.institutionStaffId, 'staff-123')
    assert.equal(payload.role, 'SUPERVISOR')
  })
})
