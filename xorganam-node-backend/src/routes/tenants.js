import { Router } from 'express'
import crypto from 'node:crypto'
import { query } from '../db/pool.js'
import { encrypt } from '../security/encryption.js'
import { authenticate, requireRole, requirePlatformAdmin, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { initiateCollection, CollectionRejectedError } from '../services/collectionService.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { kycUpload, toDocumentUrl } from '../services/fileStorage.js'

export const tenantsRouter = Router()

tenantsRouter.use(authenticate)

// ---------------------------------------------------------------------
// Listing / detail
// ---------------------------------------------------------------------
tenantsRouter.get(
  '/',
  requirePlatformAdmin,
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT id, company_name, contact_phone, contact_email, status, created_at, approved_at
         FROM tenants ORDER BY created_at DESC`
    )
    res.json(rows.map(mapTenant))
  })
)

tenantsRouter.post(
  '/',
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const { companyName, contactPhone, contactEmail, status = 'PENDING' } = req.body || {}

    if (!companyName || !contactPhone || !contactEmail) {
      return res.status(400).json({ message: 'companyName, contactPhone, and contactEmail are required.' })
    }
    if (!['PENDING', 'UNDER_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED'].includes(status)) {
      return res.status(400).json({ message: 'Invalid tenant status.' })
    }

    const apiKeySalt = crypto.randomBytes(16).toString('hex')
    const { rows } = await query(
      `INSERT INTO tenants (company_name, contact_phone, contact_email, api_key_salt, status, approved_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'ACTIVE' THEN now() ELSE NULL END)
       RETURNING id, company_name, contact_phone, contact_email, status, created_at, approved_at`,
      [companyName, contactPhone, contactEmail, apiKeySalt, status]
    )

    res.status(201).json(mapTenant(rows[0]))
  })
)

tenantsRouter.get(
  '/:tenantId',
  asyncHandler(async (req, res) => {
    let tenantId
    try {
      tenantId = resolveTenantScope(req, req.params.tenantId)
    } catch (err) {
      if (err instanceof ForbiddenError) return res.status(403).json({ message: err.message })
      throw err
    }

    const { rows } = await query(
      `SELECT id, company_name, contact_phone, contact_email, status, created_at, approved_at
         FROM tenants WHERE id = $1`,
      [tenantId]
    )
    if (rows.length === 0) return res.status(404).json({ message: 'Tenant not found.' })

    const documents = await query(
      `SELECT id, kyc_type, document_type, document_number, document_url, verification_status, rejection_reason, created_at
         FROM kyc_documents WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    )

    res.json({ ...mapTenant(rows[0]), documents: documents.rows.map(mapDocument) })
  })
)

tenantsRouter.put(
  '/:tenantId',
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const { companyName, contactPhone, contactEmail, status } = req.body || {}
    if (status && !['PENDING', 'UNDER_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED'].includes(status)) {
      return res.status(400).json({ message: 'Invalid tenant status.' })
    }

    const { rows } = await query(
      `UPDATE tenants
          SET company_name = COALESCE($2, company_name),
              contact_phone = COALESCE($3, contact_phone),
              contact_email = COALESCE($4, contact_email),
              status = COALESCE($5, status),
              approved_at = CASE
                WHEN $5 = 'ACTIVE' AND approved_at IS NULL THEN now()
                WHEN $5 IS NOT NULL AND $5 != 'ACTIVE' THEN NULL
                ELSE approved_at
              END
        WHERE id = $1
        RETURNING id, company_name, contact_phone, contact_email, status, created_at, approved_at`,
      [req.params.tenantId, companyName || null, contactPhone || null, contactEmail || null, status || null]
    )

    if (rows.length === 0) return res.status(404).json({ message: 'Tenant not found.' })
    res.json(mapTenant(rows[0]))
  })
)

tenantsRouter.delete(
  '/:tenantId',
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT id FROM tenants WHERE id = $1', [req.params.tenantId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'Tenant not found.' })

    const txnCount = await query('SELECT COUNT(*)::int AS count FROM transactions WHERE tenant_id = $1', [req.params.tenantId])
    if (txnCount.rows[0].count > 0) {
      await query(`UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1`, [req.params.tenantId])
      return res.json({ deleted: false, status: 'SUSPENDED', message: 'Tenant has ledger history and was suspended instead.' })
    }

    await query('DELETE FROM tenants WHERE id = $1', [req.params.tenantId])
    res.json({ deleted: true })
  })
)

