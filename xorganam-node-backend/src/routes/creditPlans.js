import { Router } from 'express'
import { query, withTransaction } from '../db/pool.js'
import { authenticate, requireAnyRole, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { recordCreditWebhookEvent } from '../services/creditWebhookOutbox.js'
import { issueInstallmentToken, verifyInstallmentToken, installmentPaymentUrl } from '../services/creditInstallmentToken.js'
import { initiateCollection, CollectionRejectedError } from '../services/collectionService.js'

export const creditPlansRouter = Router()
export const creditPaymentsRouter = Router()
creditPlansRouter.use(authenticate)

function tenantScope(req, res) {
  try { return resolveTenantScope(req, req.query.tenantId || req.body?.tenantId) } catch (error) {
    if (error instanceof ForbiddenError) { res.status(403).json({ message: error.message }); return null }
    throw error
  }
}

function normalizeMsisdn(value) {
  const digits = String(value || '').trim().replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) return `233${digits.slice(1)}`
  if (digits.startsWith('233') && digits.length === 12) return digits
  if (digits.startsWith('2330') && digits.length === 13) return `233${digits.slice(4)}`
  if (digits.length === 9) return `233${digits}`
  return null
}

function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function addDueDate(firstDueDate, frequency, offset) {
  const date = new Date(`${firstDueDate}T00:00:00.000Z`)
  if (frequency === 'DAILY') date.setUTCDate(date.getUTCDate() + offset)
  else if (frequency === 'WEEKLY') date.setUTCDate(date.getUTCDate() + offset * 7)
  else {
    const day = date.getUTCDate()
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() + offset)
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
    date.setUTCDate(Math.min(day, lastDay))
  }
  return date.toISOString().slice(0, 10)
}

function amountCents(value, field) {
  const decimal = String(value ?? '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(decimal)) {
    throw new Error(`${field} must be a non-negative amount with at most two decimal places.`)
  }
  const [whole, fraction = ''] = decimal.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) throw new Error(`${field} is too large.`)
  return cents
}

creditPlansRouter.post('/', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  const input = req.body || {}
  const merchantId = String(input.merchantId || '')
  if (req.user.role === 'TENANT_BRANCH_MANAGER' && req.user.merchantId !== merchantId) {
    return res.status(403).json({ message: 'Branch managers can only create credit plans for their assigned merchant.' })
  }
  const customerIdentifier = normalizeMsisdn(input.customerIdentifier)
  const frequency = String(input.installmentFrequency || '').toUpperCase()
  const count = Number(input.installmentCount)
  const firstDueDate = input.firstDueDate
  if (!merchantId || !customerIdentifier || !['DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency) || !Number.isInteger(count) || count < 1 || count > 120 || !validIsoDate(firstDueDate)) {
    return res.status(400).json({ message: 'merchantId, a valid customerIdentifier, installmentFrequency, installmentCount (1–120), and firstDueDate (YYYY-MM-DD) are required.' })
  }

  let totalCents, downPaymentCents, markupCents, lateFeeCents
  try {
    totalCents = amountCents(input.totalValue, 'totalValue')
    downPaymentCents = amountCents(input.downPayment ?? 0, 'downPayment')
    markupCents = amountCents(input.markupAmount ?? 0, 'markupAmount')
    lateFeeCents = amountCents(input.lateFeeAmount ?? 0, 'lateFeeAmount')
  } catch (error) { return res.status(400).json({ message: error.message }) }
  if (totalCents <= 0 || downPaymentCents >= totalCents) return res.status(400).json({ message: 'totalValue must be positive and greater than downPayment.' })
  const graceDays = Number(input.lateFeeGraceDays ?? 0)
  const threshold = Number(input.missedInstallmentThreshold ?? 3)
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 365 || !Number.isInteger(threshold) || threshold < 1 || threshold > 120) {
    return res.status(400).json({ message: 'lateFeeGraceDays must be between 0 and 365, and missedInstallmentThreshold between 1 and 120.' })
  }

  const merchant = await query(
    `SELECT id, account_setup_status FROM merchants
      WHERE id = $1 AND tenant_id = $2 AND is_active`, [merchantId, tenantId]
  )
  if (!merchant.rows.length) return res.status(404).json({ message: 'Active merchant not found.' })
  if (merchant.rows[0].account_setup_status !== 'ACTIVE') return res.status(409).json({ message: 'Eganow account setup must be active before this merchant can originate credit sales.' })

  const amountToFinanceCents = totalCents - downPaymentCents + markupCents
  if (amountToFinanceCents < count) return res.status(400).json({ message: 'The financed amount must provide at least GHS 0.01 per installment.' })
  const baseCents = Math.floor(amountToFinanceCents / count)

  const plan = await withTransaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO credit_plans
         (tenant_id, merchant_id, customer_identifier, customer_name, total_value, down_payment,
          installment_count, installment_frequency, installment_amount, markup_amount,
          late_fee_amount, late_fee_grace_days, missed_installment_threshold, created_by_user_id)
       VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [tenantId, merchantId, customerIdentifier, String(input.customerName || '').trim(), totalCents / 100, downPaymentCents / 100, count, frequency,
        baseCents / 100, markupCents / 100, lateFeeCents / 100, graceDays, threshold, req.user.id]
    )
    const row = inserted.rows[0]
    for (let index = 0; index < count; index += 1) {
      const installmentCents = index === count - 1 ? amountToFinanceCents - baseCents * index : baseCents
      await tx.query(
        `INSERT INTO credit_plan_installments (credit_plan_id, installment_number, due_date, amount_due)
         VALUES ($1, $2, $3::date, $4)`,
        [row.id, index + 1, addDueDate(firstDueDate, frequency, index), installmentCents / 100]
      )
    }
    return row
  })
  res.status(201).json({ ...plan, installments: count, firstDueDate })
}))

