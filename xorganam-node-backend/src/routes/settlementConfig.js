import { Router } from 'express'
import { query } from '../db/pool.js'
import { authenticate, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

export const settlementConfigRouter = Router()
settlementConfigRouter.use(authenticate)

function tenantScope(req, res, requestedTenantId) {
  try {
    return resolveTenantScope(req, requestedTenantId)
  } catch (error) {
    if (error instanceof ForbiddenError) {
      res.status(403).json({ message: error.message })
      return null
    }
    throw error
  }
}

function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return null
  const unit = String(schedule.unit || '').toUpperCase()
  const interval = Number(schedule.interval)
  if (!['DAYS', 'WEEKS', 'MONTHS', 'YEARS'].includes(unit) || !Number.isInteger(interval) || interval < 1) {
    return null
  }
  return { unit, interval }
}

function compareSchedules(left, right) {
  const units = { DAYS: 1, WEEKS: 7, MONTHS: 30, YEARS: 365 }
  return units[left.unit] * left.interval - units[right.unit] * right.interval
}

function scheduleWithinBounds(schedule, minimum, maximum) {
  if (!schedule) return false
  if (minimum && compareSchedules(schedule, minimum) < 0) return false
  if (maximum && compareSchedules(schedule, maximum) > 0) return false
  return true
}

function parsePolicySchedule(value) {
  if (!value) return null
  return normalizeSchedule(value)
}

settlementConfigRouter.get(
  '/options',
  asyncHandler(async (req, res) => {
    const tenantId = tenantScope(req, res, req.query.tenantId)
    if (!tenantId) return

    const { rows } = await query(
      `SELECT l.institution_id, i.name AS institution_name,
              COALESCE(p.frequency_mode_min, l.frequency_mode_min) AS frequency_mode_min,
              COALESCE(p.frequency_mode_max, l.frequency_mode_max) AS frequency_mode_max,
              COALESCE(p.periodic_schedule_min, l.periodic_schedule_min) AS periodic_schedule_min,
              COALESCE(p.periodic_schedule_max, l.periodic_schedule_max) AS periodic_schedule_max,
              COALESCE(p.priority_deduction_allowed, l.priority_deduction_allowed) AS priority_deduction_allowed,
              COALESCE(p.vendor_payout_modes, '["PER_TRANSACTION"]'::jsonb) AS vendor_payout_modes
         FROM tenant_institution_links l
         JOIN institutions i ON i.id = l.institution_id
         LEFT JOIN institution_policy p
           ON p.institution_id = l.institution_id AND p.effective_to IS NULL
        WHERE l.tenant_id = $1 AND l.status = 'ACTIVE'
        ORDER BY i.name`,
      [tenantId]
    )

    res.json(rows.map((row) => ({
      institutionId: row.institution_id,
      institutionName: row.institution_name,
      frequencyMode: {
        minimum: row.frequency_mode_min,
        maximum: row.frequency_mode_max
      },
      periodicSchedule: {
        minimum: parsePolicySchedule(row.periodic_schedule_min),
        maximum: parsePolicySchedule(row.periodic_schedule_max)
      },
      priorityDeductionAllowed: row.priority_deduction_allowed,
      vendorPayoutModes: row.vendor_payout_modes
    })))
  })
)