// ---------------------------------------------------------------------
// KYC document submission + review
// ---------------------------------------------------------------------
tenantsRouter.post(
  '/:tenantId/kyc-documents',
  // Accept multiple uploaded files to allow KYB submissions with several documents
  kycUpload.any(),
  asyncHandler(async (req, res) => {
    let tenantId
    try {
      tenantId = resolveTenantScope(req, req.params.tenantId)
    } catch (err) {
      if (err instanceof ForbiddenError) return res.status(403).json({ message: err.message })
      throw err
    }
    const { kycType } = req.body
    const files = req.files || []
    if (!files.length) return res.status(400).json({ message: 'At least one document file is required.' })
    if (!kycType) return res.status(400).json({ message: 'kycType is required.' })

    // Accept documentType and documentNumber as either single values or arrays
    const documentTypes = Array.isArray(req.body.documentType)
      ? req.body.documentType
      : req.body.documentType
      ? [req.body.documentType]
      : []
    const documentNumbers = Array.isArray(req.body.documentNumber)
      ? req.body.documentNumber
      : req.body.documentNumber
      ? [req.body.documentNumber]
      : []

    const insertedRows = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const documentType = documentTypes[i] || documentTypes[0] || null
      const documentNumber = documentNumbers[i] || documentNumbers[0] || null

      const documentUrl = toDocumentUrl(tenantId, file)

      const { rows } = await query(
        `INSERT INTO kyc_documents (tenant_id, kyc_type, document_type, document_number, document_url, verification_status)
         VALUES ($1, $2, $3, $4, $5, 'PENDING')
         RETURNING id, document_type, document_number, document_url, verification_status, created_at`,
        [tenantId, kycType, documentType, documentNumber, documentUrl]
      )
      insertedRows.push(rows[0])
    }

    await query(`UPDATE tenants SET status = 'UNDER_REVIEW' WHERE id = $1 AND status = 'PENDING'`, [tenantId])

    res.status(201).json(insertedRows.map(mapDocument))
  })
)

tenantsRouter.post(
  '/kyc-documents/:documentId/review',
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const { decision, rejectionReason } = req.body || {}
    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      return res.status(400).json({ message: "decision must be 'APPROVED' or 'REJECTED'." })
    }

    const { rows } = await query('SELECT id, tenant_id FROM kyc_documents WHERE id = $1', [req.params.documentId])
    if (rows.length === 0) return res.status(404).json({ message: 'Document not found.' })
    const doc = rows[0]

    await query(
      `UPDATE kyc_documents
          SET verification_status = $2, rejection_reason = $3, verified_by_user_id = $4, verified_at = now()
        WHERE id = $1`,
      [doc.id, decision, decision === 'REJECTED' ? rejectionReason || 'Not specified' : null, req.user.id]
    )

    if (decision === 'REJECTED') {
      await query(`UPDATE tenants SET status = 'REJECTED' WHERE id = $1`, [doc.tenant_id])
    } else {
      const remaining = await query(
        `SELECT COUNT(*)::int AS pending_count FROM kyc_documents
          WHERE tenant_id = $1 AND id != $2 AND verification_status != 'APPROVED'`,
        [doc.tenant_id, doc.id]
      )
      if (remaining.rows[0].pending_count === 0) {
        await query(`UPDATE tenants SET status = 'ACTIVE', approved_at = now() WHERE id = $1`, [doc.tenant_id])
      }
    }

    res.json({ message: 'Review recorded.', status: decision })
  })
)

