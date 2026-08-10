import crypto from 'node:crypto'
import { env } from '../config/env.js'
import { wrapDek, unwrapDek } from './vaultClient.js'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // recommended for GCM
const AUTH_TAG_LENGTH = 16
const DEK_LENGTH = 32 // AES-256
const ENVELOPE_PREFIX = 'vlt1:' // Vault-wrapped envelope, format version 1

/**
 * Legacy (pre-Vault) key derivation: a single key derived from a static
 * master key + tenant salt, no per-secret DEK. Kept ONLY so existing rows
 * encrypted before the Vault migration can still be decrypted - never
 * used for new writes. See decryptLegacyFormat() below.
 */
function deriveLegacyKey(tenantSalt) {
  return crypto.scryptSync(env.encryptionMasterKey, tenantSalt, 32)
}

function zeroize(...buffers) {
  for (const buf of buffers) {
    if (Buffer.isBuffer(buf)) buf.fill(0)
  }
}

function isValidBase64(payload) {
  if (typeof payload !== 'string') return false
  const normalized = payload.trim()
  if (!normalized) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return false
  return Buffer.from(normalized, 'base64').toString('base64') === normalized.replace(/\s+/g, '')
}

/**
 * Envelope encryption (current scheme):
 *   1. Generate a random 256-bit DEK per call.
 *   2. Encrypt the plaintext with the DEK (AES-256-GCM).
 *   3. Wrap the DEK with HashiCorp Vault Transit (the L1 master key,
 *      which never leaves Vault) - scoped to this tenant via `context`
 *      derivation, so a wrapped DEK can't be unwrapped for another tenant.
 *   4. Store only the wrapped DEK + ciphertext + nonce/tag. The plaintext
 *      DEK exists in app memory only for the instant it's needed, then
 *      is zeroized.
 *
 * @param {string} plainText
 * @param {string} tenantSalt tenants.api_key_salt for the owning tenant
 * @returns {Promise<string|null>} opaque envelope string safe to store as-is
 */
export async function encrypt(plainText, tenantSalt) {
  if (plainText === null || plainText === undefined) return null

  const dek = crypto.randomBytes(DEK_LENGTH)
  const iv = crypto.randomBytes(IV_LENGTH)

  let ciphertext, authTag, wrappedDek
  try {
    const cipher = crypto.createCipheriv(ALGORITHM, dek, iv)
    ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()])
    authTag = cipher.getAuthTag()

    const context = Buffer.from(tenantSalt, 'utf8').toString('base64')
    wrappedDek = await wrapDek(dek.toString('base64'), context)
  } finally {
    zeroize(dek)
  }

  const envelope = {
    v: 1,
    dek: wrappedDek,
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    ct: ciphertext.toString('base64')
  }

  return ENVELOPE_PREFIX + Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')
}

async function decryptEnvelope(payload, tenantSalt) {
  const json = Buffer.from(payload.slice(ENVELOPE_PREFIX.length), 'base64').toString('utf8')
  const envelope = JSON.parse(json)

  const context = Buffer.from(tenantSalt, 'utf8').toString('base64')
  const dekBase64 = await unwrapDek(envelope.dek, context)
  const dek = Buffer.from(dekBase64, 'base64')

  try {
    const iv = Buffer.from(envelope.iv, 'base64')
    const authTag = Buffer.from(envelope.tag, 'base64')
    const ciphertext = Buffer.from(envelope.ct, 'base64')

    const decipher = crypto.createDecipheriv(ALGORITHM, dek, iv)
    decipher.setAuthTag(authTag)

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const result = plaintext.toString('utf8')
    zeroize(plaintext)
    return result
  } finally {
    zeroize(dek)
  }
}

/** Decrypts rows written before the Vault envelope migration. Read-only path. */
function decryptLegacyFormat(payload, tenantSalt) {
  if (!isValidBase64(payload)) return payload

  const raw = Buffer.from(payload, 'base64')
  if (raw.length <= IV_LENGTH + AUTH_TAG_LENGTH) return payload

  const key = deriveLegacyKey(tenantSalt)
  try {
    const iv = raw.subarray(0, IV_LENGTH)
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
    const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } finally {
    zeroize(key)
  }
}

/**
 * @param {string} payload envelope produced by encrypt(), or a legacy
 *   pre-Vault payload for rows not yet re-saved since the migration
 * @param {string} tenantSalt tenants.api_key_salt for the owning tenant
 * @returns {Promise<string|null>}
 */
export async function decrypt(payload, tenantSalt) {
  if (!payload) return null

  try {
    if (payload.startsWith(ENVELOPE_PREFIX)) {
      return await decryptEnvelope(payload, tenantSalt)
    }
    return decryptLegacyFormat(payload, tenantSalt)
  } catch (error) {
    return payload
  }
}

/**
 * Constant-time comparison for webhook signature verification - never use
 * === or plain string comparison for this, it leaks timing information
 * an attacker can use to guess a valid signature byte-by-byte.
 */
export function timingSafeEqualHex(hexA, hexB) {
  const a = Buffer.from(hexA || '', 'hex')
  const b = Buffer.from(hexB || '', 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function hmacSha256Hex(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}
