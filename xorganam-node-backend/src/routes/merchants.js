import { Router } from 'express'
import { query, withTransaction } from '../db/pool.js'
import { authenticate, requireRole, requirePermission, requirePlatformAdmin, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { createVendorReference } from '../services/referenceIds.js'
import { encrypt } from '../security/encryption.js'
import { writePlatformAudit } from '../services/auditService.js'
import { requestMerchantPayoutDestinationChange, reviewMerchantPayoutDestinationChange } from '../services/merchantPayoutDestinationService.js'

export const merchantsRouter = Router()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

merchantsRouter.use(authenticate)

merchantsRouter.get(
  '/payout-destination-change-requests',
  requireRole('TENANT_ADMIN'),
  asyncHandler(async (req, res) => {
    const allTenants = req.user.isPlatformAdmin && !req.query.tenantId
    const tenantId = allTenants ? null : scopeOrRespond(req, res, req.query.tenantId)
    if (!allTenants && !tenantId) return
    const { rows } = await query(
      `SELECT r.id, r.merchant_id, m.display_name AS merchant_name, r.requested_by_user_id,
              requester.email AS requester_email, r.previous_mobile_money_number,
              r.requested_mobile_money_number, r.status, r.reviewed_by_user_id,
              reviewer.email AS reviewer_email, r.review_reason, r.created_at, r.reviewed_at
         FROM merchant_payout_destination_change_requests r
         JOIN merchants m ON m.id = r.merchant_id
         JOIN users requester ON requester.id = r.requested_by_user_id
         LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by_user_id
        WHERE ($1::uuid IS NULL OR r.tenant_id = $1) ORDER BY r.created_at DESC LIMIT 100`, [tenantId]
    )
    res.json({ requests: rows })
  })
)

function scopeOrRespond(req, res, requestedTenantId) {
  try {
    return resolveTenantScope(req, requestedTenantId)
  } catch (err) {
    if (err instanceof ForbiddenError) {
      res.status(403).json({ message: err.message })
      return null
    }
    throw err
  }
}

merchantsRouter.get(
  '/',
  requirePermission('VIEW_MERCHANTS'),
  asyncHandler(async (req, res) => {
    const listAllTenants = req.user.isPlatformAdmin && !req.query.tenantId
    const tenantId = listAllTenants ? null : scopeOrRespond(req, res, req.query.tenantId)
    if (!listAllTenants && !tenantId) return
    let merchantId = req.query.merchantId || null
    if (req.user.merchantId) {
      if (merchantId && String(merchantId) !== String(req.user.merchantId)) {
        return res.status(403).json({ message: 'You do not have access to other merchants.' })
      }
      merchantId = String(req.user.merchantId)
    }

    const { rows } = await query(
      `SELECT m.id, m.tenant_id, t.company_name AS tenant_company_name,
              m.display_name, m.vendor_reference, m.mobile_money_number, m.network_provider, m.payout_mode,
              m.eganow_collection_account_id, m.eganow_payout_account_id, m.account_setup_status, m.is_active, m.onboarded_at,
              ms.allow_manual_control
         FROM merchants m
         JOIN tenants t ON t.id = m.tenant_id
         LEFT JOIN merchant_settings ms ON ms.tenant_id = m.tenant_id AND ms.merchant_id = m.id
        WHERE ($1::uuid IS NULL OR m.tenant_id = $1)
          AND ($2::uuid IS NULL OR m.id = $2)
        ORDER BY m.onboarded_at DESC`,
      [tenantId, merchantId]
    )
    res.json(rows.map(mapMerchant))
  })
)

merchantsRouter.post(
  '/',
  requirePermission('MANAGE_MERCHANTS'),
  asyncHandler(async (req, res) => {
    const tenantId = scopeOrRespond(req, res, req.body?.tenantId)
    if (!tenantId) return

    const {
      displayName,
      mobileMoneyNumber,
      networkProvider,
      payoutMode,
      eganowCollectionAccountId,
      eganowPayoutAccountId
    } = req.body || {}
    if (!displayName || !mobileMoneyNumber || !networkProvider) {
      return res.status(400).json({ message: 'displayName, mobileMoneyNumber, and networkProvider are required.' })
    }
    const vendorReference = createVendorReference(displayName, 'VENDOR')

    try {
      const created = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO merchants
         (tenant_id, display_name, vendor_reference, mobile_money_number, network_provider, payout_mode,
            eganow_collection_account_id, eganow_payout_account_id, account_setup_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')
         RETURNING id, display_name, vendor_reference, mobile_money_number, network_provider, payout_mode,
                   eganow_collection_account_id, eganow_payout_account_id, account_setup_status, is_active, onboarded_at`,
        [
          tenantId,
          displayName,
          vendorReference,
          mobileMoneyNumber,
          networkProvider,
          payoutMode === 'AUTO_SWEEP' ? 'AUTO_SWEEP' : 'MANUAL',
          eganowCollectionAccountId || null,
          eganowPayoutAccountId || null
        ]
      )
      await writePlatformAudit({
        actorUserId: req.user.id, tenantId, merchantId: rows[0].id,
        action: 'MERCHANT_CREATED', resourceType: 'merchant', resourceId: rows[0].id,
        details: { displayName, mobileMoneyNumber, networkProvider, payoutMode: payoutMode === 'AUTO_SWEEP' ? 'AUTO_SWEEP' : 'MANUAL' },
        ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null,
        requestId: req.id || null, client
      })
      return rows[0]
      })
      res.status(201).json({ ...mapMerchant(created), allowManualControl: false })
    } catch (err) {
      if (err.code === '23505') {
        // Unique vendor references and Eganow account assignments are all protected by database indexes.
        return res.status(409).json({ message: 'Vendor reference or Eganow account ID is already in use.' })
      }
      throw err
    }
  })
)

merchantsRouter.patch(
  '/:merchantId/eganow-accounts',
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const collectionId = String(req.body?.eganowCollectionAccountId || '').trim()
    const payoutId = String(req.body?.eganowPayoutAccountId || '').trim()
    if (!collectionId || !payoutId) {
      return res.status(400).json({ message: 'Both Eganow account IDs are required.' })
    }
    try {
      const result = await withTransaction(async (client) => {
      const { rows: beforeRows } = await client.query(
        `SELECT tenant_id, eganow_collection_account_id, eganow_payout_account_id, account_setup_status
           FROM merchants WHERE id = $1 FOR UPDATE`, [req.params.merchantId]
      )
      if (!beforeRows.length) return { missing: true }
      const previous = beforeRows[0]
      const { rows } = await client.query(
        `UPDATE merchants
            SET eganow_collection_account_id = $2,
                eganow_payout_account_id = $3,
                account_setup_status = CASE WHEN EXISTS (
                  SELECT 1 FROM merchant_eganow_credentials c WHERE c.merchant_id = merchants.id AND c.is_enabled
                ) THEN 'ACTIVE' ELSE 'PENDING' END,
                updated_at = now()
          WHERE id = $1
          RETURNING id, account_setup_status`,
        [req.params.merchantId, collectionId, payoutId]
      )
      await writePlatformAudit({
        actorUserId: req.user.id, tenantId: previous.tenant_id, merchantId: req.params.merchantId,
        action: 'MERCHANT_EGANOW_ACCOUNT_CONFIGURATION_CHANGED', resourceType: 'merchant', resourceId: req.params.merchantId,
        details: {
          previous: { collectionAccountId: previous.eganow_collection_account_id, payoutAccountId: previous.eganow_payout_account_id, setupStatus: previous.account_setup_status },
          current: { collectionAccountId: collectionId, payoutAccountId: payoutId, setupStatus: rows[0].account_setup_status }
        },
        ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null, requestId: req.id || null, client
      })
      return { merchant: rows[0] }
      })
      if (result.missing) return res.status(404).json({ message: 'Merchant not found.' })
      res.json({ ok: true, merchantId: result.merchant.id, accountSetupStatus: result.merchant.account_setup_status })
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ message: 'One of these Eganow account IDs is already assigned to another merchant.' })
      throw error
    }
  })
)

merchantsRouter.put(
  '/:merchantId/eganow-credentials',
  requirePlatformAdmin,
  asyncHandler(async (req, res) => {
    const { apiUsername, apiPassword, xAuth, callbackUrl, eganowBaseUrl } = req.body || {}
    const values = [apiUsername, apiPassword, xAuth, callbackUrl].map((value) => String(value || '').trim())
    if (!uuid.test(req.params.merchantId) || values.some((value) => !value) || values.some((value) => value.length > 2000)) {
      return res.status(400).json({ message: 'Vendor Eganow username, password, x-Auth, and callback URL are required.' })
    }
    let callback
    try {
      callback = new URL(values[3])
    } catch {
      return res.status(400).json({ message: 'Provide a valid Eganow callback URL.' })
    }
    if (callback.protocol !== 'https:') return res.status(400).json({ message: 'The Eganow callback URL must use HTTPS.' })
    const { rows } = await query(
      `SELECT m.tenant_id, m.eganow_collection_account_id, m.eganow_payout_account_id, t.api_key_salt
         FROM merchants m JOIN tenants t ON t.id = m.tenant_id WHERE m.id = $1`, [req.params.merchantId]
    )
    const merchant = rows[0]
    if (!merchant) return res.status(404).json({ message: 'Vendor not found.' })
    if (!merchant.eganow_collection_account_id || !merchant.eganow_payout_account_id) {
      return res.status(409).json({ message: 'Assign this vendor’s Eganow collection and payout accounts before saving credentials.' })
    }
    const [usernameEncrypted, passwordEncrypted, xAuthEncrypted] = await Promise.all([
      encrypt(values[0], merchant.api_key_salt),
      encrypt(values[1], merchant.api_key_salt),
      encrypt(values[2], merchant.api_key_salt)
    ])
    const savedBaseUrl = String(eganowBaseUrl || '').trim() || null
    const savedCredentials = await withTransaction(async (client) => {
    const { rows: previousRows } = await client.query(
      'SELECT base_url, callback_url, is_enabled FROM merchant_eganow_credentials WHERE merchant_id = $1 FOR UPDATE',
      [req.params.merchantId]
    )
    const previous = previousRows[0] || null
    await client.query(
      `INSERT INTO merchant_eganow_credentials
         (merchant_id, api_username_encrypted, api_password_encrypted, x_auth_encrypted, base_url, callback_url, is_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (merchant_id) DO UPDATE SET
         api_username_encrypted = EXCLUDED.api_username_encrypted,
         api_password_encrypted = EXCLUDED.api_password_encrypted,
         x_auth_encrypted = EXCLUDED.x_auth_encrypted,
         base_url = EXCLUDED.base_url,
         callback_url = EXCLUDED.callback_url,
         is_enabled = TRUE,
         updated_at = now()`,
      [req.params.merchantId, usernameEncrypted, passwordEncrypted, xAuthEncrypted,
        savedBaseUrl, callback.href]
    )
    await client.query(`UPDATE merchants SET account_setup_status = 'ACTIVE', updated_at = now() WHERE id = $1`, [req.params.merchantId])
    await writePlatformAudit({
      actorUserId: req.user.id, tenantId: merchant.tenant_id, merchantId: req.params.merchantId,
      action: 'MERCHANT_EGANOW_CREDENTIALS_ROTATED', resourceType: 'merchant_eganow_credentials', resourceId: req.params.merchantId,
      details: {
        previous: previous ? { baseUrl: previous.base_url, callbackUrl: previous.callback_url, enabled: previous.is_enabled } : null,
        current: { baseUrl: savedBaseUrl, callbackUrl: callback.href, enabled: true }
      },
      ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null, requestId: req.id || null, client
    })
    return true
    })
    res.json({ ok: true, merchantId: req.params.merchantId, eganowCredentialsConfigured: savedCredentials })
  })
)

merchantsRouter.get(
  '/:merchantId',
  requirePermission('VIEW_MERCHANTS'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT m.id, m.tenant_id, m.display_name, m.vendor_reference, m.mobile_money_number, m.network_provider, m.payout_mode,
              m.eganow_collection_account_id, m.eganow_payout_account_id, m.account_setup_status, m.is_active, m.onboarded_at,
              ms.allow_manual_control, COALESCE(ms.notify_sms, TRUE) AS notify_sms,
              COALESCE(ms.notify_email, FALSE) AS notify_email, ms.contact_email
         FROM merchants m
         LEFT JOIN merchant_settings ms ON ms.tenant_id = m.tenant_id AND ms.merchant_id = m.id
        WHERE m.id = $1`,
      [req.params.merchantId]
    )
    if (rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })

    const merchant = rows[0]
    if (scopeOrRespond(req, res, merchant.tenant_id) === null) return
    if (req.user.merchantId && String(merchant.id) !== String(req.user.merchantId)) {
      return res.status(403).json({ message: 'You can only access your assigned merchant.' })
    }

    res.json({
      ...mapMerchant(merchant),
      allowManualControl: merchant.allow_manual_control,
      notifySms: merchant.notify_sms,
      notifyEmail: merchant.notify_email,
      contactEmail: merchant.contact_email
    })
  })
)

merchantsRouter.put(
  '/:merchantId',
  requirePermission('MANAGE_MERCHANTS'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id, mobile_money_number, is_active FROM merchants WHERE id = $1', [req.params.merchantId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return
    if (req.user.merchantId && String(req.params.merchantId) !== String(req.user.merchantId)) {
      return res.status(403).json({ message: 'You can only manage your assigned merchant.' })
    }

    const { displayName, mobileMoneyNumber, networkProvider, payoutMode, isActive } = req.body || {}
    if (existing.rows[0].is_active && isActive === false) {
      return res.status(409).json({ message: 'Merchant deactivation requires a reason. Use the deactivate action.' })
    }
    if (mobileMoneyNumber && mobileMoneyNumber !== existing.rows[0].mobile_money_number) {
      return res.status(409).json({ message: 'Payout destination changes require a request and approval by a different tenant administrator.' })
    }

    const result = await withTransaction(async (client) => {
      const { rows: beforeRows } = await client.query(
        `SELECT display_name, mobile_money_number, network_provider, payout_mode, is_active
           FROM merchants WHERE id = $1 FOR UPDATE`, [req.params.merchantId]
      )
      if (!beforeRows.length) return { missing: true }
      const previous = beforeRows[0]
      const { rows } = await client.query(
      `UPDATE merchants
          SET display_name = COALESCE($2, display_name),
              mobile_money_number = COALESCE($3, mobile_money_number),
              network_provider = COALESCE($4, network_provider),
              payout_mode = COALESCE($5, payout_mode),
              is_active = COALESCE($6, is_active)
        WHERE id = $1
        RETURNING id, display_name, vendor_reference, mobile_money_number, network_provider, payout_mode,
                  eganow_collection_account_id, eganow_payout_account_id, is_active, onboarded_at`,
      [
        req.params.merchantId,
        displayName || null,
        mobileMoneyNumber || null,
        networkProvider || null,
        payoutMode === 'AUTO_SWEEP' || payoutMode === 'MANUAL' ? payoutMode : null,
        typeof isActive === 'boolean' ? isActive : null
      ]
      )
      await writePlatformAudit({
        actorUserId: req.user.id,
        tenantId: existing.rows[0].tenant_id,
        merchantId: req.params.merchantId,
        action: 'MERCHANT_CONFIGURATION_CHANGED',
        resourceType: 'merchant',
        resourceId: req.params.merchantId,
        details: { previous, current: rows[0] },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.id || null,
        client
      })
      return { merchant: rows[0] }
    })
    if (result.missing) return res.status(404).json({ message: 'Merchant not found.' })
    res.json(mapMerchant(result.merchant))
  })
)

merchantsRouter.post(
  '/:merchantId/payout-destination-change-requests',
  requireRole('TENANT_ADMIN'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id FROM merchants WHERE id = $1', [req.params.merchantId])
    if (!existing.rows.length) return res.status(404).json({ message: 'Merchant not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return
    const requestedNumber = String(req.body?.mobileMoneyNumber || '').trim()
    if (!/^\+?[0-9]{8,16}$/.test(requestedNumber)) return res.status(400).json({ message: 'Provide a valid payout mobile number.' })
    const result = await requestMerchantPayoutDestinationChange({
      merchantId: req.params.merchantId, tenantId: existing.rows[0].tenant_id,
      requestedNumber, actor: req.user, request: req
    })
    if (result.pending) return res.status(409).json({ message: 'A payout destination change is already awaiting review.', requestId: result.pending })
    if (result.unchanged) return res.status(400).json({ message: 'The requested destination is already active.' })
    if (result.tenantMismatch) return res.status(403).json({ message: 'Merchant is outside your tenant scope.' })
    res.status(202).json({ message: 'Payout destination change submitted for independent approval.', request: result.request })
  })
)

merchantsRouter.post(
  '/payout-destination-change-requests/:requestId/review',
  requireRole('TENANT_ADMIN'),
  asyncHandler(async (req, res) => {
    const tenantId = scopeOrRespond(req, res, req.body?.tenantId)
    if (!tenantId) return
    const decision = String(req.body?.decision || '').toUpperCase()
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    if (!['APPROVED', 'REJECTED'].includes(decision) || (decision === 'REJECTED' && !reason)) {
      return res.status(400).json({ message: 'Choose approve or reject; a rejection reason is required.' })
    }
    const result = await reviewMerchantPayoutDestinationChange({
      requestId: req.params.requestId, tenantId, actor: req.user, decision, reason, request: req
    })
    if (result.missing) return res.status(404).json({ message: 'Payout destination change request not found.' })
    if (result.selfReview) return res.status(403).json({ message: 'The requester cannot review their own destination change.' })
    if (result.stale) return res.status(409).json({ message: 'The active payout destination changed after this request was made.' })
    if (result.decided) return res.status(409).json({ message: `This request was already ${result.status.toLowerCase()}.` })
    res.json({ request: result.request })
  })
)

merchantsRouter.delete(
  '/:merchantId',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    if (!reason || reason.length > 2000) return res.status(400).json({ message: 'Provide a reason of at most 2000 characters.' })
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT tenant_id, is_active FROM merchants WHERE id = $1 FOR UPDATE', [req.params.merchantId]
      )
      if (!rows.length) return { missing: true }
      const merchant = rows[0]
      if (scopeOrRespond(req, res, merchant.tenant_id) === null) return { forbidden: true }
      const { rows: history } = await client.query(
        'SELECT EXISTS (SELECT 1 FROM transactions WHERE merchant_id = $1) AS has_history', [req.params.merchantId]
      )
      if (history[0].has_history) {
        await client.query('UPDATE merchants SET is_active = FALSE, updated_at = now() WHERE id = $1', [req.params.merchantId])
        await writePlatformAudit({
          actorUserId: req.user.id, tenantId: merchant.tenant_id, merchantId: req.params.merchantId,
          action: 'MERCHANT_DEACTIVATED', resourceType: 'merchant', resourceId: req.params.merchantId,
          details: { previousIsActive: merchant.is_active, currentIsActive: false, reason },
          ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null, requestId: req.id || null, client
        })
        return { deactivated: true }
      }
      await writePlatformAudit({
        actorUserId: req.user.id, tenantId: merchant.tenant_id, merchantId: req.params.merchantId,
        action: 'MERCHANT_DELETED', resourceType: 'merchant', resourceId: req.params.merchantId,
        details: { reason }, ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null,
        requestId: req.id || null, client
      })
      await client.query('DELETE FROM merchants WHERE id = $1', [req.params.merchantId])
      return { deleted: true }
    })
    if (result.missing) return res.status(404).json({ message: 'Merchant not found.' })
    if (result.forbidden) return
    if (result.deactivated) return res.json({ deleted: false, isActive: false, message: 'Merchant has ledger history and was deactivated instead.' })
    res.json({ deleted: true })
  })
)