// ---------------------------------------------------------------------
// Eganow credentials activation (platform admin only - this is what
// actually lets a tenant's merchants start accepting live payments)
// ---------------------------------------------------------------------
tenantsRouter.put(
  '/:tenantId/eganow-credentials',
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const tenantId = req.params.tenantId
    const {
      apiUsername,
      apiPassword,
      eganowBaseUrl,
      baseUrl,
      xAuth,
      serviceName,
      secretUsername,
      secretPassword,
      apiKey,
      clientSecret,
      accessToken,
      webhookSecret,
      merchantCode,
      eganowCallbackUrl,
      callbackUrl,
      isEnabled
    } = req.body || {}

    const username = apiUsername ?? secretUsername ?? apiKey
    const password = apiPassword ?? secretPassword ?? clientSecret
    const xAuthValue = xAuth ?? accessToken ?? null
    const service = serviceName ?? merchantCode ?? null
    const tenantBaseUrl = eganowBaseUrl ?? baseUrl ?? null
    const tenantCallbackUrl = eganowCallbackUrl ?? callbackUrl ?? null

    const tenantRows = await query('SELECT id, status, api_key_salt FROM tenants WHERE id = $1', [tenantId])
    if (tenantRows.rows.length === 0) return res.status(404).json({ message: 'Tenant not found.' })
    const tenant = tenantRows.rows[0]

    if (isEnabled && tenant.status !== 'ACTIVE') {
      return res.status(400).json({ message: 'Tenant must complete KYC approval before Eganow can be enabled.' })
    }

    const [encryptedUsername, encryptedPassword, encryptedXAuth, encryptedWebhookSecret] = await Promise.all([
      username ? encrypt(username, tenant.api_key_salt) : null,
      password ? encrypt(password, tenant.api_key_salt) : null,
      xAuthValue ? encrypt(xAuthValue, tenant.api_key_salt) : null,
      webhookSecret ? encrypt(webhookSecret, tenant.api_key_salt) : null
    ])

    await query(
      `UPDATE tenant_eganow_credentials
          SET eganow_api_key_encrypted = COALESCE($2, eganow_api_key_encrypted),
              eganow_client_secret_encrypted = COALESCE($3, eganow_client_secret_encrypted),
              eganow_access_token_encrypted = COALESCE($4, eganow_access_token_encrypted),
              eganow_base_url = COALESCE($5, eganow_base_url),
              eganow_callback_url = COALESCE($6, eganow_callback_url),
              webhook_secret_encrypted = COALESCE($7, webhook_secret_encrypted),
              eganow_merchant_code = COALESCE($8, eganow_merchant_code),
              is_enabled = COALESCE($9, is_enabled)
        WHERE tenant_id = $1`,
      [
        tenantId,
        encryptedUsername,
        encryptedPassword,
        encryptedXAuth,
        tenantBaseUrl || null,
        tenantCallbackUrl || null,
        encryptedWebhookSecret,
        service || null,
        typeof isEnabled === 'boolean' ? isEnabled : null
      ]
    )

    res.json({ message: 'Eganow configuration updated.' })
  })
)

// ---------------------------------------------------------------------
// Notification (SMS/email) config - tenant manager+ or platform admin
// ---------------------------------------------------------------------
tenantsRouter.get(
  '/:tenantId/config',
  asyncHandler(async (req, res) => {
    let tenantId
    try {
      tenantId = resolveTenantScope(req, req.params.tenantId)
    } catch (err) {
      if (err instanceof ForbiddenError) return res.status(403).json({ message: err.message })
      throw err
    }

    const { rows } = await query(
      `SELECT c.is_enabled AS eganow_enabled, c.eganow_merchant_code,
              c.eganow_base_url, c.eganow_callback_url,
              n.sms_enabled, n.sms_provider_name, n.sms_sender_id,
              n.email_enabled, n.email_provider_name, n.email_from_address
         FROM tenants t
         LEFT JOIN tenant_eganow_credentials c ON c.tenant_id = t.id
         LEFT JOIN tenant_notification_settings n ON n.tenant_id = t.id
        WHERE t.id = $1`,
      [tenantId]
    )
    if (rows.length === 0) return res.status(404).json({ message: 'Tenant not found.' })
    res.json(rows[0])
  })
)

