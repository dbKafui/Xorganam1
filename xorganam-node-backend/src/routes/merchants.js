import { Router } from 'express'
import { query } from '../db/pool.js'
import { authenticate, requireRole, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

export const merchantsRouter = Router()

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
  asyncHandler(async (req, res) => {
    const tenantId = scopeOrRespond(req, res, req.query.tenantId)
    if (!tenantId) return

    const { rows } = await query(
      `SELECT m.id, m.display_name, m.mobile_money_number, m.network_provider, m.payout_mode,
              m.eganow_collection_account_id, m.eganow_payout_account_id, m.is_active, m.onboarded_at,
              ms.allow_manual_control
         FROM merchants m
         LEFT JOIN merchant_settings ms ON ms.tenant_id = m.tenant_id AND ms.merchant_id = m.id
        WHERE m.tenant_id = $1
        ORDER BY m.onboarded_at DESC`,
      [tenantId]
    )

    res.json(rows.map(mapMerchant))
  })
)

merchantsRouter.post(
  '/',
  requireRole('TENANT_MANAGER'),
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

    if (!displayName || !mobileMoneyNumber || !networkProvider || !eganowCollectionAccountId || !eganowPayoutAccountId) {
      return res.status(400).json({ message: 'displayName, mobileMoneyNumber, networkProvider, and both Eganow account IDs are required.' })
    }

    try {
      const { rows } = await query(
        `INSERT INTO merchants
           (tenant_id, display_name, mobile_money_number, network_provider, payout_mode,
            eganow_collection_account_id, eganow_payout_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, display_name, mobile_money_number, network_provider, payout_mode,
                   eganow_collection_account_id, eganow_payout_account_id, is_active, onboarded_at`,
        [
          tenantId,
          displayName,
          mobileMoneyNumber,
          networkProvider,
          payoutMode === 'AUTO_SWEEP' ? 'AUTO_SWEEP' : 'MANUAL',
          eganowCollectionAccountId,
          eganowPayoutAccountId
        ]
      )

      res.status(201).json({ ...mapMerchant(rows[0]), allowManualControl: false })
    } catch (err) {
      if (err.code === '23505') {
        // unique violation on (tenant_id, eganow_collection_account_id) or (tenant_id, eganow_payout_account_id)
        return res.status(409).json({ message: 'One of these Eganow account IDs is already assigned to another merchant.' })
      }
      throw err
    }
  })
)

merchantsRouter.get(
  '/:merchantId',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT m.id, m.tenant_id, m.display_name, m.mobile_money_number, m.network_provider, m.payout_mode,
              m.eganow_collection_account_id, m.eganow_payout_account_id, m.is_active, m.onboarded_at,
              ms.allow_manual_control, ms.notify_sms, ms.notify_email, ms.contact_email
         FROM merchants m
         LEFT JOIN merchant_settings ms ON ms.tenant_id = m.tenant_id AND ms.merchant_id = m.id
        WHERE m.id = $1`,
      [req.params.merchantId]
    )
    if (rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })

    const merchant = rows[0]
    if (scopeOrRespond(req, res, merchant.tenant_id) === null) return

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
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id FROM merchants WHERE id = $1', [req.params.merchantId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return

    const { displayName, mobileMoneyNumber, networkProvider, payoutMode, isActive } = req.body || {}

    const { rows } = await query(
      `UPDATE merchants
          SET display_name = COALESCE($2, display_name),
              mobile_money_number = COALESCE($3, mobile_money_number),
              network_provider = COALESCE($4, network_provider),
              payout_mode = COALESCE($5, payout_mode),
              is_active = COALESCE($6, is_active)
        WHERE id = $1
        RETURNING id, display_name, mobile_money_number, network_provider, payout_mode,
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

merchantsRouter.put(
  '/:merchantId/settings',
  requireRole('TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT tenant_id FROM merchants WHERE id = $1', [req.params.merchantId])
    if (existing.rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })
    if (scopeOrRespond(req, res, existing.rows[0].tenant_id) === null) return

    const { allowManualControl, notifySms, notifyEmail, contactEmail } = req.body || {}

    const { rows } = await query(
      `UPDATE merchant_settings
          SET allow_manual_control = COALESCE($2, allow_manual_control),
              notify_sms = COALESCE($3, notify_sms),
              notify_email = COALESCE($4, notify_email),
              contact_email = COALESCE($5, contact_email)
        WHERE merchant_id = $1
        RETURNING allow_manual_control, notify_sms, notify_email, contact_email`,
      [
        req.params.merchantId,
        typeof allowManualControl === 'boolean' ? allowManualControl : null,
        typeof notifySms === 'boolean' ? notifySms : null,
        typeof notifyEmail === 'boolean' ? notifyEmail : null,
        contactEmail || null
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
    displayName: row.display_name,
    mobileMoneyNumber: row.mobile_money_number,
    networkProvider: row.network_provider,
    payoutMode: row.payout_mode,
    eganowCollectionAccountId: row.eganow_collection_account_id,
    eganowPayoutAccountId: row.eganow_payout_account_id,
    isActive: row.is_active,
    onboardedAt: row.onboarded_at
  }
}
