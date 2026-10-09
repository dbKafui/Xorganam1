import { Router } from 'express'
import { query } from '../db/pool.js'
import { authenticate, requireRole, requirePermission, requirePlatformAdmin, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { createVendorReference } from '../services/referenceIds.js'
import { encrypt } from '../security/encryption.js'

export const merchantsRouter = Router()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

merchantsRouter.use(authenticate)

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
      const { rows } = await query(
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

      res.status(201).json({ ...mapMerchant(rows[0]), allowManualControl: false })
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
      const { rows } = await query(
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
      if (!rows.length) return res.status(404).json({ message: 'Merchant not found.' })
      res.json({ ok: true, merchantId: rows[0].id, accountSetupStatus: rows[0].account_setup_status })
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
    await query(
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
        String(eganowBaseUrl || '').trim() || null, callback.href]
    )
    await query(`UPDATE merchants SET account_setup_status = 'ACTIVE', updated_at = now() WHERE id = $1`, [req.params.merchantId])
    res.json({ ok: true, merchantId: req.params.merchantId, eganowCredentialsConfigured: true })
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
    const existing = await query('SELECT tenant_id FROM merchants WHERE id = $1', [req.params.merchantId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return
    if (req.user.merchantId && String(req.params.merchantId) !== String(req.user.merchantId)) {
      return res.status(403).json({ message: 'You can only manage your assigned merchant.' })
    }

    const { displayName, mobileMoneyNumber, networkProvider, payoutMode, isActive } = req.body || {}

    const { rows } = await query(
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

    res.json(mapMerchant(rows[0]))
  })
)

merchantsRouter.delete(
  '/:merchantId',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id FROM merchants WHERE id = $1', [req.params.merchantId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return

    const txnCount = await query('SELECT COUNT(*)::int AS count FROM transactions WHERE merchant_id = $1', [req.params.merchantId])
    if (txnCount.rows[0].count > 0) {
      await query('UPDATE merchants SET is_active = FALSE WHERE id = $1', [req.params.merchantId])
      return res.json({ deleted: false, isActive: false, message: 'Merchant has ledger history and was deactivated instead.' })
    }

    await query('DELETE FROM merchants WHERE id = $1', [req.params.merchantId])
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
    const { rows: currentSettings } = await query(
      'SELECT notify_email, contact_email FROM merchant_settings WHERE tenant_id = $1 AND merchant_id = $2',
      [existing.rows[0].tenant_id, req.params.merchantId]
    )
    const emailNotificationsEnabled = typeof notifyEmail === 'boolean' ? notifyEmail : currentSettings[0]?.notify_email === true
    const resolvedContactEmail = contactEmailProvided ? contactEmail : currentSettings[0]?.contact_email
    if (emailNotificationsEnabled && !resolvedContactEmail) {
      return res.status(400).json({ message: 'Set a contact email before enabling email notifications.' })
    }

    const { rows } = await query(
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
        existing.rows[0].tenant_id,
        req.params.merchantId,
        typeof allowManualControl === 'boolean' ? allowManualControl : null,
        typeof notifySms === 'boolean' ? notifySms : null,
        typeof notifyEmail === 'boolean' ? notifyEmail : null,
        contactEmailProvided,
        contactEmail
      ]
    )

    res.json({
      allowManualControl: rows[0].allow_manual_control,
      notifySms: rows[0].notify_sms,
      notifyEmail: rows[0].notify_email,
      contactEmail: rows[0].contact_email
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
