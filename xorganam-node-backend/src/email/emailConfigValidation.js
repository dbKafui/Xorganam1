import { z } from 'zod'
import { EMAIL_PROVIDER_DESCRIPTORS, EMAIL_PROVIDER_TYPES } from './providerDescriptors.js'

const configEnvelopeSchema = z.object({
  providerType: z.enum(EMAIL_PROVIDER_TYPES),
  settings: z.record(z.string(), z.unknown()).default({}),
  secrets: z.record(z.string(), z.string()).default({}),
  fromAddress: z.string().trim().email().max(255),
  fromName: z.string().trim().max(255).nullable().optional(),
  replyTo: z.union([z.string().trim().email().max(255), z.literal(''), z.null()]).optional(),
  enabled: z.boolean().optional()
}).strict()

function fieldOptions(field, policy) {
  if (field.optionsSource === 'smtpPorts') return policy.allowedSmtpPorts
  if (field.optionsSource === 'smtpEncryptionModes') return policy.smtpEncryptionModes
  if (field.optionsSource === 'sesRegions') return policy.sesRegions
  if (field.optionsSource === 'mailgunRegions') return policy.mailgunRegions
  return null
}

function fieldSchema(field, policy) {
  if (field.input === 'number') {
    let schema = z.coerce.number().int().positive()
    if (field.optionsSource === 'smtpPorts') schema = schema.refine((port) => policy.allowedSmtpPorts.includes(port))
    return schema
  }
  let schema = z.string().trim().min(1).max(field.secret ? 32768 : 2048)
  const options = fieldOptions(field, policy)
  if (options) schema = schema.refine((value) => options.includes(value))
  return schema
}

export function validateTenantEmailConfig(input, { existingConfig = null, existingSecrets = {}, policy }) {
  const parsed = configEnvelopeSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, errors: parsed.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })) }
  }
  const candidate = parsed.data
  const descriptor = EMAIL_PROVIDER_DESCRIPTORS.find(({ type }) => type === candidate.providerType)
  const fields = new Map(descriptor.fields.map((field) => [field.key, field]))
  const errors = []

  for (const key of Object.keys(candidate.settings)) {
    if (!fields.has(key) || fields.get(key).secret) errors.push({ path: `settings.${key}`, message: 'Unknown or secret provider field.' })
  }
  for (const key of Object.keys(candidate.secrets)) {
    if (!fields.has(key) || !fields.get(key).secret) errors.push({ path: `secrets.${key}`, message: 'Unknown or non-secret provider field.' })
  }

  const settings = {}
  const secrets = {}
  const canRetainSecrets = existingConfig?.provider_type === candidate.providerType
  for (const field of descriptor.fields) {
    if (field.secret) {
      const submitted = candidate.secrets[field.key]
      const value = typeof submitted === 'string' && submitted.length > 0
        ? submitted
        : canRetainSecrets ? existingSecrets[field.key] : undefined
      if (value !== undefined) {
        const secretResult = fieldSchema(field, policy).safeParse(value)
        if (!secretResult.success) errors.push({ path: `secrets.${field.key}`, message: 'Secret value is invalid.' })
        else secrets[field.key] = secretResult.data
      } else if (field.required) {
        errors.push({ path: `secrets.${field.key}`, message: canRetainSecrets ? 'Existing secret is unavailable; enter a new value.' : 'Secret value is required.' })
      }
      continue
    }

    const value = candidate.settings[field.key]
    if (value === undefined || value === null || value === '') {
      if (field.required) errors.push({ path: `settings.${field.key}`, message: 'Provider field is required.' })
      continue
    }
    const settingResult = fieldSchema(field, policy).safeParse(value)
    if (!settingResult.success) errors.push({ path: `settings.${field.key}`, message: 'Provider field is invalid or not allowed.' })
    else settings[field.key] = settingResult.data
  }

  if (candidate.providerType === 'smtp') {
    const port = settings.port
    if (settings.encryption === 'implicit_tls' && port !== policy.smtpImplicitTlsPort) {
      errors.push({ path: 'settings.port', message: 'Implicit TLS must use the configured implicit-TLS port.' })
    }
    if (settings.encryption === 'starttls' && !policy.smtpStartTlsPorts.includes(port)) {
      errors.push({ path: 'settings.port', message: 'STARTTLS must use a configured STARTTLS port.' })
    }
    if (settings.encryption === 'none' && !policy.allowInsecureSmtp) {
      errors.push({ path: 'settings.encryption', message: 'Unencrypted SMTP is disabled by policy.' })
    }
    if (Boolean(secrets.username) !== Boolean(secrets.password)) {
      errors.push({ path: 'secrets', message: 'SMTP username and password must be provided together.' })
    }
  }

  if (errors.length) return { success: false, errors }
  const normalizedFromAddress = candidate.fromAddress.toLowerCase()
  const senderAddressUnchanged = existingConfig?.from_address?.toLowerCase() === normalizedFromAddress
  return {
    success: true,
    data: {
      providerType: candidate.providerType,
      settings,
      secrets,
      fromAddress: normalizedFromAddress,
      fromName: candidate.fromName || null,
      replyTo: candidate.replyTo || null,
      enabled: candidate.enabled ?? (senderAddressUnchanged ? existingConfig?.enabled ?? false : false)
    }
  }
}

export function toMaskedEmailConfig(row, presentSecretKeys = []) {
  if (!row) return null
  const descriptor = EMAIL_PROVIDER_DESCRIPTORS.find(({ type }) => type === row.provider_type)
  const secrets = Object.fromEntries((descriptor?.fields || [])
    .filter((field) => field.secret)
    .map((field) => [field.key, presentSecretKeys.includes(field.key)]))
  return {
    providerType: row.provider_type,
    settings: row.settings || {},
    secrets,
    fromAddress: row.from_address,
    fromName: row.from_name,
    replyTo: row.reply_to,
    senderVerified: row.sender_verified,
    enabled: row.enabled,
    updatedAt: row.updated_at
  }
}

export function getProviderDescriptors(policy) {
  return EMAIL_PROVIDER_DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    fields: descriptor.fields.map((field) => ({
      ...field,
      ...(field.optionsSource ? { options: fieldOptions(field, policy) || [] } : {})
    }))
  }))
}