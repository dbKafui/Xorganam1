import { EMAIL_PROVIDER_DESCRIPTORS, isEmailProviderType } from '../email/providerDescriptors.js'

function requiredString(environment, name, problems) {
  const value = String(environment[name] || '').trim()
  if (!value) problems.push(`${name} is missing`)
  return value
}

function positiveInteger(environment, name, problems) {
  const raw = requiredString(environment, name, problems)
  const value = Number(raw)
  if (raw && (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1)) {
    problems.push(`${name} must be a positive integer`)
  }
  return value
}

function csvValues(environment, name, problems) {
  const raw = requiredString(environment, name, problems)
  const values = raw.split(',').map((item) => item.trim()).filter(Boolean)
  if (raw && !values.length) problems.push(`${name} must contain at least one value`)
  return values
}

function parseHttpsUrl(environment, name, problems) {
  const raw = requiredString(environment, name, problems)
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
    return url.toString().replace(/\/$/, '')
  } catch {
    problems.push(`${name} must be a valid HTTPS URL without embedded credentials`)
    return ''
  }
}

export function parseEmailDeliveryPolicy(environment = process.env, nodeEnvironment = environment.NODE_ENV || 'development') {
  const problems = []
  const cacheTtlMs = positiveInteger(environment, 'EMAIL_CACHE_TTL_MS', problems)
  const cacheMaxEntries = positiveInteger(environment, 'EMAIL_CACHE_MAX_ENTRIES', problems)
  const sendTimeoutMs = positiveInteger(environment, 'EMAIL_SEND_TIMEOUT_MS', problems)
  const retryAttempts = positiveInteger(environment, 'EMAIL_SEND_ATTEMPTS', problems)
  const retryBackoffMs = positiveInteger(environment, 'EMAIL_SEND_BACKOFF_BASE_MS', problems)
  const maxAttachmentBytes = positiveInteger(environment, 'EMAIL_MAX_ATTACHMENT_BYTES', problems)
  const maxRecipients = positiveInteger(environment, 'EMAIL_MAX_RECIPIENTS', problems)
  const workerConcurrency = positiveInteger(environment, 'EMAIL_WORKER_CONCURRENCY', problems)
  const deliveryRecordRetentionDays = positiveInteger(environment, 'EMAIL_DELIVERY_RECORD_RETENTION_DAYS', problems)
  const allowedSmtpPorts = csvValues(environment, 'EMAIL_ALLOWED_SMTP_PORTS', problems).map(Number)
  const smtpStartTlsPorts = csvValues(environment, 'EMAIL_SMTP_STARTTLS_PORTS', problems).map(Number)
  const smtpImplicitTlsPort = positiveInteger(environment, 'EMAIL_SMTP_IMPLICIT_TLS_PORT', problems)
  const blockedSmtpCidrs = csvValues(environment, 'EMAIL_BLOCKED_SMTP_CIDRS', problems)
  const smtpEncryptionModes = csvValues(environment, 'EMAIL_SMTP_ENCRYPTION_MODES', problems).map((mode) => mode.toLowerCase())
  const sesRegions = csvValues(environment, 'EMAIL_SES_REGIONS', problems)
  const mailgunRegions = csvValues(environment, 'EMAIL_MAILGUN_REGIONS', problems)
  const providerType = requiredString(environment, 'EMAIL_DEFAULT_PROVIDER', problems).toLowerCase()
  const defaultFromAddress = requiredString(environment, 'EMAIL_DEFAULT_FROM_ADDRESS', problems)
  const defaultFromName = requiredString(environment, 'EMAIL_DEFAULT_FROM_NAME', problems)
  const defaultSecretReference = requiredString(environment, 'EMAIL_DEFAULT_SECRET_REFERENCE', problems)
  const defaultSettingsText = requiredString(environment, 'EMAIL_DEFAULT_SETTINGS_JSON', problems)
  const cacheInvalidationChannel = requiredString(environment, 'EMAIL_CACHE_INVALIDATION_CHANNEL', problems)
  const sendgridApiUrl = parseHttpsUrl(environment, 'EMAIL_SENDGRID_API_URL', problems)
  const mailgunApiBaseUrlsText = requiredString(environment, 'EMAIL_MAILGUN_API_BASE_URLS_JSON', problems)
  let mailgunApiBaseUrls = {}
  let defaultSettings = {}
  let allowInsecureSmtp = false

  if (defaultSettingsText) {
    try {
      defaultSettings = JSON.parse(defaultSettingsText)
      if (!defaultSettings || typeof defaultSettings !== 'object' || Array.isArray(defaultSettings)) {
        problems.push('EMAIL_DEFAULT_SETTINGS_JSON must contain a JSON object')
      }
    } catch {
      problems.push('EMAIL_DEFAULT_SETTINGS_JSON must contain valid JSON')
    }
  }
  if (mailgunApiBaseUrlsText) {
    try {
      const input = JSON.parse(mailgunApiBaseUrlsText)
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        problems.push('EMAIL_MAILGUN_API_BASE_URLS_JSON must contain a JSON object')
      } else {
        mailgunApiBaseUrls = Object.fromEntries(Object.entries(input).map(([region, value]) => {
          const parsed = parseHttpsUrl({ MAILGUN_REGION_URL: value }, 'MAILGUN_REGION_URL', problems)
          return [region, parsed]
        }))
      }
    } catch {
      problems.push('EMAIL_MAILGUN_API_BASE_URLS_JSON must contain valid JSON')
    }
  }
  if (!isEmailProviderType(providerType)) problems.push('EMAIL_DEFAULT_PROVIDER is not a registered email provider type')
  const defaultDescriptor = EMAIL_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.type === providerType)
  for (const field of defaultDescriptor?.fields || []) {
    if (field.required && !field.secret && (defaultSettings[field.key] === undefined || defaultSettings[field.key] === null || defaultSettings[field.key] === '')) {
      problems.push(`EMAIL_DEFAULT_SETTINGS_JSON is missing required provider field ${field.key}`)
    }
  }
  for (const region of mailgunRegions) {
    if (!mailgunApiBaseUrls[region]) problems.push(`EMAIL_MAILGUN_API_BASE_URLS_JSON is missing configured region ${region}`)
  }
  for (const region of Object.keys(mailgunApiBaseUrls)) {
    if (!mailgunRegions.includes(region)) problems.push(`EMAIL_MAILGUN_API_BASE_URLS_JSON contains unconfigured region ${region}`)
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(defaultFromAddress)) problems.push('EMAIL_DEFAULT_FROM_ADDRESS must be a valid email address')
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(defaultSecretReference)) problems.push('EMAIL_DEFAULT_SECRET_REFERENCE must be a Vault key reference')
  if (allowedSmtpPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    problems.push('EMAIL_ALLOWED_SMTP_PORTS must contain valid port numbers')
  }
  if (new Set(allowedSmtpPorts).size !== allowedSmtpPorts.length) problems.push('EMAIL_ALLOWED_SMTP_PORTS must not contain duplicates')
  if (smtpStartTlsPorts.some((port) => !Number.isInteger(port) || !allowedSmtpPorts.includes(port))) {
    problems.push('EMAIL_SMTP_STARTTLS_PORTS must contain only ports in EMAIL_ALLOWED_SMTP_PORTS')
  }
  if (!allowedSmtpPorts.includes(smtpImplicitTlsPort)) problems.push('EMAIL_SMTP_IMPLICIT_TLS_PORT must be in EMAIL_ALLOWED_SMTP_PORTS')
  if (smtpEncryptionModes.some((mode) => !['starttls', 'implicit_tls', 'none'].includes(mode))) {
    problems.push('EMAIL_SMTP_ENCRYPTION_MODES contains an unsupported mode')
  }
  if (providerType === 'smtp') {
    if (!allowedSmtpPorts.includes(Number(defaultSettings.port))) problems.push('EMAIL_DEFAULT_SETTINGS_JSON SMTP port must be in EMAIL_ALLOWED_SMTP_PORTS')
    if (defaultSettings.encryption && !smtpEncryptionModes.includes(String(defaultSettings.encryption).toLowerCase())) {
      problems.push('EMAIL_DEFAULT_SETTINGS_JSON SMTP encryption is not enabled by EMAIL_SMTP_ENCRYPTION_MODES')
    }
  }
  if (providerType === 'ses' && !sesRegions.includes(defaultSettings.region)) {
    problems.push('EMAIL_DEFAULT_SETTINGS_JSON SES region must be in EMAIL_SES_REGIONS')
  }
  if (providerType === 'mailgun' && !mailgunRegions.includes(defaultSettings.region)) {
    problems.push('EMAIL_DEFAULT_SETTINGS_JSON Mailgun region must be in EMAIL_MAILGUN_REGIONS')
  }
  if (nodeEnvironment === 'production' && smtpEncryptionModes.includes('none')) {
    problems.push('EMAIL_SMTP_ENCRYPTION_MODES cannot include none in production')
  }
  const insecureValue = String(environment.EMAIL_SMTP_ALLOW_INSECURE || 'false').toLowerCase()
  if (!['true', 'false'].includes(insecureValue)) problems.push('EMAIL_SMTP_ALLOW_INSECURE must be true or false')
  allowInsecureSmtp = insecureValue === 'true'
  if (nodeEnvironment === 'production' && allowInsecureSmtp) problems.push('EMAIL_SMTP_ALLOW_INSECURE must be false in production')
  if (problems.length) {
    throw new Error(`Tenant email delivery configuration is invalid:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
  }

  return Object.freeze({
    cacheTtlMs,
    cacheMaxEntries,
    sendTimeoutMs,
    retryAttempts,
    retryBackoffMs,
    maxAttachmentBytes,
    maxRecipients,
    workerConcurrency,
    deliveryRecordRetentionDays,
    allowedSmtpPorts,
    smtpStartTlsPorts,
    smtpImplicitTlsPort,
    blockedSmtpCidrs,
    smtpEncryptionModes,
    sesRegions,
    mailgunRegions,
    defaultProviderType: providerType,
    defaultFromAddress,
    defaultFromName,
    defaultSecretReference,
    defaultSettings,
    cacheInvalidationChannel,
    sendgridApiUrl,
    mailgunApiBaseUrls,
    allowInsecureSmtp
  })
}