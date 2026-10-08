import assert from 'node:assert/strict'
import test from 'node:test'
import { hasPermission, PERMISSION_TYPES } from '../src/constants/permissions.js'

test('expired custom permissions are hidden from UI capability checks', () => {
  const permissions = [{
    permissionType: PERMISSION_TYPES.MANAGE_MERCHANTS,
    resourceId: null,
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  }]
  assert.equal(hasPermission('TENANT_VIEWER', permissions, PERMISSION_TYPES.MANAGE_MERCHANTS), false)
})

test('unexpired custom permissions remain available to the UI', () => {
  const permissions = [{
    permissionType: PERMISSION_TYPES.MANAGE_MERCHANTS,
    resourceId: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  }]
  assert.equal(hasPermission('TENANT_VIEWER', permissions, PERMISSION_TYPES.MANAGE_MERCHANTS), true)
})

test('role defaults do not bypass merchant scope while tenant grants inherit', () => {
  assert.equal(hasPermission('TENANT_MANAGER', [], PERMISSION_TYPES.MANAGE_MERCHANTS, 'merchant-1'), false)
  assert.equal(hasPermission('TENANT_MANAGER', [{
    permissionType: PERMISSION_TYPES.MANAGE_MERCHANTS,
    resourceId: 'merchant-1'
  }], PERMISSION_TYPES.MANAGE_MERCHANTS, 'merchant-1'), true)
  assert.equal(hasPermission('TENANT_VIEWER', [{
    permissionType: PERMISSION_TYPES.MANAGE_MERCHANTS,
    resourceId: null
  }], PERMISSION_TYPES.MANAGE_MERCHANTS, 'merchant-2'), true)
  assert.equal(hasPermission('TENANT_VIEWER', [{
    permissionType: PERMISSION_TYPES.MANAGE_MERCHANTS,
    resourceId: 'merchant-1'
  }], PERMISSION_TYPES.MANAGE_MERCHANTS, 'merchant-2'), false)
})
