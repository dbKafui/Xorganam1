import 'dotenv/config'
import { query } from './src/db/pool.js'
import { encrypt } from './src/security/encryption.js'
import crypto from 'crypto'

const ENCRYPTION_MASTER_KEY = process.env.ENCRYPTION_MASTER_KEY
if (!ENCRYPTION_MASTER_KEY) {
  console.error('ENCRYPTION_MASTER_KEY not set')
  process.exit(1)
}

async function setup() {
  try {
    const tenantId = crypto.randomUUID()
    const apiKeySalt = crypto.randomBytes(32).toString('hex')
    
    const tenantRes = await query(
      `INSERT INTO tenants (id, company_name, contact_phone, contact_email, api_key_salt, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [tenantId, 'Eganow Test Tenant', '233547620052', 'test@eganow.com', apiKeySalt, 'ACTIVE']
    )
    
    const testTenantId = tenantRes.rows[0].id
    console.log('Test tenant created:', testTenantId)

    const username = process.env.EGANOW_TEST_API_USERNAME || ''
    const password = process.env.EGANOW_TEST_API_PASSWORD || ''
    const xAuth = process.env.EGANOW_TEST_XAUTH || ''
    const webhookSecret = process.env.EGANOW_TEST_WEBHOOK_SECRET || 'test-webhook-secret-12345'
    const eganowBaseUrl = process.env.EGANOW_TEST_BASE_URL || ''

    if (!username || !password || !xAuth || !egnowBaseUrl) {
      console.error('Missing Eganow test configuration. Set EGANOW_TEST_API_USERNAME, EGANOW_TEST_API_PASSWORD, EGANOW_TEST_XAUTH, and EGANOW_TEST_BASE_URL.')
      process.exit(1)
    }

    const usernameEnc = encrypt(username, apiKeySalt)
    const passwordEnc = encrypt(password, apiKeySalt)
    const xAuthEnc = encrypt(xAuth, apiKeySalt)
    const webhookEnc = encrypt(webhookSecret, apiKeySalt)

    await query(
      `INSERT INTO tenant_eganow_credentials (tenant_id, eganow_api_key_encrypted, eganow_client_secret_encrypted, eganow_access_token_encrypted, webhook_secret_encrypted, eganow_base_url, eganow_merchant_code, is_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
      [testTenantId, usernameEnc, passwordEnc, xAuthEnc, webhookEnc, eganowBaseUrl, 'TEST_SERVICE']
    )
    console.log('Eganow credentials configured')

    const merchantId = '96595d2f-1eda-44c9-9ff2-8d8dc1f50a7d'
    await query(
      `INSERT INTO merchants (id, tenant_id, display_name, mobile_money_number, network_provider, eganow_collection_account_id, eganow_payout_account_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
      [merchantId, testTenantId, 'Test Merchant', '233547620052', 'MTNGH', 'COLLECTION-001', 'PAYOUT-001']
    )
    console.log('Test merchant created:', merchantId)
    console.log('\n✓ Setup complete')
    console.log('Tenant ID:', testTenantId)
    console.log('Merchant ID:', merchantId)
    process.exit(0)
  } catch (err) {
    console.error('Setup error:', err.message)
    process.exit(1)
  }
}

setup()
