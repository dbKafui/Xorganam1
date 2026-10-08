import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  PERMISSION_TYPES,
  ROLE_PERMISSIONS,
  getDefaultPermissionsForRole,
  isValidPermissionType,
  hasPermission
} = await import('../src/constants/permissions.js')

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
})
