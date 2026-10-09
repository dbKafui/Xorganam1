import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { describe, it } from 'node:test'
import {
  decryptTenantEmailSecrets,
  encryptTenantEmailSecrets,
  parseTenantEmailKeyring,
  rotateTenantEmailSecrets
} from '../src/security/tenantEmailConfigCrypto.js'

function encodedKey() {
  return crypto.randomBytes(32).toString('base64')
}

describe('tenant email config encryption', () => {
  it('round trips secrets with tenant-bound authenticated encryption', () => {
    const keyring = parseTenantEmailKeyring({
      TENANT_EMAIL_ENCRYPTION_KEYS: `1:${encodedKey()}`,
      TENANT_EMAIL_ACTIVE_KEY_VERSION: '1'
    })
    const payload = encryptTenantEmailSecrets('tenant-a', { apiKey: 'provider-secret' }, keyring)

    assert.deepEqual(decryptTenantEmailSecrets('tenant-a', payload.ciphertext, payload.keyVersion, keyring.keys), {
      apiKey: 'provider-secret'
    })
    assert.throws(() => decryptTenantEmailSecrets('tenant-b', payload.ciphertext, payload.keyVersion, keyring.keys), /authenticated or decoded/)
  })

  it('rejects ciphertext tampering', () => {
    const keyring = parseTenantEmailKeyring({
      TENANT_EMAIL_ENCRYPTION_KEYS: `1:${encodedKey()}`,
      TENANT_EMAIL_ACTIVE_KEY_VERSION: '1'
    })
    const payload = encryptTenantEmailSecrets('tenant-a', { password: 'secret' }, keyring)
    const corrupted = Buffer.from(payload.ciphertext)
    corrupted[corrupted.length - 1] ^= 1

    assert.throws(() => decryptTenantEmailSecrets('tenant-a', corrupted, payload.keyVersion, keyring.keys), /authenticated or decoded/)
  })

  it('rotates old secrets using the active key while retaining old key versions', () => {
    const oldKey = encodedKey()
    const activeKey = encodedKey()
    const keyring = parseTenantEmailKeyring({
      TENANT_EMAIL_ENCRYPTION_KEYS: `1:${oldKey},2:${activeKey}`,
      TENANT_EMAIL_ACTIVE_KEY_VERSION: '2'
    })
    const oldPayload = encryptTenantEmailSecrets('tenant-a', { token: 'secret' }, {
      activeVersion: 1,
      keys: new Map([[1, Buffer.from(oldKey, 'base64')]])
    })
    const rotated = rotateTenantEmailSecrets('tenant-a', oldPayload.ciphertext, 1, keyring)

    assert.equal(rotated.keyVersion, 2)
    assert.deepEqual(decryptTenantEmailSecrets('tenant-a', rotated.ciphertext, rotated.keyVersion, keyring.keys), { token: 'secret' })
  })

  it('reports missing or inconsistent keyring settings precisely', () => {
    assert.throws(() => parseTenantEmailKeyring({}), /TENANT_EMAIL_ENCRYPTION_KEYS is missing[\s\S]*TENANT_EMAIL_ACTIVE_KEY_VERSION/)
    assert.throws(() => parseTenantEmailKeyring({
      TENANT_EMAIL_ENCRYPTION_KEYS: `1:${encodedKey()}`,
      TENANT_EMAIL_ACTIVE_KEY_VERSION: '2'
    }), /is not present in TENANT_EMAIL_ENCRYPTION_KEYS/)
  })
})