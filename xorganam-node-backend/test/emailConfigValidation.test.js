import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getProviderDescriptors, toMaskedEmailConfig, validateTenantEmailConfig } from '../src/email/emailConfigValidation.js'
import { parseEmailDeliveryPolicy } from '../src/config/emailDeliveryPolicy.js'

const policy = parseEmailDeliveryPolicy({
  EMAIL_CACHE_TTL_MS: '1', EMAIL_CACHE_MAX_ENTRIES: '1', EMAIL_SEND_TIMEOUT_MS: '1', EMAIL_SEND_ATTEMPTS: '1',
  EMAIL_SEND_BACKOFF_BASE_MS: '1', EMAIL_MAX_ATTACHMENT_BYTES: '1', EMAIL_MAX_RECIPIENTS: '1', EMAIL_WORKER_CONCURRENCY: '1',
  EMAIL_DELIVERY_RECORD_RETENTION_DAYS: '1', EMAIL_TEST_RATE_LIMIT: '1', EMAIL_TEST_RATE_WINDOW_MS: '1',
  EMAIL_SENDER_CHALLENGE_TTL_MS: '86400000',
  EMAIL_ALLOWED_SMTP_PORTS: '465,587', EMAIL_SMTP_STARTTLS_PORTS: '587', EMAIL_SMTP_IMPLICIT_TLS_PORT: '465',
  EMAIL_BLOCKED_SMTP_CIDRS: '127.0.0.0/8', EMAIL_SMTP_ENCRYPTION_MODES: 'starttls,implicit_tls', EMAIL_SES_REGIONS: 'us-east-1',
  EMAIL_MAILGUN_REGIONS: 'us', EMAIL_DEFAULT_PROVIDER: 'smtp', EMAIL_DEFAULT_FROM_ADDRESS: 'sender@example.test', EMAIL_DEFAULT_FROM_NAME: 'Test',
  EMAIL_DEFAULT_SECRET_REFERENCE: 'email/default', EMAIL_DEFAULT_SETTINGS_JSON: '{"host":"smtp.example.test","port":587,"encryption":"starttls"}',
  EMAIL_CACHE_INVALIDATION_CHANNEL: 'email-cache', EMAIL_SENDGRID_API_URL: 'https://api.example.test/send',
  EMAIL_MAILGUN_API_BASE_URLS_JSON: '{"us":"https://api.example.test/mailgun"}', EMAIL_SMTP_ALLOW_INSECURE: 'false'
}, 'test')

describe('tenant email config validation', () => {
  it('retains blank secret fields only for the same provider', () => {
    const input = {
      providerType: 'sendgrid', settings: {}, secrets: { apiKey: '' },
      fromAddress: 'Sender@example.test', enabled: false
    }
    const previous = { provider_type: 'sendgrid', enabled: false }
    const retained = validateTenantEmailConfig(input, { existingConfig: previous, existingSecrets: { apiKey: 'old-secret' }, policy })
    assert.equal(retained.success, true)
    assert.equal(retained.data.secrets.apiKey, 'old-secret')
    const switched = validateTenantEmailConfig(input, { existingConfig: { ...previous, provider_type: 'smtp' }, existingSecrets: { apiKey: 'old-secret' }, policy })
    assert.equal(switched.success, false)
  })

  it('rejects unexpected settings and a TLS/port mismatch', () => {
    const result = validateTenantEmailConfig({
      providerType: 'smtp', settings: { host: 'mail.example.test', port: 465, encryption: 'starttls', rogue: 'x' },
      secrets: {}, fromAddress: 'sender@example.test'
    }, { policy })
    assert.equal(result.success, false)
    assert.ok(result.errors.some((error) => error.path === 'settings.rogue'))
    assert.ok(result.errors.some((error) => error.path === 'settings.port'))
  })

  it('disables a changed sender address until the new domain is verified', () => {
    const result = validateTenantEmailConfig({
      providerType: 'sendgrid', settings: {}, secrets: { apiKey: 'new-secret' },
      fromAddress: 'new-sender@example.test'
    }, {
      existingConfig: { provider_type: 'sendgrid', from_address: 'old-sender@example.test', enabled: true },
      policy
    })
    assert.equal(result.success, true)
    assert.equal(result.data.enabled, false)
  })

  it('returns only masked secret presence and provider descriptors include policy options', () => {
    const masked = toMaskedEmailConfig({
      provider_type: 'sendgrid', settings: {}, secrets_encrypted: Buffer.from('provider-api-key-sentinel'),
      from_address: 'sender@example.test', sender_verified: false, enabled: false
    }, ['apiKey'])
    assert.equal(JSON.stringify(masked).includes('provider-api-key-sentinel'), false)
    assert.equal(masked.secrets.apiKey, true)
    assert.deepEqual(getProviderDescriptors(policy).find(({ type }) => type === 'smtp').fields.find(({ key }) => key === 'port').options, [465, 587])
  })
})