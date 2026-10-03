import { Router } from 'express'
import { query, withTransaction } from '../db/pool.js'
import { authenticate, resolveTenantScope, requireAnyRole } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

export const tenantPortalRouter = Router()
tenantPortalRouter.use(authenticate)

function normalizeSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const unit = String(value.unit || '').toUpperCase()
  const interval = Number(value.interval)
  if (!['DAYS', 'WEEKS', 'MONTHS', 'YEARS'].includes(unit) || !Number.isInteger(interval) || interval < 1) return null
  return { unit, interval }
}

function scheduleDays(schedule) {
  const factor = { DAYS: 1, WEEKS: 7, MONTHS: 30, YEARS: 365 }
  return schedule ? factor[schedule.unit] * schedule.interval : null
}

function validateScheduleBounds(schedule, minimum, maximum) {
  const value = scheduleDays(schedule)
  const min = scheduleDays(normalizeSchedule(minimum))
  const max = scheduleDays(normalizeSchedule(maximum))
  return value !== null && (min === null || value >= min) && (max === null || value <= max)
}

function checkBranchManagerMerchant(req, res, merchantId) {
  if (req.user.role !== 'TENANT_BRANCH_MANAGER') return true
  if (String(req.user.merchantId) === String(merchantId)) return true
  res.status(403).json({ message: 'Branch managers can only access their assigned merchant.' })
  return false
}

tenantPortalRouter.get(
  '/institution-links/:tenantId',
  asyncHandler(async (req, res) => {
    const tenantId = resolveTenantScope(req, req.params.tenantId)
    const { rows } = await query(
      `SELECT l.id, l.tenant_id, l.institution_id, l.member_id, l.verification_status,
              l.verification_method, l.verified_at, l.status, l.linked_at,
              l.min_percentage, l.max_percentage, l.min_fixed_amount, l.max_fixed_amount,
              l.frequency_mode_min, l.frequency_mode_max, l.periodic_schedule_min,
              l.periodic_schedule_max, l.priority_deduction_allowed,
              i.name AS institution_name
         FROM tenant_institution_links l
         JOIN institutions i ON i.id = l.institution_id
        WHERE l.tenant_id = $1
        ORDER BY l.linked_at DESC`,
      [tenantId]
    )
    res.json(rows)
  })
)

tenantPortalRouter.get(
  '/split-rules',
  asyncHandler(async (req, res) => {
    const tenantId = resolveTenantScope(req, req.query.tenantId)
    const merchantId = req.query.merchantId
    if (!merchantId) return res.status(400).json({ message: 'merchantId is required.' })
    if (!checkBranchManagerMerchant(req, res, merchantId)) return

    const merchant = await query(
      'SELECT id FROM merchants WHERE id = $1 AND tenant_id = $2 AND is_active',
      [merchantId, tenantId]
    )
    if (!merchant.rows.length) return res.status(404).json({ message: 'Active merchant not found.' })

    const { rows } = await query(
      `SELECT l.institution_id, i.name AS institution_name, r.id AS rule_id,
              r.scope_level, r.mode, r.type, r.amount, r.periodic_frequency,
              r.periodic_interval, r.leg_execution_order, r.effective_from,
              r.effective_to, smc.vendor_payout_mode, smc.periodic_schedule,
              smc.priority_deduction_selected
         FROM tenant_institution_links l
         JOIN institutions i ON i.id = l.institution_id
         LEFT JOIN tenant_merchant_settlement_config smc
           ON smc.tenant_id = l.tenant_id AND smc.institution_id = l.institution_id
          AND smc.merchant_id = $2
         LEFT JOIN LATERAL (
           SELECT candidate.*
             FROM split_rules candidate
            WHERE candidate.tenant_id = l.tenant_id
              AND candidate.institution_id = l.institution_id
              AND candidate.active
              AND candidate.effective_from <= now()
              AND (candidate.effective_to IS NULL OR candidate.effective_to > now())
              AND (
                (candidate.scope_level = 'MERCHANT_OVERRIDE' AND candidate.merchant_id = $2)
                OR (candidate.scope_level = 'TENANT_DEFAULT' AND candidate.merchant_id IS NULL)
              )
            ORDER BY CASE WHEN candidate.scope_level = 'MERCHANT_OVERRIDE' THEN 0 ELSE 1 END,
                     candidate.effective_from DESC, candidate.created_at DESC
            LIMIT 1
         ) r ON TRUE
        WHERE l.tenant_id = $1 AND l.status = 'ACTIVE'
          AND l.verification_status = 'APPROVED'
          AND EXISTS (SELECT 1 FROM merchants m WHERE m.id = $2 AND m.tenant_id = $1 AND m.is_active)
        ORDER BY i.name`,
      [tenantId, merchantId]
    )
    res.json(rows.map((row) => ({ ...row, resolved: true, hasRule: Boolean(row.rule_id) })))
  })
)

