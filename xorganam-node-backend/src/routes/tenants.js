import { Router } from 'express'
import { query } from '../db/pool.js'
import { encrypt } from '../security/encryption.js'
import { authenticate, requireRole, requirePlatformAdmin, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
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
      `SELECT id, kyc_type, document_type, document_number, verification_status, rejection_reason, created_at
         FROM kyc_documents WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    )

    res.json({ ...mapTenant(rows[0]), documents: documents.rows.map(mapDocument) })
  })
)

// ---------------------------------------------------------------------
// KYC document submission + review
// ---------------------------------------------------------------------
tenantsRouter.post(
  '/:tenantId/kyc-documents',
  kycUpload.single('document'),
  asyncHandler(async (req, res) => {
    let tenantId
    try {
      tenantId = resolveTenantScope(req, req.params.tenantId)
    } catch (err) {
      if (err instanceof ForbiddenError) return res.status(403).json({ message: err.message })
      throw err
    }

    const { kycType, documentType, documentNumber } = req.body
    if (!req.file) return res.status(400).json({ message: 'A document file is required.' })
    if (!kycType || !documentType || !documentNumber) {
      return res.status(400).json({ message: 'kycType, documentType, and documentNumber are required.' })
    }

    const documentUrl = toDocumentUrl(tenantId, req.file)

    const { rows } = await query(
      `INSERT INTO kyc_documents (tenant_id, kyc_type, document_type, document_number, document_url, verification_status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')
       RETURNING id, document_type, verification_status, created_at`,
      [tenantId, kycType, documentType, documentNumber, documentUrl]
    )

    await query(
      `UPDATE tenants SET status = 'UNDER_REVIEW' WHERE id = $1 AND status = 'PENDING'`,
      [tenantId]
    )

    res.status(201).json(mapDocument(rows[0]))
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
      isEnabled
    } = req.body || {}

    const username = apiUsername ?? secretUsername ?? apiKey
    const password = apiPassword ?? secretPassword ?? clientSecret
    const xAuthValue = xAuth ?? accessToken ?? null
    const service = serviceName ?? merchantCode ?? null
    const tenantBaseUrl = eganowBaseUrl ?? baseUrl ?? null

    const tenantRows = await query('SELECT id, status, api_key_salt FROM tenants WHERE id = $1', [tenantId])
    if (tenantRows.rows.length === 0) return res.status(404).json({ message: 'Tenant not found.' })
    const tenant = tenantRows.rows[0]

    // fetch existing tenant base url to validate enablement
    const existingRow = await query('SELECT eganow_base_url FROM tenant_eganow_credentials WHERE tenant_id = $1', [tenantId])
    const existingBaseUrl = existingRow.rows.length ? existingRow.rows[0].eganow_base_url : null

    if (isEnabled && tenant.status !== 'ACTIVE') {
      return res.status(400).json({ message: 'Tenant must complete KYC approval before Eganow can be enabled.' })
    }

    if (isEnabled) {
      const finalBaseUrl = tenantBaseUrl || existingBaseUrl
      if (!finalBaseUrl) {
        return res.status(400).json({ message: 'Eganow base URL must be configured before enabling Eganow for this tenant.' })
      }
    }

    await query(
      `UPDATE tenant_eganow_credentials
          SET eganow_api_key_encrypted = COALESCE($2, eganow_api_key_encrypted),
              eganow_client_secret_encrypted = COALESCE($3, eganow_client_secret_encrypted),
              eganow_access_token_encrypted = COALESCE($4, eganow_access_token_encrypted),
              eganow_base_url = COALESCE($5, eganow_base_url),
              webhook_secret_encrypted = COALESCE($6, webhook_secret_encrypted),
              eganow_merchant_code = COALESCE($7, eganow_merchant_code),
              is_enabled = COALESCE($8, is_enabled)
        WHERE tenant_id = $1`,
      [
        tenantId,
        username ? encrypt(username, tenant.api_key_salt) : null,
        password ? encrypt(password, tenant.api_key_salt) : null,
        xAuthValue ? encrypt(xAuthValue, tenant.api_key_salt) : null,
        tenantBaseUrl || null,
        webhookSecret ? encrypt(webhookSecret, tenant.api_key_salt) : null,
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
              c.eganow_base_url,
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
        smsProviderKey ? encrypt(smsProviderKey, salt) : null,
        smsSenderId || null,
        typeof smsEnabled === 'boolean' ? smsEnabled : null,
        emailProviderName || null,
        emailProviderKey ? encrypt(emailProviderKey, salt) : null,
        emailFromAddress || null,
        typeof emailEnabled === 'boolean' ? emailEnabled : null
      ]
    )

    res.json({ message: 'Notification configuration updated.' })
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
    verificationStatus: row.verification_status,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at
  }
}
