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

  // Master key for the application-layer AES-256-GCM envelope encryption
  // used on tenant_eganow_credentials.*. In production this should come
  // from a secrets manager (AWS KMS / Vault / etc), not a plain env var.
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