tenantPortalRouter.put(
  '/split-rules/default',
  requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const tenantId = resolveTenantScope(req, req.body?.tenantId)
    const { institutionId, type, mode, legExecutionOrder = 'VENDOR_FIRST' } = req.body || {}
    const amount = Number(req.body?.amount)
    const schedule = mode === 'PERIODIC' ? normalizeSchedule(req.body?.periodicSchedule) : null
    if (!institutionId || !['PERCENTAGE', 'FIXED'].includes(type) ||
        !Number.isFinite(amount) || amount <= 0 ||
        !['PER_TRANSACTION', 'PERIODIC'].includes(mode) ||
        !['VENDOR_FIRST', 'INSTITUTION_FIRST'].includes(legExecutionOrder) ||
        (mode === 'PERIODIC' && !schedule)) {
      return res.status(400).json({ message: 'Provide an institution, positive split amount, supported type and mode, and a valid periodic schedule when applicable.' })
    }
    if (type === 'PERCENTAGE' && amount > 100) {
      return res.status(400).json({ message: 'Percentage amount cannot exceed 100.' })
    }

    const result = await withTransaction(async (tx) => {
      const { rows: links } = await tx.query(
        `SELECT l.min_percentage, l.max_percentage, l.min_fixed_amount, l.max_fixed_amount,
                COALESCE(p.frequency_mode_min, l.frequency_mode_min) AS frequency_mode_min,
                COALESCE(p.frequency_mode_max, l.frequency_mode_max) AS frequency_mode_max,
                COALESCE(p.periodic_schedule_min, l.periodic_schedule_min) AS periodic_schedule_min,
                COALESCE(p.periodic_schedule_max, l.periodic_schedule_max) AS periodic_schedule_max,
                COALESCE(p.priority_deduction_allowed, l.priority_deduction_allowed) AS priority_deduction_allowed
           FROM tenant_institution_links l
           JOIN institutions i ON i.id = l.institution_id AND i.status = 'ACTIVE'
           LEFT JOIN institution_policy p
             ON p.institution_id = l.institution_id AND p.effective_to IS NULL
          WHERE l.tenant_id = $1 AND l.institution_id = $2
            AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
          FOR UPDATE OF l`,
        [tenantId, institutionId]
      )
      if (!links.length) return { notReady: true }
      const link = links[0]
      const minimumRaw = type === 'PERCENTAGE' ? link.min_percentage : link.min_fixed_amount
      const maximumRaw = type === 'PERCENTAGE' ? link.max_percentage : link.max_fixed_amount
      const minimum = minimumRaw === null ? 0 : Number(minimumRaw)
      const maximum = maximumRaw === null ? (type === 'PERCENTAGE' ? 100 : Number.MAX_SAFE_INTEGER) : Number(maximumRaw)
      if (amount < minimum || amount > maximum) return { outOfBounds: true, minimum, maximum }
      if ((link.frequency_mode_min === 'PERIODIC' && mode !== 'PERIODIC') ||
          (link.frequency_mode_max === 'PER_TRANSACTION' && mode !== 'PER_TRANSACTION')) {
        return { modeNotAllowed: true }
      }
      if (mode === 'PERIODIC' &&
          !validateScheduleBounds(schedule, link.periodic_schedule_min, link.periodic_schedule_max)) {
        return { scheduleNotAllowed: true }
      }
      if (legExecutionOrder === 'INSTITUTION_FIRST' && !link.priority_deduction_allowed) {
        return { priorityNotAllowed: true }
      }

      await tx.query(
        `UPDATE split_rules
            SET active = FALSE, effective_to = now()
          WHERE tenant_id = $1 AND institution_id = $2
            AND scope_level = 'TENANT_DEFAULT' AND active`,
        [tenantId, institutionId]
      )
      const { rows } = await tx.query(
        `INSERT INTO split_rules
           (tenant_id, institution_id, scope_level, mode, type, amount,
            periodic_frequency, periodic_interval, leg_execution_order, active)
         VALUES ($1, $2, 'TENANT_DEFAULT', $3, $4, $5, $6, $7, $8, TRUE)
         RETURNING id, institution_id, scope_level, mode, type, amount,
                   periodic_frequency, periodic_interval, leg_execution_order`,
        [tenantId, institutionId, mode, type, amount,
          schedule?.unit || null, schedule?.interval || 1, legExecutionOrder]
      )
      return { row: rows[0] }
    })

    if (result.notReady) return res.status(409).json({ message: 'An active, approved institution link is required before configuring a tenant default split.' })
    if (result.outOfBounds) return res.status(400).json({ message: 'Split amount is outside the institution boundary.', minimum: result.minimum, maximum: result.maximum })
    if (result.modeNotAllowed) return res.status(409).json({ message: 'Configured settlement mode is not permitted by the institution policy.' })
    if (result.scheduleNotAllowed) return res.status(409).json({ message: 'Configured periodic schedule is outside the institution policy boundary.' })
    if (result.priorityNotAllowed) return res.status(409).json({ message: 'Institution-first deduction is not permitted by the institution policy.' })
    res.json(result.row)
  })
)

