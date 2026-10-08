import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  PERMISSION_TYPES,
  ROLE_PERMISSIONS,
  getDefaultPermissionsForRole,
  isValidPermissionType,
  hasPermission
} = await import('../src/constants/permissions.js')
const { normalizePermissionExpiry } = await import('../src/services/permissionPolicy.js')

describe('permission contract', () => {
  it('accepts the canonical permission registry and rejects unknown values', () => {
    assert.ok(isValidPermissionType(PERMISSION_TYPES.VIEW_TRANSACTIONS))
    assert.ok(isValidPermissionType(PERMISSION_TYPES.MANAGE_PERMISSIONS))
    assert.equal(isValidPermissionType('EDIT_MERCHANTS'), false)
    assert.equal(isValidPermissionType(''), false)
  })

  it('grants role defaults and denies unrelated permissions', () => {
    assert.deepEqual(getDefaultPermissionsForRole('TENANT_MANAGER').includes(PERMISSION_TYPES.MANAGE_MERCHANTS), true)
    assert.deepEqual(getDefaultPermissionsForRole('TENANT_VIEWER').includes(PERMISSION_TYPES.MANAGE_MERCHANTS), false)
    assert.equal(ROLE_PERMISSIONS.TENANT_ADMIN.includes(PERMISSION_TYPES.MANAGE_KYC), true)
    assert.equal(hasPermission('TENANT_VIEWER', [], PERMISSION_TYPES.MANAGE_MERCHANTS), false)
  })

  it('requires a scoped resource only when the permission is resource-specific', () => {
    assert.equal(hasPermission('TENANT_MANAGER', [{ permissionType: PERMISSION_TYPES.MANAGE_MERCHANTS, resourceId: 'merchant-1' }], PERMISSION_TYPES.MANAGE_MERCHANTS, 'merchant-1'), true)
    assert.equal(hasPermission('TENANT_MANAGER', [{ permissionType: PERMISSION_TYPES.MANAGE_MERCHANTS, resourceId: 'merchant-2' }], PERMISSION_TYPES.MANAGE_MERCHANTS, 'merchant-1'), false)
    assert.equal(hasPermission('TENANT_MANAGER', [], PERMISSION_TYPES.VIEW_REPORTS), true)
  })

  it('does not authorize expired custom permissions', () => {
    const expiresAt = new Date(Date.now() - 60_000).toISOString()
    assert.equal(hasPermission('TENANT_VIEWER', [{
      permissionType: PERMISSION_TYPES.MANAGE_MERCHANTS,
      resourceId: null,
      expiresAt
    }], PERMISSION_TYPES.MANAGE_MERCHANTS), false)
  })

  it('accepts only future timezone-qualified permission expiry timestamps', () => {
    const now = new Date('2026-10-08T00:00:00.000Z')
    assert.equal(normalizePermissionExpiry(null, now), null)
    assert.equal(normalizePermissionExpiry('2026-10-09T12:00:00.000Z', now), '2026-10-09T12:00:00.000Z')
    assert.throws(() => normalizePermissionExpiry('2026-10-07T12:00:00.000Z', now), /future/)
    assert.throws(() => normalizePermissionExpiry('2026-10-09T12:00:00', now), /timezone/)
  })
})