creditPlansRouter.get('/', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  const merchantId = req.user.role === 'TENANT_BRANCH_MANAGER' ? req.user.merchantId : req.query.merchantId
  if (!merchantId && !req.user.isPlatformAdmin) return res.status(400).json({ message: 'merchantId is required.' })
  const params = [tenantId]
  let merchantFilter = ''
  if (merchantId) { params.push(merchantId); merchantFilter = `AND p.merchant_id = $2` }
  const { rows } = await query(
    `SELECT p.*, m.display_name AS merchant_name,
            b.total_outstanding_promised, b.total_actually_collected
       FROM credit_plans p JOIN merchants m ON m.id = p.merchant_id AND m.tenant_id = p.tenant_id
       LEFT JOIN merchant_credit_exposure b ON b.tenant_id = p.tenant_id AND b.merchant_id = p.merchant_id
      WHERE p.tenant_id = $1 ${merchantFilter}
      ORDER BY p.created_at DESC LIMIT 500`, params
  )
  res.json(rows)
}))

creditPlansRouter.get('/exposure', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  const merchantId = req.user.role === 'TENANT_BRANCH_MANAGER' ? req.user.merchantId : req.query.merchantId
  if (!merchantId && !req.user.isPlatformAdmin) return res.status(400).json({ message: 'merchantId is required.' })
  const { rows } = await query(
    `SELECT COALESCE(SUM(b.outstanding_promised), 0) AS total_outstanding_promised,
            COALESCE(SUM(b.actually_collected), 0) AS total_actually_collected,
            COALESCE(SUM(b.overdue_installment_count), 0)::int AS overdue_installment_count
       FROM credit_customer_balance b
      WHERE b.tenant_id = $1 AND ($2::uuid IS NULL OR b.merchant_id = $2)`, [tenantId, merchantId || null]
  )
  res.json(rows[0])
}))