tenantPortalRouter.put(
  '/split-rules/:merchantId',
  requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'),
  asyncHandler(async (req, res) => {
    const tenantId = resolveTenantScope(req, req.body?.tenantId)
    const { institutionId, type } = req.body || {}
    const amount = Number(req.body?.amount)
    if (!checkBranchManagerMerchant(req, res, req.params.merchantId)) return
    if (!institutionId || !['PERCENTAGE', 'FIXED'].includes(type) || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'institutionId, type (PERCENTAGE or FIXED), and a positive numeric amount are required.' })
    }
    if (type === 'PERCENTAGE' && amount > 100) {
      return res.status(400).json({ message: 'Percentage amount cannot exceed 100.' })
    }

    const result = await withTransaction(async (tx) => {
      const { rows: state } = await tx.query(
        `SELECT m.account_setup_status,
                l.min_percentage, l.max_percentage, l.min_fixed_amount, l.max_fixed_amount,
                COALESCE(p.frequency_mode_min, l.frequency_mode_min) AS frequency_mode_min,
                COALESCE(p.frequency_mode_max, l.frequency_mode_max) AS frequency_mode_max,
                COALESCE(p.periodic_schedule_min, l.periodic_schedule_min) AS periodic_schedule_min,
                COALESCE(p.periodic_schedule_max, l.periodic_schedule_max) AS periodic_schedule_max,
                COALESCE(p.priority_deduction_allowed, l.priority_deduction_allowed) AS priority_deduction_allowed,
                smc.frequency_mode, smc.periodic_schedule, smc.priority_deduction_selected
           FROM merchants m
           JOIN tenant_institution_links l
             ON l.tenant_id = m.tenant_id AND l.institution_id = $3
           LEFT JOIN institution_policy p
             ON p.institution_id = l.institution_id AND p.effective_to IS NULL
           JOIN tenant_merchant_settlement_config smc
             ON smc.tenant_id = m.tenant_id AND smc.merchant_id = m.id
            AND smc.institution_id = l.institution_id
          WHERE m.id = $1 AND m.tenant_id = $2 AND m.is_active
            AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
          FOR UPDATE OF l, m`,
        [req.params.merchantId, tenantId, institutionId]
      )
      if (!state.length) return { notReady: true }
      const config = state[0]
      if (config.account_setup_status && config.account_setup_status !== 'ACTIVE') return { pendingAccounts: true }

      const minRaw = type === 'PERCENTAGE' ? config.min_percentage : config.min_fixed_amount
      const maxRaw = type === 'PERCENTAGE' ? config.max_percentage : config.max_fixed_amount
      const minimum = minRaw === null ? 0 : Number(minRaw)
      const maximum = maxRaw === null ? (type === 'PERCENTAGE' ? 100 : Number.MAX_SAFE_INTEGER) : Number(maxRaw)
      if (amount < minimum || amount > maximum) return { outOfBounds: true, min: minimum, max: maximum }

      const mode = config.frequency_mode
      if (!['PER_TRANSACTION', 'PERIODIC'].includes(mode)) return { invalidMode: true }
      if (config.frequency_mode_min === 'PERIODIC' && mode !== 'PERIODIC') return { frequencyNotAllowed: true }
      if (config.frequency_mode_max === 'PER_TRANSACTION' && mode !== 'PER_TRANSACTION') return { frequencyNotAllowed: true }
      if (config.priority_deduction_selected && !config.priority_deduction_allowed) return { priorityNotAllowed: true }

      const schedule = mode === 'PERIODIC' ? normalizeSchedule(config.periodic_schedule) : null
      if (mode === 'PERIODIC' &&
          (!schedule || !validateScheduleBounds(schedule, config.periodic_schedule_min, config.periodic_schedule_max))) {
        return { scheduleNotAllowed: true }
      }

      await tx.query(
        `UPDATE split_rules
            SET active = FALSE, effective_to = now()
          WHERE tenant_id = $1 AND merchant_id = $2 AND institution_id = $3
            AND scope_level = 'MERCHANT_OVERRIDE' AND active`,
        [tenantId, req.params.merchantId, institutionId]
      )
      const { rows } = await tx.query(
        `INSERT INTO split_rules
           (tenant_id, merchant_id, institution_id, scope_level, mode, type, amount,
            periodic_frequency, periodic_interval, leg_execution_order, active)
         VALUES ($1, $2, $3, 'MERCHANT_OVERRIDE', $4, $5, $6, $7, $8, $9, TRUE)
         RETURNING id, institution_id, scope_level, mode, type, amount,
                   periodic_frequency, periodic_interval, leg_execution_order`,
        [tenantId, req.params.merchantId, institutionId, mode, type, amount,
          schedule?.unit || null, schedule?.interval || 1,
          config.priority_deduction_selected ? 'INSTITUTION_FIRST' : 'VENDOR_FIRST']
      )
      return { row: rows[0] }
    })

    if (result.notReady) return res.status(409).json({ message: 'Activate the merchant, approve the institution link, and save settlement preferences before configuring split settlement.' })
    if (result.pendingAccounts) return res.status(409).json({ message: 'Activate merchant payment accounts before configuring split settlement.' })
    if (result.outOfBounds) return res.status(400).json({ message: 'Split amount is outside the institution boundary.', minimum: result.min, maximum: result.max })
    if (result.invalidMode || result.frequencyNotAllowed) return res.status(409).json({ message: 'Configured settlement mode is not permitted by the institution policy.' })
    if (result.priorityNotAllowed) return res.status(409).json({ message: 'Priority deduction is not permitted by the institution policy.' })
    if (result.scheduleNotAllowed) return res.status(409).json({ message: 'Configured periodic schedule is outside the institution policy boundary.' })
    res.json(result.row)
  })
)

