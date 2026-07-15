import 'dotenv/config'

function required(name, fallback) {
  const value = process.env[name] ?? fallback
  if (value === undefined) {
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
    connectionString: required('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/xorganam')
  },

  redis: {
    url: required('REDIS_URL', 'redis://localhost:6379')
  },

  // Master key for the application-layer AES-256-GCM envelope encryption
  // used on tenant_eganow_credentials.*. In production this should come
  // from a secrets manager (AWS KMS / Vault / etc), not a plain env var.
  encryptionMasterKey: required('ENCRYPTION_MASTER_KEY'),

  jwt: {
    secret: required('JWT_SECRET', 'replace-with-a-long-random-secret-never-commit-this')
  },

  sms: {
    gatewayBaseUrl: process.env.SMS_GATEWAY_BASE_URL || 'https://api.smsgateway.example.com/',
    defaultSenderId: process.env.SMS_DEFAULT_SENDER_ID || 'XORGANAM'
  }

  ,eganow: {
    callbackUrl: process.env.EGANOW_CALLBACK_URL || null
  }
}
