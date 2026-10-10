import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { RedisContainer } from '@testcontainers/redis'

process.env.NODE_ENV = 'test'
process.env.ENCRYPTION_MASTER_KEY = 'integration-test-master-key'
process.env.JWT_SECRET = 'integration-test-jwt-secret'
process.env.EMAIL_CACHE_TTL_MS = '30000'
process.env.EMAIL_CACHE_MAX_ENTRIES = '100'
process.env.EMAIL_SEND_TIMEOUT_MS = '10000'
process.env.EMAIL_SEND_ATTEMPTS = '3'
process.env.EMAIL_SEND_BACKOFF_BASE_MS = '100'
process.env.EMAIL_MAX_ATTACHMENT_BYTES = '1048576'
process.env.EMAIL_MAX_RECIPIENTS = '10'
process.env.EMAIL_WORKER_CONCURRENCY = '1'
process.env.EMAIL_DELIVERY_RECORD_RETENTION_DAYS = '1'
process.env.EMAIL_TEST_RATE_LIMIT = '2'
process.env.EMAIL_TEST_RATE_WINDOW_MS = '60000'
process.env.EMAIL_SENDER_CHALLENGE_TTL_MS = '3600000'
process.env.EMAIL_ALLOWED_SMTP_PORTS = '25,465,587,2525'
process.env.EMAIL_SMTP_STARTTLS_PORTS = '25,587,2525'
process.env.EMAIL_SMTP_IMPLICIT_TLS_PORT = '465'
process.env.EMAIL_BLOCKED_SMTP_CIDRS = '127.0.0.0/8,10.0.0.0/8'
process.env.EMAIL_SMTP_ENCRYPTION_MODES = 'starttls,implicit_tls'
process.env.EMAIL_SES_REGIONS = 'us-east-1'
process.env.EMAIL_MAILGUN_REGIONS = 'us'
process.env.EMAIL_DEFAULT_PROVIDER = 'smtp'
process.env.EMAIL_DEFAULT_FROM_ADDRESS = 'default@example.test'
process.env.EMAIL_DEFAULT_FROM_NAME = 'Test'
process.env.EMAIL_DEFAULT_SECRET_REFERENCE = 'email/default'
process.env.EMAIL_DEFAULT_SETTINGS_JSON = '{"host":"smtp.example.test","port":587,"encryption":"starttls"}'
process.env.EMAIL_CACHE_INVALIDATION_CHANNEL = 'email-cache-tests'
process.env.EMAIL_SENDGRID_API_URL = 'https://api.example.test/send'
process.env.EMAIL_MAILGUN_API_BASE_URLS_JSON = '{"us":"https://api.example.test/mailgun"}'
process.env.EMAIL_SMTP_ALLOW_INSECURE = 'false'
process.env.TENANT_EMAIL_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString('base64')}`
process.env.TENANT_EMAIL_ACTIVE_KEY_VERSION = '1'
process.env.VAULT_ADDR = 'http://127.0.0.1:8200'

let postgres
let redis
let pool
let queue
let redisConnection
let appServer
let request
let createSessionToken
let tenantEmailConfigRouter
let tenantEmailKeyring
let encryptTenantEmailSecrets

const tenantA = 'bc9d70d5-0b3a-4d80-b383-0489912e02e8'
const tenantB = '8069c4b5-7f6c-4142-930e-67ff1dfeeb9e'
const userA = 'b3e14298-a627-4212-94aa-b6c6b28dfe8f'
const userB = 'a5139198-a650-4ffa-bfb9-01f8077b6cfb'
let tokenA
let tokenB

async function insertTenantUser(tenantId, userId, email) {
  await pool.query('INSERT INTO tenants (id, status) VALUES ($1, \'ACTIVE\')', [tenantId])
  await pool.query(
    `INSERT INTO users (id, tenant_id, role, is_active, first_name, last_name, email, token_version)
     VALUES ($1, $2, 'TENANT_MANAGER', TRUE, 'Email', 'Manager', $3, 0)`,
    [userId, tenantId, email]
  )
  const session = createSessionToken({ id: userId, tenant_id: tenantId, role: 'TENANT_MANAGER', token_version: 0, mfa: true })
  await pool.query(
    `INSERT INTO sessions (id, user_id, tenant_id, token_version, expires_at, revoked_at, last_seen_at)
     VALUES ($1, $2, $3, 0, now() + interval '1 hour', NULL, now())`,
    [session.sessionId, userId, tenantId]
  )
  return session.token
}

async function authorizedFetch(tenantId, token, path, options = {}) {
  return request(`http://127.0.0.1:${appServer.address().port}/api/v1/tenants/${tenantId}/email-config${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  })
}