tenantPortalRouter.post(
  '/disputes',
  requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_OPERATOR', 'TENANT_BRANCH_MANAGER'),
  asyncHandler(async (req, res) => {
    const { tenantId: requestedTenantId, merchantId, transactionId, reason } = req.body || {}
    if (!merchantId || !transactionId || typeof reason !== 'string' || !reason.trim() || reason.length > 4000) {
      return res.status(400).json({ message: 'merchantId, transactionId, and a reason up to 4000 characters are required.' })
    }
    const tenantId = resolveTenantScope(req, requestedTenantId || req.user.tenantId)
    if (!checkBranchManagerMerchant(req, res, merchantId)) return
    const transaction = await query(
      `SELECT t.id, t.tenant_id, t.merchant_id,
              COALESCE(t.institution_id,
                (SELECT c.institution_id FROM transactions c
                  WHERE c.parent_transaction_id = t.id AND c.institution_id IS NOT NULL LIMIT 1)) AS institution_id,
              t.status, t.type
         FROM transactions t
        WHERE t.id = $1 AND t.tenant_id = $2 AND t.merchant_id = $3`,
      [transactionId, tenantId, merchantId]
    )
    if (!transaction.rows.length) return res.status(404).json({ message: 'Transaction not found for this merchant.' })
    const txn = transaction.rows[0]
    const reconciliation = await query('SELECT * FROM split_reconciliation WHERE parent_transaction_id = $1', [txn.id])
    const partial = txn.status === 'PARTIALLY_SETTLED' ||
      reconciliation.rows.some((row) => row.vendor_leg_status === 'FAILED' || row.institution_leg_status === 'FAILED')
    if (!partial) return res.status(409).json({ message: 'A dispute can be raised after a split payment has partially settled.' })
    if (!txn.institution_id) return res.status(409).json({ message: 'No institution is associated with this transaction.' })
    const dispute = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO institution_dispute
           (institution_id, tenant_id, merchant_id, transaction_id,
            raised_by_tenant_user_id, channel, reason)
         VALUES ($1, $2, $3, $4, $5, 'APP', $6)
         RETURNING *`,
        [txn.institution_id, tenantId, merchantId, transactionId, req.user.id, reason.trim()]
      )
      await client.query(
        `INSERT INTO institution_audit_log
           (institution_id, dispute_id, actor_user_id, action, note)
         VALUES ($1, $2, $3, 'DISPUTE_RAISED', $4)`,
        [txn.institution_id, rows[0].id, req.user.id, { channel: 'APP' }]
      )
      return rows[0]
    })
    res.status(201).json(dispute)
  })
)
