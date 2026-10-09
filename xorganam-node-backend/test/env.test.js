import assert from 'node:assert';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('env configuration', () => {
  it('requires critical environment variables', () => {
    const script = `
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      process.env.REDIS_URL = 'redis://localhost:6379';
      process.env.ENCRYPTION_MASTER_KEY = 'test-key';
      process.env.JWT_SECRET = 'test-secret';
      process.env.TENANT_EMAIL_ENCRYPTION_KEYS = '1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      process.env.TENANT_EMAIL_ACTIVE_KEY_VERSION = '1';
      process.env.EMAIL_CACHE_TTL_MS = '30000';
      process.env.EMAIL_CACHE_MAX_ENTRIES = '1000';
      process.env.EMAIL_SEND_TIMEOUT_MS = '15000';
      process.env.EMAIL_SEND_ATTEMPTS = '5';
      process.env.EMAIL_SEND_BACKOFF_BASE_MS = '1000';
      process.env.EMAIL_MAX_ATTACHMENT_BYTES = '10485760';
      process.env.EMAIL_MAX_RECIPIENTS = '100';
      process.env.EMAIL_WORKER_CONCURRENCY = '5';
      process.env.EMAIL_DELIVERY_RECORD_RETENTION_DAYS = '90';
      process.env.EMAIL_ALLOWED_SMTP_PORTS = '25,465,587,2525';
      process.env.EMAIL_SMTP_STARTTLS_PORTS = '25,587,2525';
      process.env.EMAIL_SMTP_IMPLICIT_TLS_PORT = '465';
      process.env.EMAIL_BLOCKED_SMTP_CIDRS = '127.0.0.0/8,10.0.0.0/8';
      process.env.EMAIL_SMTP_ENCRYPTION_MODES = 'starttls,implicit_tls';
      process.env.EMAIL_SMTP_ALLOW_INSECURE = 'false';
      process.env.EMAIL_SES_REGIONS = 'us-east-1,eu-west-1';
      process.env.EMAIL_MAILGUN_REGIONS = 'us,eu';
      process.env.EMAIL_DEFAULT_PROVIDER = 'smtp';
      process.env.EMAIL_DEFAULT_FROM_ADDRESS = 'sender@example.invalid';
      process.env.EMAIL_DEFAULT_FROM_NAME = 'Test Sender';
      process.env.EMAIL_DEFAULT_SECRET_REFERENCE = 'xorganam/email/default-sender';
      process.env.EMAIL_DEFAULT_SETTINGS_JSON = '{"host":"smtp.example.invalid","port":587,"encryption":"starttls"}';
      process.env.EMAIL_CACHE_INVALIDATION_CHANNEL = 'tenant-email-config-invalidation';
      process.env.EMAIL_SENDGRID_API_URL = 'https://api.example.invalid/sendgrid';
      process.env.EMAIL_MAILGUN_API_BASE_URLS_JSON = '{"us":"https://api.example.invalid/mailgun-us","eu":"https://api.example.invalid/mailgun-eu"}';
      Promise.all([
        import('../src/config/env.js'),
        import('../src/config/tenantEmailConfig.js'),
        import('../src/config/emailDelivery.js')
      ]).then(() => console.log('OK')).catch((err) => {
        console.error(err.message);
        process.exit(1);
      });
    `;

    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: __dirname,
      encoding: 'utf8'
    });

    assert.ok(output.includes('OK'));
  });
});