tenantsRouter.put(
  '/:tenantId/notification-settings',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    let tenantId
    try {
      tenantId = resolveTenantScope(req, req.params.tenantId)
    } catch (err) {
      if (err instanceof ForbiddenError) return res.status(403).json({ message: err.message })
      throw err
    }

    const tenantRows = await query('SELECT api_key_salt FROM tenants WHERE id = $1', [tenantId])
    if (tenantRows.rows.length === 0) return res.status(404).json({ message: 'Tenant not found.' })
    const salt = tenantRows.rows[0].api_key_salt

    const { smsProviderName, smsProviderKey, smsSenderId, smsEnabled, emailProviderName, emailProviderKey, emailFromAddress, emailEnabled } =
      req.body || {}

    const [encryptedSmsKey, encryptedEmailKey] = await Promise.all([
      smsProviderKey ? encrypt(smsProviderKey, salt) : null,
      emailProviderKey ? encrypt(emailProviderKey, salt) : null
    ])

    await query(
      `UPDATE tenant_notification_settings
          SET sms_provider_name = COALESCE($2, sms_provider_name),
              sms_provider_key_encrypted = COALESCE($3, sms_provider_key_encrypted),
              sms_sender_id = COALESCE($4, sms_sender_id),
              sms_enabled = COALESCE($5, sms_enabled),
              email_provider_name = COALESCE($6, email_provider_name),
              email_provider_key_encrypted = COALESCE($7, email_provider_key_encrypted),
              email_from_address = COALESCE($8, email_from_address),
              email_enabled = COALESCE($9, email_enabled)
        WHERE tenant_id = $1`,
      [
        tenantId,
        smsProviderName || null,
        encryptedSmsKey,
        smsSenderId || null,
        typeof smsEnabled === 'boolean' ? smsEnabled : null,
        emailProviderName || null,
        encryptedEmailKey,
        emailFromAddress || null,
        typeof emailEnabled === 'boolean' ? emailEnabled : null
      ]
    )

    res.json({ message: 'Notification configuration updated.' })
  })
)

  // Tenant-scoped collection endpoint - authenticated tenant/operator use
  // (or platform admin acting on a tenant). This mirrors the manual
  // collection endpoint under /transactions but is exposed under the
  // tenant namespace so clients can explicitly target a tenant.
  // ---------------------------------------------------------------------
  tenantsRouter.post(
    '/:tenantId/collect',
    requireRole('TENANT_OPERATOR'),
    asyncHandler(async (req, res) => {
      let tenantId
      try {
        tenantId = resolveTenantScope(req, req.params.tenantId)
      } catch (err) {
        if (err instanceof ForbiddenError) return res.status(403).json({ message: err.message })
        throw err
      }

      const { merchantId, amount, msisdn, network, narration, payoutMsisdn, payoutMobileNumber, accountNoOrMsisdn, callback: callbackOverride } = req.body || {}
      if (!merchantId) return res.status(400).json({ message: 'merchantId is required.' })

      // Ensure the merchant belongs to the requested tenant
      const merchantRow = await query('SELECT tenant_id FROM merchants WHERE id = $1', [merchantId])
      if (merchantRow.rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })
      if (String(merchantRow.rows[0].tenant_id) !== String(tenantId)) {
        return res.status(403).json({ message: "Merchant does not belong to the specified tenant." })
      }

      try {
        const result = await initiateCollection(merchantId, {
          amount: Number(amount),
          msisdn,
          network,
          narration,
          payoutMsisdn: payoutMsisdn || payoutMobileNumber || accountNoOrMsisdn || null,
          callback: callbackOverride || undefined
        })

        if (result.status !== 'FAILED') {
          await query('UPDATE transactions SET manually_triggered = TRUE, initiated_by_user_id = $2 WHERE id = $1', [
            result.transactionId,
            req.user.id
          ])
        }

        res.json({
          id: result.transactionId,
          internalReference: result.internalReference,
          status: result.status,
          paymentGatewayStatus: result.paymentGatewayStatus || result.status,
          message: result.message || null
        })
      } catch (err) {
        if (err instanceof CollectionRejectedError) return res.status(400).json({ message: err.message })
        if (err.name === 'TenantCredentialsError') return res.status(400).json({ message: err.message })
        throw err
      }
    })
  )

function mapTenant(row) {
  return {
    id: row.id,
    companyName: row.company_name,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at
  }
}

function mapDocument(row) {
  return {
    id: row.id,
    documentType: row.document_type,
    documentUrl: row.document_url || null,
    verificationStatus: row.verification_status,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at
  }
}