creditPlansRouter.get('/:planId', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  const { rows } = await query(
    `SELECT p.*, m.display_name AS merchant_name
       FROM credit_plans p JOIN merchants m ON m.id = p.merchant_id AND m.tenant_id = p.tenant_id
      WHERE p.id = $1 AND p.tenant_id = $2
        AND ($3::uuid IS NULL OR p.merchant_id = $3)`,
    [req.params.planId, tenantId, req.user.role === 'TENANT_BRANCH_MANAGER' ? req.user.merchantId : null]
  )
  if (!rows.length) return res.status(404).json({ message: 'Credit plan not found.' })
  const installments = await query(
    `SELECT i.*, t.internal_reference, t.status AS collection_status
       FROM credit_plan_installments i
       LEFT JOIN transactions t ON t.id = i.paid_transaction_id
      WHERE i.credit_plan_id = $1 ORDER BY i.installment_number`, [req.params.planId]
  )
  res.json({ ...rows[0], installments: installments.rows })
}))

creditPlansRouter.post('/:planId/installments/:installmentId/payment-link', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  const { rows } = await query(
    `SELECT p.id, p.late_fee_grace_days, i.id AS installment_id, i.status AS installment_status, i.due_date
       FROM credit_plans p JOIN credit_plan_installments i ON i.credit_plan_id = p.id
      WHERE p.id = $1 AND i.id = $2 AND p.tenant_id = $3
        AND ($4::uuid IS NULL OR p.merchant_id = $4)`,
    [req.params.planId, req.params.installmentId, tenantId, req.user.role === 'TENANT_BRANCH_MANAGER' ? req.user.merchantId : null]
  )
  if (!rows.length) return res.status(404).json({ message: 'Credit plan or installment not found.' })
  const item = rows[0]
  if (!['PENDING', 'OVERDUE'].includes(item.installment_status)) return res.status(409).json({ message: 'A payment link is only available for an unpaid installment.' })
  const expiresAt = getInstallmentLinkExpiry(item.due_date, item.late_fee_grace_days)
  const token = issueInstallmentToken({ planId: req.params.planId, installmentId: item.installment_id, expiresAt })
  res.json({ url: installmentPaymentUrl(token), expiresAt: expiresAt.toISOString() })
}))

creditPaymentsRouter.get('/:installmentToken', asyncHandler(async (req, res) => {
  let token
  try { token = verifyInstallmentToken(req.params.installmentToken) } catch {
    return res.status(404).json({ message: 'This installment payment link is invalid or has expired.' })
  }
  const { rows } = await query(
    `SELECT p.id AS plan_id, p.status AS plan_status,
            i.id AS installment_id, i.installment_number, i.due_date, i.amount_due, i.status AS installment_status,
            m.id AS merchant_id, m.display_name AS merchant_name
       FROM credit_plans p
       JOIN credit_plan_installments i ON i.credit_plan_id = p.id
       JOIN merchants m ON m.id = p.merchant_id AND m.tenant_id = p.tenant_id
      WHERE p.id = $1 AND i.id = $2`, [token.planId, token.installmentId]
  )
  if (!rows.length || !['ACTIVE', 'OVERDUE', 'DEFAULTED'].includes(rows[0].plan_status) || !['PENDING', 'OVERDUE'].includes(rows[0].installment_status)) {
    return res.status(409).json({ message: 'This installment is no longer available for payment.' })
  }
  const row = rows[0]
  res.json({ planId: row.plan_id, installmentId: row.installment_id, installmentNumber: row.installment_number,
    dueDate: row.due_date, amountDue: Number(row.amount_due), status: row.installment_status,
    merchantId: row.merchant_id, merchantName: row.merchant_name })
}))

creditPaymentsRouter.post('/:installmentToken/collect', asyncHandler(async (req, res) => {
  let token
  try { token = verifyInstallmentToken(req.params.installmentToken) } catch {
    return res.status(404).json({ message: 'This installment payment link is invalid or has expired.' })
  }
  const { rows } = await query(
    `SELECT p.merchant_id, i.amount_due
       FROM credit_plans p JOIN credit_plan_installments i ON i.credit_plan_id = p.id
      WHERE p.id = $1 AND i.id = $2`, [token.planId, token.installmentId]
  )
  if (!rows.length) return res.status(404).json({ message: 'Installment not found.' })
  try {
    const result = await initiateCollection(rows[0].merchant_id, {
      amount: Number(rows[0].amount_due), msisdn: req.body?.msisdn, network: req.body?.network,
      narration: `Credit installment ${token.installmentId}`,
      creditPlanId: token.planId, creditInstallmentId: token.installmentId
    })
    return res.json({ reference: result.internalReference, status: result.status, message: result.message || 'Approve the payment prompt on your phone.' })
  } catch (error) {
    if (error instanceof CollectionRejectedError) return res.status(400).json({ message: error.message })
    throw error
  }
}))

