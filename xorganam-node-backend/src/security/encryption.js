import crypto from 'node:crypto'
import { env } from '../config/env.js'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // recommended for GCM
const AUTH_TAG_LENGTH = 16

/**
 * Derives a 32-byte key from the master key + a tenant-specific salt
 * (tenants.api_key_salt), so a leaked master key alone still isn't
 * enough without also having each tenant's salt from the database -
 * and so tenant A's decrypted secrets never share a key with tenant B's.
 */
function deriveKey(tenantSalt) {
  return crypto.scryptSync(env.encryptionMasterKey, tenantSalt, 32)
}

/**
 * @param {string} plainText
 * @param {string} tenantSalt tenants.api_key_salt for the owning tenant
 * @returns {string} base64 payload: iv + authTag + ciphertext
 */
export function encrypt(plainText, tenantSalt) {
  if (plainText === null || plainText === undefined) return null

  const key = deriveKey(tenantSalt)
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

  const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return Buffer.concat([iv, authTag, ciphertext]).toString('base64')
}

/**
 * @param {string} payload base64 payload produced by encrypt()
 * @param {string} tenantSalt tenants.api_key_salt for the owning tenant
 * @returns {string|null}
 */
function isValidBase64(payload) {
  if (typeof payload !== 'string') return false
  const normalized = payload.trim()
  if (!normalized) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return false
  return Buffer.from(normalized, 'base64').toString('base64') === normalized.replace(/\s+/g, '')
}

export function decrypt(payload, tenantSalt) {
  if (!payload) return null

  if (!isValidBase64(payload)) {
    return payload
  }

  try {
    const raw = Buffer.from(payload, 'base64')
    if (raw.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
      return payload
    }

    const key = deriveKey(tenantSalt)
    const iv = raw.subarray(0, IV_LENGTH)
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
    const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
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
