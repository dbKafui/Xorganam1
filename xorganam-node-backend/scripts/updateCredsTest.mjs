import {env} from './src/config/env.js';
import {query} from './src/db/pool.js';
import {encrypt} from './src/security/encryption.js';

const credsId = process.env.EGANOW_TEST_CREDENTIALS_ID || 'c6708315-544a-42de-80c6-9f1794dca840';
const tenantId = process.env.EGANOW_TEST_TENANT_ID || '8dd3ca13-c813-47c7-9444-c35c2b20539a';
const apiUsername = process.env.EGANOW_TEST_API_USERNAME || '';
const apiPassword = process.env.EGANOW_TEST_API_PASSWORD || '';
const xAuth = process.env.EGANOW_TEST_XAUTH || '';

if (!apiUsername || !apiPassword || !xAuth) {
  console.error('Missing EGANOW_TEST_API_USERNAME, EGANOW_TEST_API_PASSWORD, or EGANOW_TEST_XAUTH environment variables.')
  process.exit(1)
}

const tenantRows = await query('SELECT api_key_salt FROM tenants WHERE id = $1', [tenantId]);
const salt = tenantRows.rows[0].api_key_salt;

const encApiUsername = encrypt(apiUsername, salt);
const encApiPassword = encrypt(apiPassword, salt);
const encXAuth = encrypt(xAuth, salt);

await query(
  'UPDATE tenant_eganow_credentials SET eganow_api_key_encrypted = $2, eganow_client_secret_encrypted = $3, eganow_access_token_encrypted = $4, updated_at = now() WHERE id = $1',
  [credsId, encApiUsername, encApiPassword, encXAuth]
);
console.log('Credentials updated successfully');
process.exit(0);