function getInstallmentLinkExpiry(dueDate, graceDays) {
  const expiry = new Date(`${String(dueDate).slice(0, 10)}T00:00:00.000Z`)
  expiry.setUTCDate(expiry.getUTCDate() + Number(graceDays) + 30)
  return new Date(Math.max(expiry.getTime(), Date.now() + 30 * 86400000))
}

creditPlansRouter.post('/:planId/installments/:installmentId/manual-payment', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  const result = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT p.*, i.id AS installment_id, i.installment_number, i.amount_due, i.status AS installment_status
         FROM credit_plans p JOIN credit_plan_installments i ON i.credit_plan_id = p.id
        WHERE p.id = $1 AND i.id = $2 AND p.tenant_id = $3
          AND ($4::uuid IS NULL OR p.merchant_id = $4)
        FOR UPDATE OF p, i`,
      [req.params.planId, req.params.installmentId, tenantId, req.user.role === 'TENANT_BRANCH_MANAGER' ? req.user.merchantId : null]
    )
    if (!rows.length) return { notFound: true }
    const plan = rows[0]
    if (!['PENDING', 'OVERDUE'].includes(plan.installment_status)) return { conflict: true }
    const { rows: activePayments } = await tx.query(
      `SELECT 1 FROM transactions WHERE credit_installment_id = $1 AND type = 'COLLECTION' AND status <> 'FAILED' LIMIT 1`,
      [plan.installment_id]
    )
    if (activePayments.length) return { conflict: true }
    const paid = await tx.query(
      `UPDATE credit_plan_installments
          SET status = 'PAID', paid_at = now(), paid_transaction_id = NULL,
              manually_recorded = TRUE, manually_recorded_by_user_id = $2
        WHERE id = $1 AND status IN ('PENDING', 'OVERDUE')
        RETURNING id, installment_number, amount_due, paid_at`, [plan.installment_id, req.user.id]
    )
    const remaining = await tx.query(
      `SELECT COUNT(*)::int AS count FROM credit_plan_installments
        WHERE credit_plan_id = $1 AND status <> 'PAID'`, [plan.id]
    )
    let completed = false
    if (remaining.rows[0].count === 0) {
      completed = true
      await tx.query(`UPDATE credit_plans SET status = 'COMPLETED' WHERE id = $1`, [plan.id])
    } else if (plan.status !== 'DEFAULTED') {
      const stillOverdue = await tx.query(`SELECT 1 FROM credit_plan_installments WHERE credit_plan_id = $1 AND status = 'OVERDUE' LIMIT 1`, [plan.id])
      await tx.query(`UPDATE credit_plans SET status = $2 WHERE id = $1`, [plan.id, stillOverdue.rows.length ? 'OVERDUE' : 'ACTIVE'])
    }
    const eventPayload = { planId: plan.id, installmentId: plan.installment_id, installmentNumber: plan.installment_number, merchantId: plan.merchant_id, amount: Number(plan.amount_due), status: 'PAID', manuallyRecorded: true }
    await recordCreditWebhookEvent(tx, { tenantId, merchantId: plan.merchant_id, eventType: 'installment.paid', eventKey: `installment.paid:${plan.installment_id}`, payload: eventPayload })
    if (completed) await recordCreditWebhookEvent(tx, { tenantId, merchantId: plan.merchant_id, eventType: 'plan.completed', eventKey: `plan.completed:${plan.id}`, payload: { planId: plan.id, merchantId: plan.merchant_id, status: 'COMPLETED' } })
    return { installment: paid.rows[0], planCompleted: completed }
  })
  if (result.notFound) return res.status(404).json({ message: 'Credit plan or installment not found.' })
  if (result.conflict) return res.status(409).json({ message: 'This installment is already paid or has a platform collection in progress.' })
  res.json(result)
}))
