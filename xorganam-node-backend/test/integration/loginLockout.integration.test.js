import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer } from '@testcontainers/postgresql'

process.env.DATABASE_URL ||= 'postgresql://localhost/login_lockout_test'
process.env.REDIS_URL ||= 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY ||= 'login-lockout-integration-key'
process.env.JWT_SECRET ||= 'login-lockout-integration-secret'
process.env.MAX_ACTIVE_SESSIONS = '2'

let postgres
let pool
let recordFailedLogin
let clearFailedLoginState
let recordFailedInstitutionLogin
let clearFailedInstitutionLoginState
let createSession
let setTenantUserActiveStatus
let requirePermission
let requireRole
let requirePlatformAdmin
let searchGlobalRecords
let requestUserRoleChange
let reviewUserRoleChange
let assignUserMerchant
let unassignUserMerchant
let requestMerchantPayoutDestinationChange
let reviewMerchantPayoutDestinationChange
let userId
const databaseDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db')

before(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine').start()
  process.env.DATABASE_URL = postgres.getConnectionUri()
  pool = (await import('../../src/db/pool.js')).pool
  await pool.query('CREATE TABLE users (id UUID PRIMARY KEY)')
  await pool.query(`CREATE TABLE tenants (
    id UUID PRIMARY KEY, company_name TEXT, contact_email TEXT, status TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await pool.query(`CREATE TABLE kyc_documents (
    id UUID PRIMARY KEY, tenant_id UUID NOT NULL, verification_status TEXT NOT NULL
  )`)
  await pool.query(`ALTER TABLE users
    ADD COLUMN tenant_id UUID,
    ADD COLUMN merchant_id UUID,
    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN first_name TEXT,
    ADD COLUMN last_name TEXT,
    ADD COLUMN email TEXT,
    ADD COLUMN phone_number TEXT,
    ADD COLUMN last_login_at TIMESTAMPTZ,
    ADD COLUMN role TEXT NOT NULL DEFAULT 'TENANT_VIEWER',
    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now()`)
  await pool.query(`CREATE TABLE merchants (
    id UUID PRIMARY KEY, tenant_id UUID, display_name TEXT, vendor_reference TEXT, mobile_money_number TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await pool.query('CREATE TABLE institution_staff (id UUID PRIMARY KEY)')
  await pool.query(`CREATE TABLE sessions (
    id UUID PRIMARY KEY, user_id UUID, institution_staff_id UUID, tenant_id UUID, token_version INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), user_agent TEXT, ip_address INET
  )`)
  await pool.query(`CREATE TABLE platform_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id UUID, actor_institution_staff_id UUID,
    tenant_id UUID, merchant_id UUID, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb, ip_address INET, user_agent TEXT, request_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await pool.query(`CREATE TABLE user_permissions (
    user_id UUID NOT NULL, permission_type TEXT NOT NULL, resource_id UUID, expires_at TIMESTAMPTZ
  )`)
  const up = await readFile(path.join(databaseDirectory, '20270101_add_login_lockout.sql'), 'utf8')
  const down = await readFile(path.join(databaseDirectory, '20270101_add_login_lockout.down.sql'), 'utf8')
  await pool.query(up)
  await pool.query(down)
  await pool.query(up)
  const institutionLockoutUp = await readFile(path.join(databaseDirectory, '20270103_add_institution_login_lockout.sql'), 'utf8')
  const institutionLockoutDown = await readFile(path.join(databaseDirectory, '20270103_add_institution_login_lockout.down.sql'), 'utf8')
  await pool.query(institutionLockoutUp)
  const kycHistoryUp = await readFile(path.join(databaseDirectory, '20270104_add_kyc_review_history.sql'), 'utf8')
  const kycHistoryDown = await readFile(path.join(databaseDirectory, '20270104_add_kyc_review_history.down.sql'), 'utf8')
  await pool.query(kycHistoryUp)
  await pool.query(kycHistoryDown)
  await pool.query(kycHistoryUp)
  const roleApprovalsUp = await readFile(path.join(databaseDirectory, '20270105_add_user_role_change_approvals.sql'), 'utf8')
  const roleApprovalsDown = await readFile(path.join(databaseDirectory, '20270105_add_user_role_change_approvals.down.sql'), 'utf8')
  await pool.query(roleApprovalsUp)
  await pool.query(roleApprovalsDown)
  await pool.query(roleApprovalsUp)
  const payoutDestinationUp = await readFile(path.join(databaseDirectory, '20270106_add_payout_destination_change_approvals.sql'), 'utf8')
  const payoutDestinationDown = await readFile(path.join(databaseDirectory, '20270106_add_payout_destination_change_approvals.down.sql'), 'utf8')
  await pool.query(payoutDestinationUp)
  await pool.query(payoutDestinationDown)
  await pool.query(payoutDestinationUp)
  await pool.query(institutionLockoutDown)
  await pool.query(institutionLockoutUp)
  userId = '77c04301-50a5-4c9f-b9cf-7693a4360001'
  await pool.query('INSERT INTO users (id, first_name, last_name, email) VALUES ($1, $2, $3, $4)', [userId, 'Integration', 'Actor', 'integration@example.test'])
  ;({ recordFailedLogin, clearFailedLoginState, recordFailedInstitutionLogin, clearFailedInstitutionLoginState } = await import('../../src/services/loginSecurityService.js'))
  ;({ createSession } = await import('../../src/services/sessionService.js'))
  ;({ setTenantUserActiveStatus } = await import('../../src/services/userStatusService.js'))
  ;({ requirePermission, requireRole, requirePlatformAdmin } = await import('../../src/middleware/auth.js'))
  ;({ searchGlobalRecords } = await import('../../src/services/globalSearchService.js'))
  ;({ requestUserRoleChange, reviewUserRoleChange } = await import('../../src/services/userRoleChangeService.js'))
  ;({ assignUserMerchant, unassignUserMerchant } = await import('../../src/services/userMerchantAssignmentService.js'))
  ;({ requestMerchantPayoutDestinationChange, reviewMerchantPayoutDestinationChange } = await import('../../src/services/merchantPayoutDestinationService.js'))
})

after(async () => {
  await pool?.end()
  await postgres?.stop()
})

describe('concurrent login failure lockout', () => {
  it('atomically locks the account at the configured threshold and clears after success', async () => {
    const policy = { loginFailureThreshold: 5, loginLockoutDurationMs: 60000 }
    await Promise.all(Array.from({ length: 5 }, () => recordFailedLogin(userId, policy)))
    const { rows: lockedRows } = await pool.query(
      'SELECT failed_login_attempts, login_locked_until FROM users WHERE id = $1',
      [userId]
    )
    assert.equal(lockedRows[0].failed_login_attempts, 5)
    assert.ok(lockedRows[0].login_locked_until)

    await clearFailedLoginState(userId)
    const { rows } = await pool.query('SELECT failed_login_attempts, login_locked_until FROM users WHERE id = $1', [userId])
    assert.equal(rows[0].failed_login_attempts, 0)
    assert.equal(rows[0].login_locked_until, null)
  })

  it('atomically locks out institution staff under the same validated policy', async () => {
    const staffId = '1161b041-01da-40cc-b999-487750bd1222'
    await pool.query('INSERT INTO institution_staff (id) VALUES ($1)', [staffId])
    const policy = { loginFailureThreshold: 5, loginLockoutDurationMs: 60000 }
    await Promise.all(Array.from({ length: 5 }, () => recordFailedInstitutionLogin(staffId, policy)))
    const { rows } = await pool.query(
      'SELECT failed_login_attempts, login_locked_until FROM institution_staff WHERE id = $1', [staffId]
    )
    assert.equal(rows[0].failed_login_attempts, 5)
    assert.ok(rows[0].login_locked_until)
    await clearFailedInstitutionLoginState(staffId)
    const { rows: cleared } = await pool.query(
      'SELECT failed_login_attempts, login_locked_until FROM institution_staff WHERE id = $1', [staffId]
    )
    assert.equal(cleared[0].failed_login_attempts, 0)
    assert.equal(cleared[0].login_locked_until, null)
  })

  it('revokes the oldest device session when the configured concurrent-session limit is reached', async () => {
    const user = { id: userId, tenant_id: '4c10c320-f0cd-40ce-a188-2a8af8d65ab7', role: 'TENANT_OPERATOR', token_version: 0 }
    const request = { ip: '203.0.113.8', id: 'bcb282d5-7639-4f9e-8a55-17ded15c5634', headers: { 'user-agent': 'integration-test' } }
    await createSession(user, request)
    await createSession(user, request)
    await createSession(user, request)
    const { rows } = await pool.query(
      'SELECT count(*)::int AS active FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    )
    assert.equal(rows[0].active, 2)
    const { rows: auditRows } = await pool.query(
      `SELECT action FROM platform_audit_log WHERE action = 'SESSION_LIMIT_ENFORCED'`
    )
    assert.equal(auditRows.length, 1)
  })

  it('enforces and rolls back tenant/merchant scoped provider-reference uniqueness', async () => {
    await pool.query(`CREATE TABLE transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, merchant_id UUID NOT NULL,
      eganow_reference TEXT, internal_reference TEXT, type TEXT, status TEXT, amount NUMERIC(18,2), currency TEXT,
      collection_msisdn TEXT, payout_msisdn TEXT, raw_webhook_payload JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    await pool.query(`CREATE TABLE credit_plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, merchant_id UUID NOT NULL,
      customer_identifier TEXT NOT NULL, customer_name TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
    const up = await readFile(path.join(databaseDirectory, '20270102_unique_provider_reference_scope.sql'), 'utf8')
    const down = await readFile(path.join(databaseDirectory, '20270102_unique_provider_reference_scope.down.sql'), 'utf8')
    const tenantId = 'dcd15855-f270-41e7-9927-e43b19218192'
    const merchantId = '453a3181-ce3e-44ab-b65e-92446033453f'
    await pool.query(up)
    await pool.query('INSERT INTO transactions (tenant_id, merchant_id, eganow_reference) VALUES ($1, $2, $3)', [tenantId, merchantId, 'provider-ref'])
    await assert.rejects(
      pool.query('INSERT INTO transactions (tenant_id, merchant_id, eganow_reference) VALUES ($1, $2, $3)', [tenantId, merchantId, 'provider-ref']),
      (error) => error.code === '23505'
    )
    await pool.query('INSERT INTO transactions (tenant_id, merchant_id, eganow_reference) VALUES ($1, $2, $3)', [tenantId, userId, 'provider-ref'])
    await pool.query(down)
    await pool.query('INSERT INTO transactions (tenant_id, merchant_id, eganow_reference) VALUES ($1, $2, $3)', [tenantId, merchantId, 'provider-ref'])
  })

  it('requires and audits deactivation reasons while revoking the user sessions', async () => {
    const tenantId = 'dcd15855-f270-41e7-9927-e43b19218192'
    const actor = { id: 'e07ecf28-73db-4fa8-8327-09f5f2cac8fd' }
    const request = { ip: '203.0.113.8', id: 'bcb282d5-7639-4f9e-8a55-17ded15c5634', headers: { 'user-agent': 'integration-test' } }
    const sessionId = '0662db2c-14bf-4d10-91a7-93b1f9a758da'
    await pool.query('UPDATE users SET tenant_id = $2 WHERE id = $1', [userId, tenantId])
    await pool.query(
      `INSERT INTO sessions (id, user_id, tenant_id, token_version, expires_at)
       VALUES ($1, $2, $3, 0, now() + interval '1 hour')`,
      [sessionId, userId, tenantId]
    )
    await assert.rejects(
      setTenantUserActiveStatus({ userId, isActive: false, reason: '  ', actor, request }),
      /deactivation reason/
    )
    await setTenantUserActiveStatus({ userId, isActive: false, reason: 'Contract ended', actor, request })
    const { rows: userRows } = await pool.query('SELECT is_active, token_version FROM users WHERE id = $1', [userId])
    const { rows: sessionRows } = await pool.query('SELECT revoked_at FROM sessions WHERE id = $1', [sessionId])
    const { rows: auditRows } = await pool.query(
      `SELECT details FROM platform_audit_log WHERE action = 'USER_DEACTIVATED' AND resource_id = $1`,
      [userId]
    )
    assert.equal(userRows[0].is_active, false)
    assert.equal(userRows[0].token_version, 1)
    assert.ok(sessionRows[0].revoked_at)
    assert.equal(auditRows[0].details.reason, 'Contract ended')
  })

  it('audits permission denials with actor, role, request, and resource context', async () => {
    const req = {
      user: { id: userId, tenantId: 'dcd15855-f270-41e7-9927-e43b19218192', merchantId: null, role: 'TENANT_VIEWER' },
      params: { merchantId: '453a3181-ce3e-44ab-b65e-92446033453f' }, query: {}, body: {},
      method: 'POST', path: '/transactions/payout', ip: '203.0.113.8', id: 'bcb282d5-7639-4f9e-8a55-17ded15c5634',
      headers: { 'user-agent': 'integration-test' }
    }
    let statusCode
    let responseBody
    const res = {
      status(code) { statusCode = code; return this },
      json(body) { responseBody = body; return this }
    }
    let nextError
    await requirePermission('INITIATE_PAYOUT')(req, res, (error) => { nextError = error })
    assert.equal(nextError, undefined)
    assert.equal(statusCode, 403)
    assert.match(responseBody.message, /permission/)
    const { rows } = await pool.query(
      `SELECT actor_user_id, tenant_id, action, resource_type, resource_id, details, request_id
         FROM platform_audit_log WHERE action = 'PERMISSION_DENIED' ORDER BY created_at DESC LIMIT 1`
    )
    assert.equal(rows[0].actor_user_id, userId)
    assert.equal(rows[0].tenant_id, req.user.tenantId)
    assert.equal(rows[0].resource_id, req.params.merchantId)
    assert.equal(rows[0].request_id, req.id)
    assert.equal(rows[0].details.permissionType, 'INITIATE_PAYOUT')
    assert.equal(rows[0].details.role, 'TENANT_VIEWER')
  })

  it('audits explicit platform-admin permission bypasses before continuing', async () => {
    const req = {
      user: { id: userId, tenantId: null, merchantId: null, role: 'PLATFORM_ADMIN', isPlatformAdmin: true },
      params: {}, query: {}, body: {}, method: 'GET', path: '/operations/health',
      ip: '203.0.113.8', id: 'bcb282d5-7639-4f9e-8a55-17ded15c5634', headers: { 'user-agent': 'integration-test' }
    }
    let nextCalled = false
    await requirePermission('VIEW_OPERATIONS')(req, {}, () => { nextCalled = true })
    assert.equal(nextCalled, true)
    const { rows } = await pool.query(
      `SELECT actor_user_id, action, details FROM platform_audit_log
        WHERE action = 'PLATFORM_PERMISSION_BYPASS' ORDER BY created_at DESC LIMIT 1`
    )
    assert.equal(rows[0].actor_user_id, userId)
    assert.equal(rows[0].details.permissionType, 'VIEW_OPERATIONS')
    assert.equal(rows[0].details.role, 'PLATFORM_ADMIN')
  })

  it('audits platform-admin minimum-role bypasses before continuing', async () => {
    const req = {
      user: { id: userId, tenantId: null, merchantId: null, role: 'PLATFORM_ADMIN', isPlatformAdmin: true },
      params: {}, query: {}, body: {}, method: 'GET', path: '/tenants',
      ip: '203.0.113.8', id: 'bcb282d5-7639-4f9e-8a55-17ded15c5634', headers: { 'user-agent': 'integration-test' }
    }
    let nextCalled = false
    await requireRole('TENANT_ADMIN')(req, {}, () => { nextCalled = true })
    assert.equal(nextCalled, true)
    const { rows } = await pool.query(
      `SELECT actor_user_id, action, details FROM platform_audit_log
        WHERE action = 'PLATFORM_ROLE_BYPASS' ORDER BY created_at DESC LIMIT 1`
    )
    assert.equal(rows[0].actor_user_id, userId)
    assert.equal(rows[0].details.requiredRole, 'TENANT_ADMIN')
  })

  it('audits role-gate and platform-admin-gate denials', async () => {
    const req = {
      user: { id: userId, tenantId: 'dcd15855-f270-41e7-9927-e43b19218192', merchantId: null, role: 'TENANT_VIEWER' },
      params: {}, query: {}, body: {}, method: 'DELETE', path: '/tenants/example',
      ip: '203.0.113.8', id: 'bcb282d5-7639-4f9e-8a55-17ded15c5634', headers: { 'user-agent': 'integration-test' }
    }
    let statusCode
    const res = { status(code) { statusCode = code; return this }, json() { return this } }
    let nextError
    await requireRole('TENANT_ADMIN')(req, res, (error) => { nextError = error })
    assert.equal(statusCode, 403)
    assert.equal(nextError, undefined)
    statusCode = undefined
    await requirePlatformAdmin(req, res, (error) => { nextError = error })
    assert.equal(statusCode, 403)
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM platform_audit_log
        WHERE action = 'PERMISSION_DENIED' AND details->>'permissionType' IN ('ROLE_AT_LEAST_TENANT_ADMIN', 'PLATFORM_ADMIN_ONLY')`
    )
    assert.equal(rows[0].count, 2)
  })

  it('keeps KYC review decisions append-only and supports migration rollback', async () => {
    const tenantId = 'dcd15855-f270-41e7-9927-e43b19218192'
    const documentId = '2957cdce-a343-49a9-9f25-78dc83aa2c97'
    await pool.query('INSERT INTO tenants (id) VALUES ($1)', [tenantId])
    await pool.query('INSERT INTO kyc_documents (id, tenant_id, verification_status) VALUES ($1, $2, $3)', [documentId, tenantId, 'PENDING'])
    const { rows } = await pool.query(
      `INSERT INTO kyc_document_review_history
        (kyc_document_id, tenant_id, actor_user_id, previous_status, next_status)
       VALUES ($1, $2, $3, 'PENDING', 'APPROVED') RETURNING id`,
      [documentId, tenantId, userId]
    )
    await assert.rejects(
      pool.query("UPDATE kyc_document_review_history SET next_status = 'REJECTED' WHERE id = $1", [rows[0].id]),
      (error) => error.code === '55000'
    )
  })

  it('searches tenant, merchant, transaction, and user records without exposing provider payloads', async () => {
    const tenantId = '7741985c-c946-4a85-9f04-00dc8bd6f270'
    const merchantId = 'f9c648d1-ce0c-4dd3-abdf-c03ad4f80fb2'
    await pool.query('INSERT INTO tenants (id, company_name, contact_email, status) VALUES ($1, $2, $3, $4)',
      [tenantId, 'Needle Finance', 'needle@example.test', 'ACTIVE'])
    await pool.query('INSERT INTO merchants (id, tenant_id, display_name, vendor_reference, mobile_money_number) VALUES ($1, $2, $3, $4, $5)',
      [merchantId, tenantId, 'Needle Market', 'needle-vendor', '0551111111'])
    await pool.query(
      `INSERT INTO transactions (tenant_id, merchant_id, internal_reference, eganow_reference, type, status, amount, currency, raw_webhook_payload)
       VALUES ($1, $2, 'NEEDLE-TX', 'provider-secret-ref', 'COLLECTION', 'PENDING', 12.34, 'GHS', '{"private":"do-not-return"}')`,
      [tenantId, merchantId]
    )
    await pool.query(
      'INSERT INTO credit_plans (tenant_id, merchant_id, customer_identifier, customer_name) VALUES ($1, $2, $3, $4)',
      [tenantId, merchantId, '233555555555', 'Needle Customer']
    )
    await pool.query('UPDATE users SET first_name = $2 WHERE id = $1', [userId, 'Needle'])
    const results = await searchGlobalRecords('needle')
    assert.deepEqual(new Set(results.map((row) => row.entity_type)), new Set(['tenant', 'merchant', 'transaction', 'user', 'customer']))
    const customerResult = results.find((row) => row.entity_type === 'customer')
    assert.equal(customerResult.id, '233555555555')
    assert.equal(customerResult.tenant_id, tenantId)
    assert.equal(results.some((row) => JSON.stringify(row).includes('do-not-return')), false)
    await assert.rejects(searchGlobalRecords('%'), /between 2 and 100/)
  })

  it('requires an independent reviewer for role changes and records approvals atomically', async () => {
    const tenantId = 'dcd15855-f270-41e7-9927-e43b19218192'
    const requesterId = '4f33cac7-ebf3-4d04-bdcb-ed42b73c9542'
    const reviewerId = '73c07492-4b16-482b-8b15-a190c7151f32'
    await pool.query('INSERT INTO users (id, tenant_id, role, first_name, last_name, email) VALUES ($1, $2, $3, $4, $5, $6)', [requesterId, tenantId, 'TENANT_ADMIN', 'Request', 'Admin', 'requester@example.test'])
    await pool.query('INSERT INTO users (id, tenant_id, role, first_name, last_name, email) VALUES ($1, $2, $3, $4, $5, $6)', [reviewerId, tenantId, 'TENANT_ADMIN', 'Review', 'Admin', 'reviewer@example.test'])
    const requestContext = { ip: '203.0.113.8', id: 'bcb282d5-7639-4f9e-8a55-17ded15c5634', headers: { 'user-agent': 'integration-test' } }
    const created = await requestUserRoleChange({
      userId, tenantId, requestedRole: 'TENANT_OPERATOR', actor: { id: requesterId }, request: requestContext
    })
    assert.equal(created.request.status, 'PENDING')
    const { rows: beforeApproval } = await pool.query('SELECT role, token_version FROM users WHERE id = $1', [userId])
    assert.equal(beforeApproval[0].role, 'TENANT_VIEWER')
    const selfReview = await reviewUserRoleChange({
      requestId: created.request.id, tenantId, actor: { id: requesterId }, decision: 'APPROVED', request: requestContext
    })
    assert.equal(selfReview.forbidden, true)
    const approved = await reviewUserRoleChange({
      requestId: created.request.id, tenantId, actor: { id: reviewerId }, decision: 'APPROVED', request: requestContext
    })
    assert.equal(approved.role, 'TENANT_OPERATOR')
    const { rows: afterApproval } = await pool.query('SELECT role, token_version FROM users WHERE id = $1', [userId])
    assert.equal(afterApproval[0].role, 'TENANT_OPERATOR')
    assert.equal(afterApproval[0].token_version, 2)
    const { rows: approvalRows } = await pool.query('SELECT status, reviewed_by_user_id FROM user_role_change_requests WHERE id = $1', [created.request.id])
    assert.equal(approvalRows[0].status, 'APPROVED')
    assert.equal(approvalRows[0].reviewed_by_user_id, reviewerId)
  })

  it('audits merchant assignment changes and revokes sessions through token versioning', async () => {
    const tenantId = '7741985c-c946-4a85-9f04-00dc8bd6f270'
    const merchantId = 'f9c648d1-ce0c-4dd3-abdf-c03ad4f80fb2'
    const targetUserId = '4a3b2712-f012-45d9-86c6-d42b655c8701'
    const actorId = '73c07492-4b16-482b-8b15-a190c7151f32'
    await pool.query('INSERT INTO users (id, tenant_id, role, first_name, last_name, email) VALUES ($1, $2, $3, $4, $5, $6)',
      [targetUserId, tenantId, 'TENANT_OPERATOR', 'Scoped', 'User', 'scoped@example.test'])
    const requestContext = { ip: '203.0.113.8', id: 'bcb282d5-7639-4f9e-8a55-17ded15c5634', headers: { 'user-agent': 'integration-test' } }
    const assigned = await assignUserMerchant({ userId: targetUserId, tenantId, merchantId, actor: { id: actorId }, request: requestContext })
    assert.equal(assigned.user.merchant_id, merchantId)
    assert.equal(assigned.user.token_version, 1)
    const unassigned = await unassignUserMerchant({ userId: targetUserId, tenantId, actor: { id: actorId }, request: requestContext })
    assert.equal(unassigned.user.merchant_id, null)
    assert.equal(unassigned.user.token_version, 2)
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM platform_audit_log
        WHERE action = 'USER_MERCHANT_ASSIGNMENT_CHANGED' AND resource_id = $1`, [targetUserId]
    )
    assert.equal(rows[0].count, 2)
  })

  it('requires an independent approver for merchant payout destination changes', async () => {
    const tenantId = '7741985c-c946-4a85-9f04-00dc8bd6f270'
    const merchantId = 'f9c648d1-ce0c-4dd3-abdf-c03ad4f80fb2'
    const requesterId = '4ee11111-1111-4111-8111-111111111111'
    const reviewerId = '5ff22222-2222-4222-8222-222222222222'
    await pool.query('INSERT INTO users (id, tenant_id, role, email) VALUES ($1, $2, $3, $4), ($5, $2, $3, $6)',
      [requesterId, tenantId, 'TENANT_ADMIN', 'destination-requester@example.test', reviewerId, 'destination-reviewer@example.test'])
    const requestContext = { ip: '203.0.113.9', id: 'cbc282d5-7639-4f9e-8a55-17ded15c5634', headers: { 'user-agent': 'integration-test' } }
    const created = await requestMerchantPayoutDestinationChange({
      merchantId, tenantId, requestedNumber: '233244444444', actor: { id: requesterId }, request: requestContext
    })
    assert.equal(created.request.status, 'PENDING')
    const selfReview = await reviewMerchantPayoutDestinationChange({
      requestId: created.request.id, tenantId, actor: { id: requesterId }, decision: 'APPROVED', request: requestContext
    })
    assert.equal(selfReview.selfReview, true)
    const reviewed = await reviewMerchantPayoutDestinationChange({
      requestId: created.request.id, tenantId, actor: { id: reviewerId }, decision: 'APPROVED', request: requestContext
    })
    assert.equal(reviewed.request.status, 'APPROVED')
    const { rows: merchantRows } = await pool.query('SELECT mobile_money_number FROM merchants WHERE id = $1', [merchantId])
    assert.equal(merchantRows[0].mobile_money_number, '233244444444')
    const { rows: auditRows } = await pool.query(
      `SELECT count(*)::int AS count FROM platform_audit_log
        WHERE resource_id = $1 AND action IN ('MERCHANT_PAYOUT_DESTINATION_CHANGE_REQUESTED', 'MERCHANT_PAYOUT_DESTINATION_CHANGE_APPROVED')`,
      [created.request.id]
    )
    assert.equal(auditRows[0].count, 2)
  })
})
