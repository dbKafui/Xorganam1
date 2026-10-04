import { Router } from 'express'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { query, withTransaction } from '../db/pool.js'
import { env } from '../config/env.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { initiateCollection, CollectionRejectedError } from '../services/collectionService.js'
import { sendPlatformSms } from '../services/notificationService.js'

export const creditCustomerPublicRouter = Router()
export const creditCustomerRouter = Router()

function normalizeMsisdn(value) {
  const digits = String(value || '').trim().replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) return `233${digits.slice(1)}`
  if (digits.startsWith('233') && digits.length === 12) return digits
  if (digits.startsWith('2330') && digits.length === 13) return `233${digits.slice(4)}`
  if (digits.length === 9) return `233${digits}`
  return null
}

function codeDigest(phone, code) {
  return crypto.createHmac('sha256', env.jwt.secret).update(`${phone}:${code}`).digest()
}

export function customerAuth(req, res, next) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Customer phone verification is required.' })
  try {
    const payload = jwt.verify(header.slice(7), env.jwt.secret, { algorithms: ['HS256'], issuer: 'xorganam-customer', audience: 'credit-plan-customer' })
    if (payload.role !== 'CUSTOMER' || !/^233\d{9}$/.test(payload.phone || '')) throw new Error('Invalid customer session.')
    req.creditCustomer = { phone: payload.phone }
    next()
  } catch {
    return res.status(401).json({ message: 'Customer session is invalid or expired. Verify your phone again.' })
  }
}

creditCustomerPublicRouter.post('/request-code', asyncHandler(async (req, res) => {
  const phone = normalizeMsisdn(req.body?.phoneNumber)
  if (!phone) return res.status(400).json({ message: 'Enter a valid mobile number.' })
  const genericResponse = { message: 'If a credit schedule or order matches this number, a verification code has been sent.' }
  const matchingPlan = await query(
    `SELECT 1 FROM credit_plans WHERE customer_identifier = $1
     UNION ALL SELECT 1 FROM orders WHERE customer_identifier = $1 LIMIT 1`, [phone]
  )
  if (!matchingPlan.rows.length) return res.status(202).json(genericResponse)
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  const digest = codeDigest(phone, code)
  const inserted = await query(
    `INSERT INTO credit_customer_auth_challenges (customer_identifier, code_hash, requested_at, expires_at, failed_attempts, consumed_at)
     VALUES ($1, $2, now(), now() + interval '10 minutes', 0, NULL)
     ON CONFLICT (customer_identifier)
     DO UPDATE SET code_hash = EXCLUDED.code_hash, requested_at = EXCLUDED.requested_at,
                   expires_at = EXCLUDED.expires_at, failed_attempts = 0, consumed_at = NULL
       WHERE credit_customer_auth_challenges.requested_at <= now() - interval '1 minute'
     RETURNING customer_identifier`, [phone, digest.toString('hex')]
  )
  if (!inserted.rows.length) return res.status(202).json(genericResponse)
  const sent = await sendPlatformSms(phone, `Your XORGANAM credit schedule verification code is ${code}. It expires in 10 minutes.`)
  if (!sent) console.warn('[credit-customer-auth] verification SMS delivery failed')
  res.status(202).json(genericResponse)
}))

creditCustomerPublicRouter.post('/verify-code', asyncHandler(async (req, res) => {
  const phone = normalizeMsisdn(req.body?.phoneNumber)
  const code = String(req.body?.code || '')
  if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({ message: 'Enter the phone number and six-digit verification code.' })
  const result = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT code_hash, expires_at, failed_attempts, consumed_at
         FROM credit_customer_auth_challenges WHERE customer_identifier = $1 FOR UPDATE`, [phone]
    )
    const challenge = rows[0]
    if (!challenge || challenge.consumed_at || new Date(challenge.expires_at) <= new Date() || challenge.failed_attempts >= 5) return false
    const actual = codeDigest(phone, code)
    const expected = Buffer.from(challenge.code_hash, 'hex')
    const matches = actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
    if (!matches) {
      await tx.query(`UPDATE credit_customer_auth_challenges SET failed_attempts = failed_attempts + 1 WHERE customer_identifier = $1`, [phone])
      return false
    }
    await tx.query(`UPDATE credit_customer_auth_challenges SET consumed_at = now() WHERE customer_identifier = $1`, [phone])
    return true
  })
  if (!result) return res.status(401).json({ message: 'The verification code is invalid or expired.' })
  const token = jwt.sign({ phone, role: 'CUSTOMER' }, env.jwt.secret, { algorithm: 'HS256', issuer: 'xorganam-customer', audience: 'credit-plan-customer', expiresIn: '1h' })
  res.json({ token, phoneNumber: phone })
}))

creditCustomerRouter.use(customerAuth)

creditCustomerRouter.get('/plans', asyncHandler(async (req, res) => {
  const { rows: plans } = await query(
    `SELECT p.id, p.tenant_id, p.merchant_id, p.customer_name, p.total_value, p.down_payment,
            p.installment_count, p.installment_frequency, p.installment_amount, p.markup_amount,
            p.late_fee_amount, p.status, p.created_at, m.display_name AS merchant_name,
            b.outstanding_promised, b.actually_collected, b.overdue_installment_count
       FROM credit_plans p
       JOIN merchants m ON m.id = p.merchant_id AND m.tenant_id = p.tenant_id
       JOIN credit_customer_balance b ON b.credit_plan_id = p.id
      WHERE p.customer_identifier = $1 ORDER BY p.created_at DESC`, [req.creditCustomer.phone]
  )
  const { rows: installments } = await query(
    `SELECT i.credit_plan_id, i.id, i.installment_number, i.due_date, i.amount_due, i.status, i.paid_at,
            i.manually_recorded
       FROM credit_plan_installments i JOIN credit_plans p ON p.id = i.credit_plan_id
      WHERE p.customer_identifier = $1 ORDER BY i.due_date, i.installment_number`, [req.creditCustomer.phone]
  )
  res.json(plans.map((plan) => ({ ...plan, installments: installments.filter((item) => item.credit_plan_id === plan.id) })))
}))

creditCustomerRouter.post('/plans/:planId/installments/:installmentId/collect', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT p.id AS plan_id, p.merchant_id, p.customer_identifier, i.id AS installment_id, i.amount_due, i.status
       FROM credit_plans p JOIN credit_plan_installments i ON i.credit_plan_id = p.id
      WHERE p.id = $1 AND i.id = $2`, [req.params.planId, req.params.installmentId]
  )
  const installment = rows[0]
  if (!installment || installment.customer_identifier !== req.creditCustomer.phone) return res.status(404).json({ message: 'Installment not found.' })
  if (!['PENDING', 'OVERDUE'].includes(installment.status)) return res.status(409).json({ message: 'This installment is not available for payment.' })
  try {
    const result = await initiateCollection(installment.merchant_id, {
      amount: Number(installment.amount_due), msisdn: req.creditCustomer.phone,
      creditPlanId: installment.plan_id, creditInstallmentId: installment.installment_id,
      narration: `Credit installment ${installment.installment_id}`
    })
    res.json({ reference: result.internalReference, status: result.status, message: result.message || 'Approve the payment prompt on your phone.' })
  } catch (error) {
    if (error instanceof CollectionRejectedError) return res.status(409).json({ message: error.message })
    throw error
  }
}))