merchantsRouter.put(
  '/:merchantId/settings',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id FROM merchants WHERE id = $1', [req.params.merchantId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return

    const { allowManualControl, notifySms, notifyEmail } = req.body || {}
    const contactEmailProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'contactEmail')
    const contactEmail = typeof req.body?.contactEmail === 'string' ? req.body.contactEmail.trim().toLowerCase() : ''
    if (contactEmailProvided && contactEmail && (contactEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))) {
      return res.status(400).json({ message: 'contactEmail must be a valid email address of at most 255 characters.' })
    }
    const result = await withTransaction(async (client) => {
      const { rows: existingRows } = await client.query(
        'SELECT tenant_id FROM merchants WHERE id = $1 FOR UPDATE', [req.params.merchantId]
      )
      if (!existingRows.length) return { notFound: true }
      const tenantId = existingRows[0].tenant_id
      const { rows: currentSettings } = await client.query(
        'SELECT allow_manual_control, notify_sms, notify_email, contact_email FROM merchant_settings WHERE tenant_id = $1 AND merchant_id = $2 FOR UPDATE',
        [tenantId, req.params.merchantId]
      )
      const previous = currentSettings[0] || { allow_manual_control: false, notify_sms: true, notify_email: false, contact_email: null }
      const emailNotificationsEnabled = typeof notifyEmail === 'boolean' ? notifyEmail : previous.notify_email === true
      const resolvedContactEmail = contactEmailProvided ? contactEmail : previous.contact_email
      if (emailNotificationsEnabled && !resolvedContactEmail) return { invalidEmailSettings: true }

      const { rows } = await client.query(
      `INSERT INTO merchant_settings (tenant_id, merchant_id, allow_manual_control, notify_sms, notify_email, contact_email)
       VALUES ($1, $2, COALESCE($3, FALSE), COALESCE($4, TRUE), COALESCE($5, FALSE), NULLIF($7, ''))
       ON CONFLICT (tenant_id, merchant_id) DO UPDATE SET
         allow_manual_control = COALESCE($3, merchant_settings.allow_manual_control),
         notify_sms = COALESCE($4, merchant_settings.notify_sms),
         notify_email = COALESCE($5, merchant_settings.notify_email),
         contact_email = CASE WHEN $6 THEN NULLIF($7, '') ELSE merchant_settings.contact_email END,
         updated_at = now()
       RETURNING allow_manual_control, notify_sms, notify_email, contact_email`,
      [
        tenantId,
        req.params.merchantId,
        typeof allowManualControl === 'boolean' ? allowManualControl : null,
        typeof notifySms === 'boolean' ? notifySms : null,
        typeof notifyEmail === 'boolean' ? notifyEmail : null,
        contactEmailProvided,
        contactEmail
      ]
      )
      const current = rows[0]
      await writePlatformAudit({
        actorUserId: req.user.id,
        tenantId,
        merchantId: req.params.merchantId,
        action: 'MERCHANT_CONFIGURATION_CHANGED',
        resourceType: 'merchant_settings',
        resourceId: req.params.merchantId,
        details: {
          previous: { allowManualControl: previous.allow_manual_control, notifySms: previous.notify_sms, notifyEmail: previous.notify_email, contactEmail: previous.contact_email },
          current: { allowManualControl: current.allow_manual_control, notifySms: current.notify_sms, notifyEmail: current.notify_email, contactEmail: current.contact_email }
        },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.id || null,
        client
      })
      return { current }
    })

    if (result.notFound) return res.status(404).json({ message: 'Merchant not found.' })
    if (result.invalidEmailSettings) return res.status(400).json({ message: 'Set a contact email before enabling email notifications.' })
    const current = result.current

    res.json({
      allowManualControl: current.allow_manual_control,
      notifySms: current.notify_sms,
      notifyEmail: current.notify_email,
      contactEmail: current.contact_email
    })
  })
)

function mapMerchant(row) {
  return {
    id: row.id,
    vendorReference: row.vendor_reference,
    tenantId: row.tenant_id,
    tenantCompanyName: row.tenant_company_name,
    displayName: row.display_name,
    mobileMoneyNumber: row.mobile_money_number,
    networkProvider: row.network_provider,
    payoutMode: row.payout_mode,
    eganowCollectionAccountId: row.eganow_collection_account_id,
    eganowPayoutAccountId: row.eganow_payout_account_id,
    accountSetupStatus: row.account_setup_status || (row.eganow_collection_account_id && row.eganow_payout_account_id ? 'ACTIVE' : 'PENDING'),
    isActive: row.is_active,
    onboardedAt: row.onboarded_at
  }
}
