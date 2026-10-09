import crypto from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

function assertTenantId(tenantId) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new TypeError('A tenant ID is required for email secret encryption.')
  }
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError('Tenant email encryption keys must be 32-byte buffers.')
  }
}

function assertSecrets(secrets) {
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
    throw new TypeError('Email provider secrets must be a JSON object.')
  }
}

export function parseTenantEmailKeyring(environment = process.env) {
  const problems = []
  const encodedKeys = environment.TENANT_EMAIL_ENCRYPTION_KEYS
  const activeVersionText = environment.TENANT_EMAIL_ACTIVE_KEY_VERSION
  const keys = new Map()

  if (!encodedKeys) {
    problems.push('TENANT_EMAIL_ENCRYPTION_KEYS is missing')
  } else {
    for (const entry of encodedKeys.split(',')) {
      const match = /^(\d+):([A-Za-z0-9+/]+={0,2})$/.exec(entry.trim())
      if (!match) {
        problems.push('TENANT_EMAIL_ENCRYPTION_KEYS must contain comma-separated version:base64 entries')
        break
      }
      const version = Number(match[1])
      const key = Buffer.from(match[2], 'base64')
      if (!Number.isSafeInteger(version) || version < 1 || key.length !== KEY_BYTES || key.toString('base64') !== match[2]) {
        problems.push(`TENANT_EMAIL_ENCRYPTION_KEYS contains an invalid 32-byte key for version ${match[1]}`)
        continue
      }
      if (keys.has(version)) problems.push(`TENANT_EMAIL_ENCRYPTION_KEYS repeats key version ${version}`)
      keys.set(version, key)
    }
  }

  const activeVersion = Number(activeVersionText)
  if (!/^\d+$/.test(activeVersionText || '') || !Number.isSafeInteger(activeVersion) || activeVersion < 1) {
    problems.push('TENANT_EMAIL_ACTIVE_KEY_VERSION must be a positive integer')
  } else if (!keys.has(activeVersion)) {
    problems.push(`TENANT_EMAIL_ACTIVE_KEY_VERSION ${activeVersion} is not present in TENANT_EMAIL_ENCRYPTION_KEYS`)
  }

  if (problems.length) {
    throw new Error(`Tenant email encryption configuration is invalid:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
  }
  return { activeVersion, keys }
}

export function encryptTenantEmailSecrets(tenantId, secrets, { activeVersion, keys }) {
  assertTenantId(tenantId)
  assertSecrets(secrets)
  const key = keys?.get(activeVersion)
  assertKey(key)

  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(tenantId, 'utf8'))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secrets), 'utf8'),
    cipher.final()
  ])
  return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), keyVersion: activeVersion }
}

export function decryptTenantEmailSecrets(tenantId, ciphertext, keyVersion, keys) {
  assertTenantId(tenantId)
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length <= IV_BYTES + TAG_BYTES) {
    throw new TypeError('Encrypted tenant email secrets have an invalid format.')
  }
  const key = keys?.get(keyVersion)
  assertKey(key)

  const iv = ciphertext.subarray(0, IV_BYTES)
  const tag = ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const encrypted = ciphertext.subarray(IV_BYTES + TAG_BYTES)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAAD(Buffer.from(tenantId, 'utf8'))
  decipher.setAuthTag(tag)

  let plaintext
  try {
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
    const secrets = JSON.parse(plaintext.toString('utf8'))
    assertSecrets(secrets)
    return secrets
  } catch {
    throw new Error('Tenant email secrets could not be authenticated or decoded.')
  } finally {
    plaintext?.fill(0)
  }
}

export function rotateTenantEmailSecrets(tenantId, ciphertext, oldVersion, keyring) {
  const secrets = decryptTenantEmailSecrets(tenantId, ciphertext, oldVersion, keyring.keys)
  return encryptTenantEmailSecrets(tenantId, secrets, keyring)
}