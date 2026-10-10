import { Router } from 'express'
import { z } from 'zod'
import { authenticate, requireRole } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { query, withTransaction } from '../db/pool.js'
import { emailDeliveryPolicy } from '../config/emailDelivery.js'
import { tenantEmailKeyring } from '../config/tenantEmailConfig.js'
import { encryptTenantEmailSecrets, decryptTenantEmailSecrets } from '../security/tenantEmailConfigCrypto.js'
import { resolveSmtpDestination } from '../email/smtpAddressPolicy.js'
import { getProviderDescriptors, toMaskedEmailConfig, validateTenantEmailConfig } from '../email/emailConfigValidation.js'
import { createSenderVerificationToken, senderVerificationRecord, verifySenderDnsRecord } from '../email/senderVerification.js'
import { consumeTenantEmailTestQuota } from '../email/testEmailRateLimit.js'
import { enqueueTenantEmail } from '../queue/queue.js'
import { invalidateMailSender } from '../email/mailSenderService.js'
import { writePlatformAudit } from '../services/auditService.js'
import { EMAIL_API_MESSAGES, EMAIL_TEST_MESSAGE } from '../email/emailApiMessages.js'
import { emailTenantScopeDecision } from '../email/emailTenantScope.js'

export const tenantEmailConfigRouter = Router({ mergeParams: true })
const UUID = z.string().uuid()

tenantEmailConfigRouter.use(authenticate)
tenantEmailConfigRouter.use((req, res, next) => {
  const decision = emailTenantScopeDecision(req.user, req.params.tenantId)
  if (decision === 'invalid') return res.status(400).json({ message: EMAIL_API_MESSAGES.invalidTenantId })
  if (decision === 'forbidden') return res.status(403).json({ message: EMAIL_API_MESSAGES.tenantAccessDenied })
  next()
})
tenantEmailConfigRouter.use(requireRole('TENANT_MANAGER'))

tenantEmailConfigRouter.get('/providers', (_req, res) => {
  res.json({ providers: getProviderDescriptors(emailDeliveryPolicy) })
})

tenantEmailConfigRouter.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT provider_type, settings, secrets_encrypted, key_version, from_address, from_name, reply_to,
            sender_verified, enabled, updated_at
       FROM tenant_email_config WHERE tenant_id = $1`,
    [req.params.tenantId]
  )
  let secretKeys = []
  if (rows[0]?.secrets_encrypted) {
    secretKeys = Object.keys(decryptTenantEmailSecrets(req.params.tenantId, rows[0].secrets_encrypted, rows[0].key_version, tenantEmailKeyring.keys))
  }
  res.json({ config: toMaskedEmailConfig(rows[0], secretKeys) })
}))

tenantEmailConfigRouter.put('/', asyncHandler(async (req, res) => {
  const tenantId = req.params.tenantId
  const { rows: existingRows } = await query('SELECT * FROM tenant_email_config WHERE tenant_id = $1', [tenantId])
  const existing = existingRows[0] || null
  let existingSecrets = {}
  if (existing?.secrets_encrypted && existing.provider_type === req.body?.providerType) {
    existingSecrets = decryptTenantEmailSecrets(tenantId, existing.secrets_encrypted, existing.key_version, tenantEmailKeyring.keys)
  }
  const validation = validateTenantEmailConfig(req.body, { existingConfig: existing, existingSecrets, policy: emailDeliveryPolicy })
  if (!validation.success) return res.status(400).json({ message: EMAIL_API_MESSAGES.invalidConfiguration, errors: validation.errors })
  const config = validation.data

  if (config.providerType === 'smtp') {
    try {
      await resolveSmtpDestination(config.settings.host, emailDeliveryPolicy)
    } catch (error) {
      const blocked = error.message === 'SMTP host resolves to a blocked network.'
      return res.status(400).json({ message: blocked ? error.message : 'SMTP host could not be safely resolved.' })
    }
  }

  const currentAddress = existing?.from_address?.toLowerCase() || null
  const senderVerified = Boolean(existing?.sender_verified && currentAddress === config.fromAddress)
  const addressChanged = currentAddress !== config.fromAddress
  if (config.enabled && !senderVerified) {
    return res.status(409).json({ message: EMAIL_API_MESSAGES.senderMustBeVerified })
  }
  const enabled = addressChanged ? false : config.enabled
  let challenge = null
  let challengeHash = null
  if (!senderVerified) {
    const generated = createSenderVerificationToken()
    challenge = senderVerificationRecord(config.fromAddress, generated.token)
    challengeHash = generated.hash
  }
  const encrypted = encryptTenantEmailSecrets(tenantId, config.secrets, tenantEmailKeyring)

  const { rows } = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO tenant_email_config
         (tenant_id, provider_type, settings, secrets_encrypted, key_version, from_address, from_name,
          reply_to, sender_verified, sender_verification_token_hash, sender_verification_requested_at, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $10::char(64) IS NULL THEN NULL ELSE now() END, $11)
       ON CONFLICT (tenant_id) DO UPDATE SET
         provider_type = EXCLUDED.provider_type,
         settings = EXCLUDED.settings,
         secrets_encrypted = EXCLUDED.secrets_encrypted,
         key_version = EXCLUDED.key_version,
         from_address = EXCLUDED.from_address,
         from_name = EXCLUDED.from_name,
         reply_to = EXCLUDED.reply_to,
         sender_verified = EXCLUDED.sender_verified,
         sender_verification_token_hash = EXCLUDED.sender_verification_token_hash,
         sender_verification_requested_at = EXCLUDED.sender_verification_requested_at,
         enabled = EXCLUDED.enabled,
         updated_at = now()
       RETURNING provider_type, settings, secrets_encrypted, from_address, from_name, reply_to,
                 sender_verified, enabled, updated_at`,
      [tenantId, config.providerType, JSON.stringify(config.settings), encrypted.ciphertext, encrypted.keyVersion,
        config.fromAddress, config.fromName, config.replyTo, senderVerified, challengeHash, enabled]
    )
    const auditQuery = (text, params) => client.query(text, params)
    await writePlatformAudit({
      actorUserId: req.user.id,
      tenantId,
      action: 'TENANT_EMAIL_CONFIG_UPDATED',
      resourceType: 'tenant_email_config',
      resourceId: tenantId,
      details: { providerType: config.providerType, fromAddress: config.fromAddress, enabled, senderVerified },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      requestId: req.id || null,
      client: auditQuery
    })
    return result
  })

  await invalidateMailSender(tenantId)
  res.json({
    config: toMaskedEmailConfig(rows[0], Object.keys(config.secrets)),
    ...(challenge ? { verificationChallenge: challenge } : {})
  })
}))

