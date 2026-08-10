import axios from 'axios'
import { env } from '../config/env.js'

/**
 * Thin client for HashiCorp Vault's Transit secrets engine. This is the
 * L1 "Master Root Key" layer of the envelope encryption hierarchy - the
 * actual master key material lives inside Vault and never leaves it.
 * This module only ever sends/receives already-wrapped ciphertext or
 * short-lived plaintext DEKs, never the master key itself.
 *
 * Auth: prefers AppRole (VAULT_ROLE_ID / VAULT_SECRET_ID), falls back to
 * a static token (VAULT_TOKEN) for local dev. Tokens are cached and
 * renewed lazily; nothing is written to disk or logged.
 */

function requireVaultConfig() {
  const addr = process.env.VAULT_ADDR
  if (!addr) throw new Error('Missing required environment variable: VAULT_ADDR')
  return addr
}

const transitMount = process.env.VAULT_TRANSIT_MOUNT || 'transit'
const transitKeyName = process.env.VAULT_TRANSIT_KEY || 'master-key'

let cachedToken = null
let cachedTokenExpiresAt = 0

async function loginWithAppRole(addr) {
  const roleId = process.env.VAULT_ROLE_ID
  const secretId = process.env.VAULT_SECRET_ID
  if (!roleId || !secretId) return null

  const { data } = await axios.post(`${addr}/v1/auth/approle/login`, {
    role_id: roleId,
    secret_id: secretId
  })

  const leaseSeconds = data?.auth?.lease_duration || 0
  cachedToken = data.auth.client_token
  // Refresh a little before actual expiry to avoid races on long calls.
  cachedTokenExpiresAt = leaseSeconds ? Date.now() + (leaseSeconds - 30) * 1000 : 0
  return cachedToken
}

async function getVaultToken(addr) {
  if (cachedToken && (cachedTokenExpiresAt === 0 || Date.now() < cachedTokenExpiresAt)) {
    return cachedToken
  }

  const viaAppRole = await loginWithAppRole(addr)
  if (viaAppRole) return viaAppRole

  // Local/dev fallback - never use a static root token in production.
  const staticToken = process.env.VAULT_TOKEN
  if (staticToken) return staticToken

  throw new Error('Vault auth not configured: set VAULT_ROLE_ID/VAULT_SECRET_ID or VAULT_TOKEN.')
}

async function vaultRequest(path, body) {
  const addr = requireVaultConfig()
  const token = await getVaultToken(addr)

  try {
    const { data } = await axios.post(`${addr}/v1/${path}`, body, {
      headers: { 'X-Vault-Token': token },
      timeout: 5000
    })
    return data.data
  } catch (error) {
    // Never let a raw Vault error (which can echo back request context)
    // bubble up to a client response - just surface a generic failure.
    const status = error.response?.status
    if (status === 403) {
      cachedToken = null // token may have been revoked; force re-auth next call
    }
    throw new Error(`Vault transit request failed (${path}): ${status || error.message}`)
  }
}

/**
 * Wraps a base64-encoded DEK under the Vault-managed master key.
 * `context` (base64) scopes the encryption to a tenant when the Transit
 * key has `derived: true`, so tenant A's wrapped DEK can never be
 * unwrapped as if it were tenant B's, even under the same Transit key.
 */
export async function wrapDek(dekBase64, contextBase64) {
  const body = { plaintext: dekBase64 }
  if (contextBase64) body.context = contextBase64
  const result = await vaultRequest(`${transitMount}/encrypt/${transitKeyName}`, body)
  return result.ciphertext // e.g. "vault:v1:AbCdEf..."
}

export async function unwrapDek(wrappedDek, contextBase64) {
  const body = { ciphertext: wrappedDek }
  if (contextBase64) body.context = contextBase64
  const result = await vaultRequest(`${transitMount}/decrypt/${transitKeyName}`, body)
  return result.plaintext // base64 DEK
}

/** Re-wraps ciphertext to the latest Transit key version without ever
 * exposing plaintext to the application - used for L1 master key rotation. */
export async function rewrapDek(wrappedDek, contextBase64) {
  const body = { ciphertext: wrappedDek }
  if (contextBase64) body.context = contextBase64
  const result = await vaultRequest(`${transitMount}/rewrap/${transitKeyName}`, body)
  return result.ciphertext
}

export async function rotateMasterKey() {
  await vaultRequest(`${transitMount}/keys/${transitKeyName}/rotate`, {})
}
