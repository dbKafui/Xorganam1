import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emailTenantScopeDecision } from '../src/email/emailTenantScope.js'

describe('tenant email route scope', () => {
  it('requires an authenticated session tenant to exactly match the path tenant', () => {
    const tenantId = '6e7234b4-fb87-4aad-9a82-4b9d34f7859e'
    assert.equal(emailTenantScopeDecision({ tenantId }, tenantId), 'allowed')
    assert.equal(emailTenantScopeDecision({ tenantId: 'e66d39a7-cfec-4fb0-a50e-9163cd891894' }, tenantId), 'forbidden')
    assert.equal(emailTenantScopeDecision({ tenantId: null }, tenantId), 'forbidden')
    assert.equal(emailTenantScopeDecision({ tenantId }, 'not-a-uuid'), 'invalid')
  })
})