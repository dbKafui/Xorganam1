import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseEmailDeliveryPolicy } from '../src/config/emailDeliveryPolicy.js'

function validEnvironment(overrides = {}) {
  return {
    EMAIL_CACHE_TTL_MS: '30000',
    EMAIL_CACHE_MAX_ENTRIES: '1000',
    EMAIL_SEND_TIMEOUT_MS: '10000',
    EMAIL_SEND_ATTEMPTS: '5',
    EMAIL_SEND_BACKOFF_BASE_MS: '1000',
    EMAIL_MAX_ATTACHMENT_BYTES: '10485760',
    EMAIL_MAX_RECIPIENTS: '100',
    EMAIL_WORKER_CONCURRENCY: '5',
    EMAIL_DELIVERY_RECORD_RETENTION_DAYS: '90',
    EMAIL_TEST_RATE_LIMIT: '5',
    EMAIL_TEST_RATE_WINDOW_MS: '3600000',
    EMAIL_SENDER_CHALLENGE_TTL_MS: '86400000',
    EMAIL_ALLOWED_SMTP_PORTS: '25,465,587,2525',
    EMAIL_SMTP_STARTTLS_PORTS: '25,587,2525',
    EMAIL_SMTP_IMPLICIT_TLS_PORT: '465',
    EMAIL_BLOCKED_SMTP_CIDRS: '127.0.0.0/8,10.0.0.0/8',
    EMAIL_SMTP_ENCRYPTION_MODES: 'starttls,implicit_tls',
    EMAIL_SES_REGIONS: 'us-east-1,eu-west-1',
    EMAIL_MAILGUN_REGIONS: 'us,eu',
    EMAIL_DEFAULT_PROVIDER: 'smtp',
    EMAIL_DEFAULT_FROM_ADDRESS: 'noreply@example.invalid',
    EMAIL_DEFAULT_FROM_NAME: 'Example Sender',
    EMAIL_DEFAULT_SECRET_REFERENCE: 'xorganam/email/default-sender',
    EMAIL_DEFAULT_SETTINGS_JSON: '{"host":"smtp.example.invalid","port":587,"encryption":"starttls"}',
    EMAIL_CACHE_INVALIDATION_CHANNEL: 'tenant-email-config-invalidation',
    EMAIL_SENDGRID_API_URL: 'https://api.example.invalid/sendgrid',
    EMAIL_MAILGUN_API_BASE_URLS_JSON: '{"us":"https://api.example.invalid/mailgun-us","eu":"https://api.example.invalid/mailgun-eu"}',
    EMAIL_SMTP_ALLOW_INSECURE: 'false',
    ...overrides
  }
}

describe('tenant email delivery policy', () => {
  it('loads configured retry, timeout, limits, ports, and provider metadata', () => {
    const policy = parseEmailDeliveryPolicy(validEnvironment(), 'test')
    assert.equal(policy.retryAttempts, 5)
    assert.equal(policy.sendTimeoutMs, 10000)
    assert.deepEqual(policy.allowedSmtpPorts, [25, 465, 587, 2525])
    assert.equal(policy.smtpImplicitTlsPort, 465)
    assert.deepEqual(policy.sesRegions, ['us-east-1', 'eu-west-1'])
  })

  it('reports multiple missing and invalid values at once', () => {
    assert.throws(() => parseEmailDeliveryPolicy({ EMAIL_DEFAULT_PROVIDER: 'unknown' }, 'test'), (error) => (
      error.message.includes('EMAIL_CACHE_TTL_MS is missing') &&
      error.message.includes('EMAIL_DEFAULT_PROVIDER is not a registered email provider type')
    ))
  })

  it('rejects plaintext SMTP mode and insecure SMTP in production', () => {
    assert.throws(() => parseEmailDeliveryPolicy(validEnvironment({
      EMAIL_SMTP_ENCRYPTION_MODES: 'none',
      EMAIL_SMTP_ALLOW_INSECURE: 'true'
    }), 'production'), /cannot include none in production[\s\S]*must be false in production/)
  })

  it('rejects incomplete platform fallback settings', () => {
    assert.throws(() => parseEmailDeliveryPolicy(validEnvironment({
      EMAIL_DEFAULT_SETTINGS_JSON: '{"encryption":"starttls"}'
    }), 'test'), /missing required provider field host[\s\S]*missing required provider field port/)
  })

  it('rejects malformed configured SMTP CIDRs at startup', () => {
    assert.throws(() => parseEmailDeliveryPolicy(validEnvironment({
      EMAIL_BLOCKED_SMTP_CIDRS: 'not-a-cidr'
    }), 'test'), /EMAIL_BLOCKED_SMTP_CIDRS contains an invalid CIDR/)
  })
})