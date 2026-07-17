import 'dotenv/config'
import { query } from './src/db/pool.js'
import { encrypt } from './src/security/encryption.js'
import { initiateCollection } from './src/services/collectionService.js'

async function run() {
  try {
    const merchantId = '96595d2f-1eda-44c9-9ff2-8d8dc1f50a7d'
    const payload = { amount: 1, msisdn: '233547620052', network: 'MTN' }

    // Credentials from user
    const apiUsernamePlain = 'GH02339a5f25650bfc4f4590bed81fe73d458a'
    const apiPasswordPlain = 'a812944ea64444d1c2b18b1811432ccfad5759a83bd5442c2ae9c60e1fcc2d0b'
    const xAuthPlain = 'GH0233R0gwMjMzOWE1ZjI1NjUwYmZjNGY0NTkwYmVkODFmZTczZDQ1OGE6YTgxMjk0NGVhNjQ0NDJjMmFlOWM2MGUxZmNjMmQwYg=='
    const eganowBaseUrl = 'https://developer.deveganowapi.com'
    const webhookSecretPlain = 'test-webhook-secret'

    console.log('Finding tenant for merchant', merchantId)
    const mRes = await query('SELECT tenant_id FROM merchants WHERE id = $1', [merchantId])
    if (mRes.rows.length === 0) throw new Error('Merchant not found')
    const tenantId = mRes.rows[0].tenant_id
    console.log('Tenant:', tenantId)

    const tRes = await query('SELECT api_key_salt FROM tenants WHERE id = $1', [tenantId])
    if (tRes.rows.length === 0) throw new Error('Tenant not found')
    const apiKeySalt = tRes.rows[0].api_key_salt

    console.log('Encrypting credentials and updating tenant_eganow_credentials...')
    const usernameEnc = encrypt(apiUsernamePlain, apiKeySalt)
    const passwordEnc = encrypt(apiPasswordPlain, apiKeySalt)
    const xAuthEnc = encrypt(xAuthPlain, apiKeySalt)
    const webhookEnc = encrypt(webhookSecretPlain, apiKeySalt)

    // Upsert credentials
    await query(
      `INSERT INTO tenant_eganow_credentials (tenant_id, eganow_api_key_encrypted, eganow_client_secret_encrypted, eganow_access_token_encrypted, webhook_secret_encrypted, eganow_base_url, eganow_merchant_code, is_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       ON CONFLICT (tenant_id) DO UPDATE SET
         eganow_api_key_encrypted = COALESCE($2, tenant_eganow_credentials.eganow_api_key_encrypted),
         eganow_client_secret_encrypted = COALESCE($3, tenant_eganow_credentials.eganow_client_secret_encrypted),
         eganow_access_token_encrypted = COALESCE($4, tenant_eganow_credentials.eganow_access_token_encrypted),
         webhook_secret_encrypted = COALESCE($5, tenant_eganow_credentials.webhook_secret_encrypted),
         eganow_base_url = COALESCE($6, tenant_eganow_credentials.eganow_base_url),
         eganow_merchant_code = COALESCE($7, tenant_eganow_credentials.eganow_merchant_code),
         is_enabled = TRUE`,
      [tenantId, usernameEnc, passwordEnc, xAuthEnc, webhookEnc, eganowBaseUrl, 'TEST_SERVICE']
    )

    console.log('Credentials updated; running collection...')
    const result = await initiateCollection(merchantId, payload)
    console.log('initiateCollection result:\n', JSON.stringify(result, null, 2))
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err)
    if (err && err.response && err.response.data) console.error('Response data:', err.response.data)
    process.exitCode = 1
  }
}

run()