tenantEmailConfigRouter.post('/verification/challenge', asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT from_address, sender_verified FROM tenant_email_config WHERE tenant_id = $1',
    [req.params.tenantId]
  )
  if (!rows.length) return res.status(404).json({ message: EMAIL_API_MESSAGES.verificationChallengeRequired })
  if (rows[0].sender_verified) return res.status(409).json({ message: EMAIL_API_MESSAGES.senderVerificationSucceeded })
  const generated = createSenderVerificationToken()
  const record = senderVerificationRecord(rows[0].from_address, generated.token)
  const { rowCount } = await query(
    `UPDATE tenant_email_config SET sender_verification_token_hash = $2, sender_verification_requested_at = now()
      WHERE tenant_id = $1 AND sender_verified = FALSE AND from_address = $3`,
    [req.params.tenantId, generated.hash, rows[0].from_address]
  )
  if (!rowCount) return res.status(409).json({ message: EMAIL_API_MESSAGES.senderVerificationPending })
  res.json({ message: EMAIL_API_MESSAGES.verificationChallengeCreated, verificationChallenge: record })
}))

tenantEmailConfigRouter.post('/verification/confirm', asyncHandler(async (req, res) => {
  const { rows } = await query(
     `SELECT from_address, sender_verification_token_hash
       FROM tenant_email_config
      WHERE tenant_id = $1 AND sender_verification_requested_at > now() - ($2::bigint * interval '1 millisecond')`,
     [req.params.tenantId, emailDeliveryPolicy.senderChallengeTtlMs]
  )
  const config = rows[0]
  if (!config?.sender_verification_token_hash) return res.status(409).json({ message: EMAIL_API_MESSAGES.verificationChallengeRequired })
  let verified
  try {
    verified = await verifySenderDnsRecord(config.from_address, config.sender_verification_token_hash)
  } catch {
    return res.status(503).json({ message: EMAIL_API_MESSAGES.senderVerificationPending })
  }
  if (!verified) return res.status(409).json({ message: EMAIL_API_MESSAGES.senderVerificationPending })
  const { rowCount } = await query(
    `UPDATE tenant_email_config
        SET sender_verified = TRUE, sender_verification_token_hash = NULL, sender_verification_requested_at = NULL, updated_at = now()
      WHERE tenant_id = $1 AND sender_verification_token_hash = $2
        AND sender_verification_requested_at > now() - ($3::bigint * interval '1 millisecond')`,
    [req.params.tenantId, config.sender_verification_token_hash, emailDeliveryPolicy.senderChallengeTtlMs]
  )
  if (!rowCount) return res.status(409).json({ message: EMAIL_API_MESSAGES.senderVerificationPending })
  await invalidateMailSender(req.params.tenantId)
  await writePlatformAudit({
    actorUserId: req.user.id,
    tenantId: req.params.tenantId,
    action: 'TENANT_EMAIL_SENDER_VERIFIED',
    resourceType: 'tenant_email_config',
    resourceId: req.params.tenantId,
    details: { fromAddress: config.from_address },
    ipAddress: req.ip || null,
    userAgent: req.headers['user-agent'] || null,
    requestId: req.id || null
  })
  res.json({ message: EMAIL_API_MESSAGES.senderVerificationSucceeded })
}))

tenantEmailConfigRouter.post('/test', asyncHandler(async (req, res) => {
  const quota = await consumeTenantEmailTestQuota(req.params.tenantId)
  if (!quota.allowed) return res.status(429).json({ message: EMAIL_API_MESSAGES.rateLimitExceeded })
  const { rows } = await query(
    'SELECT enabled, sender_verified FROM tenant_email_config WHERE tenant_id = $1',
    [req.params.tenantId]
  )
  if (!rows[0]?.enabled || !rows[0]?.sender_verified) {
    return res.status(409).json({ message: EMAIL_API_MESSAGES.testRequiresEnabledConfig })
  }
  const queued = await enqueueTenantEmail({
    tenantId: req.params.tenantId,
    message: { to: req.user.email, ...EMAIL_TEST_MESSAGE }
  })
  res.status(202).json({ ...queued, message: EMAIL_API_MESSAGES.testQueued })
}))

tenantEmailConfigRouter.get('/test/:deliveryId', asyncHandler(async (req, res) => {
  if (!UUID.safeParse(req.params.deliveryId).success) return res.status(400).json({ message: EMAIL_API_MESSAGES.invalidDeliveryId })
  const { rows } = await query(
    `SELECT id, status, error_code, attempt_count, created_at, completed_at
       FROM email_delivery_records WHERE id = $1 AND tenant_id = $2`,
    [req.params.deliveryId, req.params.tenantId]
  )
  if (!rows.length) return res.status(404).json({ message: EMAIL_API_MESSAGES.deliveryNotFound })
  res.json(rows[0])
}))