before(async () => {
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start()
  ])
  process.env.DATABASE_URL = postgres.getConnectionUri()
  process.env.REDIS_URL = redis.getConnectionUrl()
  const database = await import('../../src/db/pool.js')
  pool = database.pool
  await pool.query(`
    CREATE TABLE tenants (id UUID PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE users (
      id UUID PRIMARY KEY, tenant_id UUID NOT NULL, merchant_id UUID, role TEXT NOT NULL,
      is_active BOOLEAN NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      email TEXT NOT NULL, token_version INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id UUID PRIMARY KEY, user_id UUID NOT NULL, institution_staff_id UUID, tenant_id UUID NOT NULL, token_version INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE tenant_email_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID UNIQUE NOT NULL, provider_type TEXT NOT NULL,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb, secrets_encrypted BYTEA, key_version INTEGER,
      from_address TEXT NOT NULL, from_name TEXT, reply_to TEXT, sender_verified BOOLEAN NOT NULL DEFAULT FALSE,
      sender_verification_token_hash CHAR(64), sender_verification_requested_at TIMESTAMPTZ,
      enabled BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE email_delivery_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, status TEXT NOT NULL,
      recipient_count INTEGER NOT NULL, provider_message_id TEXT, error_code TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
    );
    CREATE TABLE platform_audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id UUID, actor_institution_staff_id UUID,
      tenant_id UUID, merchant_id UUID, action TEXT NOT NULL, resource_type TEXT NOT NULL,
      resource_id TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb, ip_address TEXT,
      user_agent TEXT, request_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  const auth = await import('../../src/services/sessionService.js')
  createSessionToken = auth.createSessionToken
  const cryptoService = await import('../../src/security/tenantEmailConfigCrypto.js')
  encryptTenantEmailSecrets = cryptoService.encryptTenantEmailSecrets
  tenantEmailKeyring = (await import('../../src/config/tenantEmailConfig.js')).tenantEmailKeyring
  tenantEmailConfigRouter = (await import('../../src/routes/tenantEmailConfig.js')).tenantEmailConfigRouter
  const queueModule = await import('../../src/queue/queue.js')
  queue = queueModule.getTenantEmailDeliveryQueue()
  redisConnection = queueModule.getRedisConnection()
  request = (await import('express')).default
  const express = request
  request = globalThis.fetch
  const app = express()
  app.use(express.json())
  app.use('/api/v1/tenants/:tenantId/email-config', tenantEmailConfigRouter)
  appServer = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  tokenA = await insertTenantUser(tenantA, userA, 'manager-a@xorganam.test')
  tokenB = await insertTenantUser(tenantB, userB, 'manager-b@xorganam.test')
})

after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve))
  await queue?.close()
  if (redisConnection?.status !== 'end') await redisConnection?.quit()
  await pool?.end()
  await redis?.stop()
  await postgres?.stop()
})

describe('tenant email API integration', () => {
  it('rejects cross-tenant access and masks stored provider secrets', async () => {
    const forbidden = await authorizedFetch(tenantB, tokenA, '/providers')
    assert.equal(forbidden.status, 403)

    const plaintextSecret = 'sendgrid-secret-sentinel'
    const encrypted = encryptTenantEmailSecrets(tenantA, { apiKey: plaintextSecret }, tenantEmailKeyring)
    const save = await authorizedFetch(tenantA, tokenA, '/', {
      method: 'PUT',
      body: JSON.stringify({
        providerType: 'sendgrid', settings: {}, secrets: { apiKey: plaintextSecret },
        fromAddress: 'billing@example.test', fromName: 'Billing', replyTo: '', enabled: false
      })
    })
    assert.equal(save.status, 200)
    const saveBody = await save.json()
    assert.equal(saveBody.config.secrets.apiKey, true)
    assert.equal(JSON.stringify(saveBody).includes(plaintextSecret), false)
    assert.ok(saveBody.verificationChallenge.recordValue)

    const read = await authorizedFetch(tenantA, tokenA, '/')
    const readBody = await read.json()
    assert.equal(read.status, 200)
    assert.equal(readBody.config.secrets.apiKey, true)
    assert.equal(JSON.stringify(readBody).includes(plaintextSecret), false)
    await pool.query(
      `UPDATE tenant_email_config SET secrets_encrypted = $2, key_version = $3, sender_verified = TRUE, enabled = TRUE
        WHERE tenant_id = $1`,
      [tenantA, encrypted.ciphertext, encrypted.keyVersion]
    )
  })

  it('sends test jobs only to the authenticated email and enforces tenant-isolated quotas', async () => {
    await pool.query(
      `INSERT INTO tenant_email_config (tenant_id, provider_type, settings, from_address, sender_verified, enabled)
       VALUES ($1, 'sendgrid', '{}'::jsonb, 'billing-b@example.test', TRUE, TRUE)`,
      [tenantB]
    )
    const first = await authorizedFetch(tenantA, tokenA, '/test', { method: 'POST', body: JSON.stringify({ to: 'attacker@example.test' }) })
    const second = await authorizedFetch(tenantA, tokenA, '/test', { method: 'POST', body: JSON.stringify({ to: 'attacker@example.test' }) })
    assert.equal(first.status, 202)
    assert.equal(second.status, 202)
    const firstBody = await first.json()
    const job = await queue.getJob(`tenant-email-${firstBody.deliveryId}`)
    assert.deepEqual(job.data.message.to, 'manager-a@xorganam.test')
    const status = await authorizedFetch(tenantA, tokenA, `/test/${firstBody.deliveryId}`)
    assert.equal((await status.json()).status, 'PENDING')

    const limited = await authorizedFetch(tenantA, tokenA, '/test', { method: 'POST' })
    assert.equal(limited.status, 429)
    const otherTenant = await authorizedFetch(tenantB, tokenB, '/test', { method: 'POST' })
    assert.equal(otherTenant.status, 202)
  })
})