settlementConfigRouter.put(
  '/merchants/:merchantId/:institutionId',
  asyncHandler(async (req, res) => {
    const tenantId = tenantScope(req, res, req.body?.tenantId)
    if (!tenantId) return

    const { merchantId, institutionId } = req.params
    const { frequencyMode, periodicSchedule, priorityDeductionSelected, vendorPayoutMode, scheduleAnchorDate } = req.body || {}
    if (!['PER_TRANSACTION', 'PERIODIC'].includes(frequencyMode)) {
      return res.status(400).json({ message: 'frequencyMode must be PER_TRANSACTION or PERIODIC.' })
    }

    const normalizedSchedule = frequencyMode === 'PERIODIC' ? normalizeSchedule(periodicSchedule) : null
    if (frequencyMode === 'PERIODIC' && !normalizedSchedule) {
      return res.status(400).json({ message: 'periodicSchedule must include a valid unit and positive interval.' })
    }

    const { rows: bounds } = await query(
      `SELECT COALESCE(p.frequency_mode_min, l.frequency_mode_min) AS frequency_mode_min,
              COALESCE(p.frequency_mode_max, l.frequency_mode_max) AS frequency_mode_max,
              COALESCE(p.periodic_schedule_min, l.periodic_schedule_min) AS periodic_schedule_min,
              COALESCE(p.periodic_schedule_max, l.periodic_schedule_max) AS periodic_schedule_max,
              COALESCE(p.priority_deduction_allowed, l.priority_deduction_allowed) AS priority_deduction_allowed,
              COALESCE(p.vendor_payout_modes, '["PER_TRANSACTION"]'::jsonb) AS vendor_payout_modes
         FROM tenant_institution_links l
         LEFT JOIN institution_policy p
           ON p.institution_id = l.institution_id AND p.effective_to IS NULL
        WHERE l.tenant_id = $1 AND l.institution_id = $2 AND l.status = 'ACTIVE'`,
      [tenantId, institutionId]
    )
    if (bounds.length === 0) return res.status(404).json({ message: 'Active institution link not found.' })

    const bound = bounds[0]
    const allowedVendorModes = Array.isArray(bound.vendor_payout_modes)
      ? bound.vendor_payout_modes
      : ['PER_TRANSACTION']
    if (!allowedVendorModes.includes(vendorPayoutMode || 'PER_TRANSACTION')) {
      return res.status(400).json({ message: 'The selected vendor payout mode is not allowed by the institution.' })
    }
    if (bound.frequency_mode_min === 'PERIODIC' && frequencyMode !== 'PERIODIC') {
      return res.status(400).json({ message: 'This institution requires periodic settlement.' })
    }
    if (bound.frequency_mode_max === 'PER_TRANSACTION' && frequencyMode !== 'PER_TRANSACTION') {
      return res.status(400).json({ message: 'This institution does not permit periodic settlement.' })
    }

    const minimum = parsePolicySchedule(bound.periodic_schedule_min)
    const maximum = parsePolicySchedule(bound.periodic_schedule_max)
    if (normalizedSchedule && !scheduleWithinBounds(normalizedSchedule, minimum, maximum)) {
      return res.status(400).json({ message: 'periodicSchedule is outside the institution policy bounds.' })
    }
    if (priorityDeductionSelected && !bound.priority_deduction_allowed) {
      return res.status(400).json({ message: 'Priority deduction is not allowed by the institution policy.' })
    }
    const anchorDate = scheduleAnchorDate || new Date().toISOString().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) {
      return res.status(400).json({ message: 'scheduleAnchorDate must be YYYY-MM-DD.' })
    }

    const merchant = await query(
      'SELECT 1 FROM merchants WHERE id = $1 AND tenant_id = $2 AND is_active',
      [merchantId, tenantId]
    )
    if (merchant.rows.length === 0) return res.status(404).json({ message: 'Active merchant not found.' })

    const { rows } = await query(
      `INSERT INTO tenant_merchant_settlement_config
         (tenant_id, merchant_id, institution_id, frequency_mode, periodic_schedule,
          priority_deduction_selected, created_by_user_id, vendor_payout_mode, schedule_anchor_date)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, merchant_id, institution_id)
       DO UPDATE SET frequency_mode = EXCLUDED.frequency_mode,
                     periodic_schedule = EXCLUDED.periodic_schedule,
                     priority_deduction_selected = EXCLUDED.priority_deduction_selected,
                     created_by_user_id = EXCLUDED.created_by_user_id,
                     vendor_payout_mode = EXCLUDED.vendor_payout_mode,
                     schedule_anchor_date = EXCLUDED.schedule_anchor_date,
                     updated_at = now()
       RETURNING id, institution_id, frequency_mode, periodic_schedule,
                 priority_deduction_selected, updated_at`,
      [
        tenantId,
        merchantId,
        institutionId,
        frequencyMode,
        normalizedSchedule ? JSON.stringify(normalizedSchedule) : null,
        Boolean(priorityDeductionSelected),
        req.user.id,
        vendorPayoutMode || 'PER_TRANSACTION',
        anchorDate
      ]
    )

    res.json(rows[0])
  })
)
