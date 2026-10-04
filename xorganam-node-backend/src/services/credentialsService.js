import { query } from '../db/pool.js'
import { decrypt } from '../security/encryption.js'

/**
 * Custom error type so callers (webhook route, worker) can distinguish
 * "this tenant's credentials are missing/invalid" from a generic DB error,
 * without ever including which specific field was wrong in any response
 * that could reach the client.
 */
export class TenantCredentialsError extends Error {
  constructor(message, tenantId) {
    super(message)
    this.name = 'TenantCredentialsError'
    this.tenantId = tenantId
  }
}

export class InstitutionCredentialsError extends Error {
  constructor(message, institutionId) {
    super(message)
    this.name = 'InstitutionCredentialsError'
    this.institutionId = institutionId
  }
}

export async function getInstitutionEganowContext(institutionId) {
  const { rows } = await query(
    `SELECT i.id AS institution_id, i.name, i.api_key_salt, i.eganow_collection_account_id,
            i.eganow_payout_account_id, i.eganow_network_provider,
            c.api_username_encrypted, c.api_password_encrypted, c.x_auth_encrypted,
            c.eganow_base_url, c.callback_url, c.is_enabled
       FROM institutions i JOIN institution_eganow_credentials c ON c.institution_id = i.id
      WHERE i.id = $1 AND i.status = 'ACTIVE'`, [institutionId]
  )
  if (!rows.length || !rows[0].is_enabled) throw new InstitutionCredentialsError('Institution Eganow provisioning is not active.', institutionId)
  const row = rows[0]
  const [apiUsername, apiPassword, xAuth] = await Promise.all([
    decrypt(row.api_username_encrypted, row.api_key_salt),
    decrypt(row.api_password_encrypted, row.api_key_salt),
    decrypt(row.x_auth_encrypted, row.api_key_salt)
  ])
  if (!apiUsername || !apiPassword || !xAuth || !row.eganow_collection_account_id || !row.eganow_payout_account_id || !row.callback_url) {
    throw new InstitutionCredentialsError('Institution Eganow provisioning is incomplete.', institutionId)
  }
  return {
    institutionId: row.institution_id, institutionName: row.name, apiUsername, apiPassword, xAuth,
    baseUrl: row.eganow_base_url, callbackUrl: row.callback_url,
    collectionAccountId: row.eganow_collection_account_id, payoutAccountId: row.eganow_payout_account_id,
    networkProvider: row.eganow_network_provider
  }
}

/**
 * Loads and decrypts everything needed to call Eganow / verify webhooks
 * on behalf of a single tenant. Every field here is tenant-scoped -
 * nothing is ever cached globally or shared across tenants.
 */
export async function getTenantEganowContext(tenantId) {
  const { rows } = await query(
    `SELECT t.id                              AS tenant_id,
            t.company_name,
            t.status,
            t.api_key_salt,
            c.eganow_api_key_encrypted,
            c.eganow_client_secret_encrypted,
            c.eganow_access_token_encrypted,
              c.eganow_base_url,
              c.eganow_callback_url,
            c.webhook_secret_encrypted,
            c.eganow_merchant_code
       FROM tenants t
       JOIN tenant_eganow_credentials c ON c.tenant_id = t.id
      WHERE t.id = $1`,
    [tenantId]
  )

  if (rows.length === 0) {
    throw new TenantCredentialsError('Tenant credentials not found.', tenantId)
  }

  const row = rows[0]

  if (row.status !== 'ACTIVE') {
    throw new TenantCredentialsError(`Tenant is not ACTIVE (status=${row.status}).`, tenantId)
  }

  // Decrypt once per unique ciphertext (not once per field) so a
  // credential set with N legacy-named aliases only costs one Vault
  // unwrap call each, not N.
  const [apiUsername, apiPassword, xAuth, webhookSecret] = await Promise.all([
    decrypt(row.eganow_api_key_encrypted, row.api_key_salt),
    decrypt(row.eganow_client_secret_encrypted, row.api_key_salt),
    row.eganow_access_token_encrypted ? decrypt(row.eganow_access_token_encrypted, row.api_key_salt) : null,
    decrypt(row.webhook_secret_encrypted, row.api_key_salt)
  ])

  return {
    tenantId: row.tenant_id,
    companyName: row.company_name,
    baseUrl: row.eganow_base_url,
    callbackUrl: row.eganow_callback_url || null,
    serviceName: row.eganow_merchant_code,
    apiUsername,
    apiPassword,
    xAuth,
    webhookSecret,
    // Backwards compatibility for any callers still using legacy names
    secretUsername: apiUsername,
    secretPassword: apiPassword,
    apiKey: apiUsername,
    clientSecret: apiPassword,
    accessToken: xAuth,
    merchantCode: row.eganow_merchant_code
  }
}

/**
 * Lighter lookup used purely for webhook signature verification, where we
 * don't need the full Eganow API credential set - just the webhook secret.
 */
export async function getTenantWebhookSecret(tenantId) {
  const { rows } = await query(
    `SELECT t.api_key_salt, c.webhook_secret_encrypted
       FROM tenants t
       JOIN tenant_eganow_credentials c ON c.tenant_id = t.id
      WHERE t.id = $1`,
    [tenantId]
  )

  if (rows.length === 0) {
    throw new TenantCredentialsError('Tenant credentials not found.', tenantId)
  }

  return await decrypt(rows[0].webhook_secret_encrypted, rows[0].api_key_salt)
}
