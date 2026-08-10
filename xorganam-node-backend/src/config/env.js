import 'dotenv/config'

function required(name) {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export const env = {
  port: parseInt(process.env.PORT || '3000', 10),

  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  database: {
    connectionString: required('DATABASE_URL')
  },

  redis: {
    url: required('REDIS_URL')
  },

  // Legacy master key, used only to DECRYPT credential rows that were
  // encrypted before the HashiCorp Vault Transit migration (see
  // src/security/encryption.js). New writes no longer use this - the L1
  // master key now lives in Vault Transit and never enters app memory.
  // Configure Vault via VAULT_ADDR + (VAULT_ROLE_ID/VAULT_SECRET_ID or
  // VAULT_TOKEN for local dev) + VAULT_TRANSIT_MOUNT/VAULT_TRANSIT_KEY;
  // these are read directly from process.env in vaultClient.js so this
  // module can still load in contexts (e.g. tests) that don't set them.
  encryptionMasterKey: required('ENCRYPTION_MASTER_KEY'),

  jwt: {
    secret: required('JWT_SECRET')
  },

  sms: {
    gatewayBaseUrl: process.env.SMS_GATEWAY_BASE_URL || 'https://api.smsgateway.example.com/',
    defaultSenderId: process.env.SMS_DEFAULT_SENDER_ID || 'XORGANAM'
  },

  // Eganow callbacks must be configured per-tenant in the DB. Do not
  // provide a global env-level callback URL to avoid accidental fallbacks.
}
