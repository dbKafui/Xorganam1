import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'
delete process.env.VAULT_ADDR
delete process.env.VAULT_TOKEN

describe('Vault-backed encryption', () => {
  it('does not downgrade new writes when Vault transit is unavailable', async () => {
    process.env.VAULT_ADDR = 'http://127.0.0.1:1'
    process.env.VAULT_TOKEN = 'test-token'
    const { encrypt } = await import('../src/security/encryption.js')

    await assert.rejects(
      encrypt('mfa-secret-456', 'xorganam-authenticator-mfa-v1:TENANT:demo-user-2'),
      /Vault transit request failed/
    )
  })
})
