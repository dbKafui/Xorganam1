import 'dotenv/config'
import { query } from './src/db/pool.js'
import { encrypt } from './src/security/encryption.js'
import { initiateCollection } from './src/services/collectionService.js'

async function run() {
  const merchantId = '96595d2f-1eda-44c9-9ff2-8d8dc1f50a7d'
  const payload = { amount: 1, msisdn: '0547620052' }
  const apiUsernamePlain = 'GH02339a5f25650bfc4f4590bed81fe73d458a'
  const apiPasswordPlain = 'a812944ea64444d1c2b18b1811432ccfad5759a83bd5442c2ae9c60e1fcc2d0b'
  const xAuthPlain = 'GH0233R0gwMjMzOWE1ZjI1NjUwYmZjNGY0NTkwYmVkODFmZTczZDQ1OGE6YTgxMjk0NGVhNjQ0NDJjMmFlOWM2MGUxZmNjMmQwYg=='
  const eganowBaseUrl = 'https://developer.deveganowapi.com'
  const webhookSecretPlain = 'test-webhook-secret'

  const mRes = await query('SELECT tenant_id FROM merchants WHERE id = $1', [merchantId])
  const tenantId = mRes.rows[0].tenant_id
  const tRes = await query('SELECT api_key_salt FROM tenants WHERE id = $1', [tenantId])
  const apiKeySalt = tRes.rows[0].api_key_salt

  const usernameEnc = encrypt(apiUsernamePlain, apiKeySalt)
  const passwordEnc = encrypt(apiPasswordPlain, apiKeySalt)
  const xAuthEnc = encrypt(xAuthPlain, apiKeySalt)
  const webhookEnc = encrypt(webhookSecretPlain, apiKeySalt)

  await query(
    `INSERT INTO tenant_eganow_credentials (tenant_id, eganow_api_key_encrypted, eganow_client_secret_encrypted, eganow_access_token_encrypted, webhook_secret_encrypted, eganow_base_url, eganow_merchant_code, eganow_callback_url, is_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
     ON CONFLICT (tenant_id) DO UPDATE SET
       eganow_api_key_encrypted = COALESCE($2, tenant_eganow_credentials.eganow_api_key_encrypted),
       eganow_client_secret_encrypted = COALESCE($3, tenant_eganow_credentials.eganow_client_secret_encrypted),
       eganow_access_token_encrypted = COALESCE($4, tenant_eganow_credentials.eganow_access_token_encrypted),
       webhook_secret_encrypted = COALESCE($5, tenant_eganow_credentials.webhook_secret_encrypted),
       eganow_base_url = COALESCE($6, tenant_eganow_credentials.eganow_base_url),
       eganow_merchant_code = COALESCE($7, tenant_eganow_credentials.eganow_merchant_code),
       eganow_callback_url = COALESCE($8, tenant_eganow_credentials.eganow_callback_url),
       is_enabled = TRUE`,
    [tenantId, usernameEnc, passwordEnc, xAuthEnc, webhookEnc, eganowBaseUrl, 'TEST_SERVICE', 'https://webhook.site/6063bf1e-9146-442d-a9ab-1f669f649b96?id=6f9e4799-9907-4a52-8284-d8a0a5053e32&vscodeBrowserReqId=1784143299338']
  )

  console.log('Credentials updated; running collection without explicit network...')
  const result = await initiateCollection(merchantId, payload)
  console.log(JSON.stringify(result, null, 2))
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
