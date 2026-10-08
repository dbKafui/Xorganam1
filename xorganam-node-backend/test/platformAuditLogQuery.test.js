import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { normalizePlatformAuditFilters, buildPlatformAuditWhere } = await import('../src/services/platformAuditLogQuery.js')

describe('platform audit log filters', () => {
  it('validates bounds and builds parameterized date and actor filters', () => {
    const filters = normalizePlatformAuditFilters({
      page: '2',
      pageSize: '25',
      tenantId: '11111111-1111-4111-8111-111111111111',
      actorUserId: '22222222-2222-4222-8222-222222222222',
      actorInstitutionStaffId: '33333333-3333-4333-8333-333333333333',
      action: 'permission.granted',
      resourceType: 'user_permission',
      resourceId: '44444444-4444-4444-8444-444444444444',
      fromDate: '2026-10-01',
      toDate: '2026-10-08'
    })
    const query = buildPlatformAuditWhere(filters)

    assert.equal(filters.page, 2)
    assert.equal(filters.pageSize, 25)
    assert.match(query.whereClause, /a\.tenant_id = \$1::uuid/)
    assert.match(query.whereClause, /a\.actor_user_id = \$2::uuid/)
    assert.match(query.whereClause, /a\.actor_institution_staff_id = \$3::uuid/)
    assert.match(query.whereClause, /a\.resource_id = \$6/)
    assert.match(query.whereClause, /a\.created_at >= \$7::date/)
    assert.deepEqual(query.params, [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      'permission.granted',
      'user_permission',
      '44444444-4444-4444-8444-444444444444',
      '2026-10-01',
      '2026-10-08'
    ])
  })

  it('rejects unsafe pages, identifiers, dates, and filter ranges', () => {
    assert.throws(() => normalizePlatformAuditFilters({ page: '0' }), /page/)
    assert.throws(() => normalizePlatformAuditFilters({ pageSize: '101' }), /pageSize/)
    assert.throws(() => normalizePlatformAuditFilters({ tenantId: 'not-a-uuid' }), /tenantId/)
    assert.throws(() => normalizePlatformAuditFilters({ fromDate: '2026-02-30' }), /calendar date/)
    assert.throws(() => normalizePlatformAuditFilters({ fromDate: '2026-10-09', toDate: '2026-10-08' }), /after/)
  })
})