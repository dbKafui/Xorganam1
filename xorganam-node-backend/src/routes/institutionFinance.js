import crypto from 'node:crypto'
import { Router } from 'express'
import { query, withTransaction } from '../db/pool.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { authenticate, resolveTenantScope, ForbiddenError } from '../middleware/auth.js'
import { institutionAuthenticate } from '../middleware/institutionAuth.js'
import { requireInstitutionPermission } from '../middleware/requireInstitutionPermission.js'
import { encrypt } from '../security/encryption.js'
import { createEganowClientForInstitution } from '../services/eganowClient.js'
import { initiateInstitutionCollection, initiateInstitutionPayout, queryInstitutionEganowStatus } from '../services/institutionEganowService.js'
import { InstitutionCredentialsError } from '../services/credentialsService.js'
import { reconcileInstitutionTransaction } from '../services/institutionFinancialLedger.js'
import { dispatchInstitutionNotification } from '../services/institutionNotificationService.js'

export const institutionFinanceRouter = Router()
export const tenantInstitutionFinanceRouter = Router()

const productTypes = new Set(['LOAN', 'SAVINGS'])
const productStatuses = new Set(['DRAFT', 'ACTIVE', 'PAUSED', 'RETIRED'])
const feeOperations = new Set(['LOAN_REPAYMENT', 'SAVINGS_CONTRIBUTION', 'SAVINGS_WITHDRAWAL'])
const feeTypes = new Set(['NONE', 'FIXED', 'PERCENTAGE'])
const loanModels = new Set(['FLAT', 'REDUCING_BALANCE'])
const repaymentFrequencies = new Set(['WEEKLY', 'MONTHLY'])
const savingsFrequencies = new Set(['PER_TRANSACTION', 'DAILY', 'WEEKLY', 'MONTHLY'])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function badRequest(res, message) { return res.status(400).json({ message }) }
function cents(value, label, { zero = false } = {}) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || (zero ? number < 0 : number <= 0)) throw new Error(`${label} must be a ${zero ? 'non-negative' : 'positive'} whole number of cents.`)
  return number
}
function tenantScope(req, res) {
  try { return resolveTenantScope(req, req.query.tenantId || req.body?.tenantId) } catch (error) {
    if (error instanceof ForbiddenError) { res.status(403).json({ message: error.message }); return null }
    throw error
  }
}
function resolveTermDays(product, termDaysInput, termMonthsInput) {
  if (product.product_type !== 'LOAN') return null
  const options = product.tenor_options_months || []
  let term
  if (options.length) {
    const months = Number(termMonthsInput)
    if (!Number.isInteger(months) || !options.includes(months)) return null
    term = Math.round(months * 365 / 12)
  } else term = Number(termDaysInput)
  return Number.isInteger(term) && term >= product.min_term_days && term <= product.max_term_days ? term : null
}

async function savingsContributionHistory(tx, institutionId, customerId) {
  const { rows } = await tx.query(
    `SELECT COALESCE(sum(contribution.amount_cents), 0)::bigint AS total_cents FROM (
       SELECT t.amount_cents FROM institution_financial_transactions t
       JOIN institution_financial_accounts a ON a.id = t.account_id AND a.institution_id = t.institution_id
        WHERE t.institution_id = $1 AND a.customer_id = $2 AND t.transaction_type = 'DEPOSIT' AND t.status = 'POSTED'
       UNION ALL
       SELECT allocation.amount_cents FROM institution_split_financial_allocations allocation
       JOIN institution_financial_accounts a ON a.id = allocation.account_id AND a.institution_id = allocation.institution_id
        WHERE allocation.institution_id = $1 AND a.customer_id = $2 AND allocation.allocation_type = 'SAVINGS_CONTRIBUTION'
      ) contribution`,
    [institutionId, customerId]
  )
  return Number(rows[0].total_cents)
}

async function configuredFee(institutionId, operation, amountCents) {
  const { rows } = await query('SELECT fee_type, fee_value FROM institution_financial_fee_rules WHERE institution_id = $1 AND operation = $2', [institutionId, operation])
  const rule = rows[0]
  if (!rule || rule.fee_type === 'NONE') return 0
  if (rule.fee_type === 'FIXED') return Math.round(Number(rule.fee_value) * 100)
  return Math.round(amountCents * Number(rule.fee_value) / 100)
}
function isDefinitiveEganowRejection(error) {
  return error instanceof InstitutionCredentialsError ||
    ['Enter a valid Ghana mobile number.', 'Payment network could not be determined for this mobile number.'].includes(error.message) ||
    (error.response?.status >= 400 && error.response?.status < 500)
}

institutionFinanceRouter.use(institutionAuthenticate)

institutionFinanceRouter.get('/approval-policy', requireInstitutionPermission('rule_config:view'), asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT supervisor_approval_limit_cents FROM institutions WHERE id = $1', [req.institutionAuth.institutionId])
  res.json({ supervisorApprovalLimitCents: Number(rows[0]?.supervisor_approval_limit_cents || 0) })
}))

institutionFinanceRouter.put('/approval-policy', requireInstitutionPermission('rule_config:write'), asyncHandler(async (req, res) => {
  let limit
  try { limit = cents(req.body?.supervisorApprovalLimitCents ?? 0, 'Supervisor approval limit', { zero: true }) }
  catch (error) { return badRequest(res, error.message) }
  await query('UPDATE institutions SET supervisor_approval_limit_cents = $2, updated_at = now() WHERE id = $1', [req.institutionAuth.institutionId, limit])
  res.json({ supervisorApprovalLimitCents: limit })
}))

institutionFinanceRouter.get('/eganow', requireInstitutionPermission('finance:view'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT i.eganow_collection_account_id, i.eganow_payout_account_id, i.eganow_network_provider,
            c.eganow_base_url, c.callback_url, c.is_enabled,
            (c.api_username_encrypted IS NOT NULL) AS has_api_username,
            (c.api_password_encrypted IS NOT NULL) AS has_api_password,
            (c.x_auth_encrypted IS NOT NULL) AS has_x_auth
       FROM institutions i LEFT JOIN institution_eganow_credentials c ON c.institution_id = i.id
      WHERE i.id = $1`, [req.institutionAuth.institutionId]
  )
  res.json(rows[0] || {})
}))

institutionFinanceRouter.put('/eganow', requireInstitutionPermission('rule_config:write'), asyncHandler(async (req, res) => {
  const body = req.body || {}
  const urlFields = [['eganowBaseUrl', body.eganowBaseUrl], ['callbackUrl', body.callbackUrl]]
  for (const [label, value] of urlFields) {
    if (value === undefined || value === null || value === '') continue
    try { if (new URL(value).protocol !== 'https:') return badRequest(res, `${label} must use HTTPS.`) }
    catch { return badRequest(res, `${label} must be a valid HTTPS URL.`) }
  }
  for (const field of ['apiUsername', 'apiPassword', 'xAuth', 'collectionAccountId', 'payoutAccountId', 'networkProvider']) {
    if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].trim().length > 1000)) return badRequest(res, `${field} must be a string no longer than 1000 characters.`)
  }
  if (typeof body.isEnabled !== 'boolean') return badRequest(res, 'isEnabled must be provided as a boolean.')
  const { rows: institutions } = await query('SELECT api_key_salt FROM institutions WHERE id = $1 AND status = \'ACTIVE\'', [req.institutionAuth.institutionId])
  if (!institutions.length) return res.status(404).json({ message: 'Active institution not found.' })
  const salt = institutions[0].api_key_salt
  const encrypted = await Promise.all(['apiUsername', 'apiPassword', 'xAuth'].map((key) =>
    body[key]?.trim() ? encrypt(body[key].trim(), salt) : null
  ))
  await query(
    `INSERT INTO institution_eganow_credentials
      (institution_id, api_username_encrypted, api_password_encrypted, x_auth_encrypted,
       eganow_base_url, callback_url, is_enabled)
     VALUES ($1,$2,$3,$4,COALESCE($5,'https://developer.sandbox.egacoreapi.com'),$6,$7)
     ON CONFLICT (institution_id) DO UPDATE SET
       api_username_encrypted = COALESCE(EXCLUDED.api_username_encrypted, institution_eganow_credentials.api_username_encrypted),
       api_password_encrypted = COALESCE(EXCLUDED.api_password_encrypted, institution_eganow_credentials.api_password_encrypted),
       x_auth_encrypted = COALESCE(EXCLUDED.x_auth_encrypted, institution_eganow_credentials.x_auth_encrypted),
       eganow_base_url = COALESCE($5, institution_eganow_credentials.eganow_base_url),
       callback_url = COALESCE($6, institution_eganow_credentials.callback_url),
       is_enabled = EXCLUDED.is_enabled, updated_at = now()`,
    [req.institutionAuth.institutionId, ...encrypted, body.eganowBaseUrl || null, body.callbackUrl || null, body.isEnabled]
  )
  await query(
    `UPDATE institutions SET eganow_collection_account_id = $2, eganow_payout_account_id = $3,
       eganow_network_provider = $4, updated_at = now() WHERE id = $1`,
    [req.institutionAuth.institutionId, body.collectionAccountId?.trim() || null,
      body.payoutAccountId?.trim() || null, body.networkProvider?.trim() || null]
  )
  if (body.isEnabled) {
    const { rows: config } = await query(
      `SELECT c.api_username_encrypted, c.api_password_encrypted, c.x_auth_encrypted,
              c.callback_url, i.eganow_collection_account_id, i.eganow_payout_account_id
         FROM institution_eganow_credentials c JOIN institutions i ON i.id = c.institution_id WHERE c.institution_id = $1`,
      [req.institutionAuth.institutionId]
    )
    const row = config[0]
    if (!row?.api_username_encrypted || !row.api_password_encrypted || !row.x_auth_encrypted ||
        !row.callback_url || !row.eganow_collection_account_id || !row.eganow_payout_account_id) {
      await query('UPDATE institution_eganow_credentials SET is_enabled = FALSE WHERE institution_id = $1', [req.institutionAuth.institutionId])
      return badRequest(res, 'To enable Eganow, provide API username, password, x-Auth, HTTPS callback URL, and both wallet account IDs.')
    }
  }
  res.json({ message: 'Institution Eganow provisioning saved.', isEnabled: body.isEnabled })
}))

institutionFinanceRouter.post('/eganow/test', requireInstitutionPermission('rule_config:write'), asyncHandler(async (req, res) => {
  try {
    const { client } = await createEganowClientForInstitution(req.institutionAuth.institutionId)
    res.json({ connected: true, baseUrl: client.defaults.baseURL })
  } catch (error) {
    res.status(400).json({ connected: false, message: error.name === 'InstitutionCredentialsError' ? error.message : 'Eganow connection failed. Confirm credentials and endpoint, then try again.' })
  }
}))

institutionFinanceRouter.get('/customers', requireInstitutionPermission('customer:view'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, s.first_name || ' ' || s.last_name AS onboarded_by,
            EXISTS (SELECT 1 FROM institution_customers duplicate
                     WHERE duplicate.institution_id = c.institution_id AND duplicate.phone_number = c.phone_number AND duplicate.id <> c.id AND duplicate.is_active) AS duplicate_phone
       FROM institution_customers c LEFT JOIN institution_staff s ON s.id = c.created_by_staff_id
      WHERE c.institution_id = $1 AND ($2 = 'INSTITUTION_ADMIN' OR c.branch_id IS NOT DISTINCT FROM $3)
      ORDER BY c.created_at DESC LIMIT 500`, [req.institutionAuth.institutionId, req.institutionAuth.role, req.institutionAuth.branchId]
  )
  res.json(rows)
}))

institutionFinanceRouter.get('/linked-tenants', requireInstitutionPermission('customer:view'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT t.id, t.company_name
       FROM tenant_institution_links l JOIN tenants t ON t.id = l.tenant_id
      WHERE l.institution_id = $1 AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
      ORDER BY t.company_name`, [req.institutionAuth.institutionId]
  )
  res.json(rows)
}))

institutionFinanceRouter.post('/customers', requireInstitutionPermission('customer:onboard'), asyncHandler(async (req, res) => {
  const body = req.body || {}
  const firstName = String(body.firstName || '').trim()
  const lastName = String(body.lastName || '').trim()
  const phoneNumber = String(body.phoneNumber || '').replace(/\D/g, '')
  const customerNumber = String(body.customerNumber || '').trim()
  if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100 || !customerNumber || customerNumber.length > 64 || !/^233[0-9]{9}$/.test(phoneNumber)) {
    return badRequest(res, 'Provide a customer number, first and last name, and Ghana phone number in 233XXXXXXXXX format.')
  }
  const branchId = req.institutionAuth.role === 'FIELD_OFFICER' ? req.institutionAuth.branchId : body.branchId || null
  if (branchId) {
    const branch = await query('SELECT 1 FROM institution_branch WHERE id = $1 AND institution_id = $2 AND is_active', [branchId, req.institutionAuth.institutionId])
    if (!branch.rowCount) return badRequest(res, 'Branch must be active and belong to this institution.')
  }
  try {
    const { rows } = await query(
      `INSERT INTO institution_customers
        (institution_id, branch_id, customer_number, first_name, last_name, phone_number, email, kyc_reference, notification_consent, created_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.institutionAuth.institutionId, branchId, customerNumber, firstName, lastName, phoneNumber,
        body.email ? String(body.email).trim().slice(0, 254) : null,
        body.kycReference ? String(body.kycReference).trim().slice(0, 160) : null,
        body.notificationConsent === true, req.institutionAuth.id]
    )
    res.status(201).json(rows[0])
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'Customer number already exists in this institution.' })
    throw error
  }
}))

institutionFinanceRouter.patch('/customers/:customerId/kyc', requireInstitutionPermission('customer:verify'), asyncHandler(async (req, res) => {
  const { decision, note, tenantId } = req.body || {}
  if (!uuid.test(req.params.customerId) || !['VERIFIED', 'REJECTED', 'PENDING'].includes(decision)) return badRequest(res, 'Provide a valid customer ID and KYC decision.')
  if (decision === 'VERIFIED') {
    const { rows: customerRows } = await query('SELECT kyc_reference FROM institution_customers WHERE id = $1 AND institution_id = $2', [req.params.customerId, req.institutionAuth.institutionId])
    if (!customerRows.length) return res.status(404).json({ message: 'Customer not found.' })
    if (!customerRows[0].kyc_reference) return badRequest(res, 'A KYC document reference is required before verification.')
  }
  if (tenantId && !uuid.test(tenantId)) return badRequest(res, 'tenantId is invalid.')
  const { rows } = await query(
    `UPDATE institution_customers c
        SET kyc_status = $3, kyc_note = $4,
            verified_by_staff_id = CASE WHEN $3 = 'VERIFIED' THEN $5 ELSE NULL END,
            verified_at = CASE WHEN $3 = 'VERIFIED' THEN now() ELSE NULL END,
            tenant_id = CASE WHEN $6::uuid IS NOT NULL THEN $6::uuid ELSE c.tenant_id END,
            updated_at = now()
      WHERE c.id = $1 AND c.institution_id = $2
        AND ($7 = 'INSTITUTION_ADMIN' OR c.branch_id IS NOT DISTINCT FROM $8)
        AND ($6::uuid IS NULL OR EXISTS (
          SELECT 1 FROM tenant_institution_links l WHERE l.tenant_id = $6 AND l.institution_id = $2
            AND l.verification_status = 'APPROVED' AND l.status = 'ACTIVE'
        )) RETURNING c.*`,
    [req.params.customerId, req.institutionAuth.institutionId, decision, String(note || '').slice(0, 1000) || null,
      req.institutionAuth.id, tenantId || null, req.institutionAuth.role, req.institutionAuth.branchId]
  )
  if (!rows.length) return res.status(404).json({ message: 'Customer not found in your branch or tenant is not linked and verified.' })
  if (decision === 'VERIFIED' || decision === 'REJECTED') {
    dispatchInstitutionNotification({
      institutionId: req.institutionAuth.institutionId, customerId: req.params.customerId,
      event: decision === 'VERIFIED' ? 'VERIFICATION_APPROVED' : 'VERIFICATION_REJECTED',
      sentByStaffId: req.institutionAuth.id
    }).catch((error) => console.error('[institution-notification] KYC notification failed', { code: error?.code || 'NOTIFICATION_ERROR' }))
  }
  res.json(rows[0])
}))

institutionFinanceRouter.patch('/customers/:customerId/notification-consent', requireInstitutionPermission('customer:onboard'), asyncHandler(async (req, res) => {
  const { notificationConsent } = req.body || {}
  if (!uuid.test(req.params.customerId) || typeof notificationConsent !== 'boolean') return badRequest(res, 'Provide a customer ID and a boolean consent value.')
  const { rows } = await query(
    `UPDATE institution_customers SET notification_consent = $3, updated_at = now()
      WHERE id = $1 AND institution_id = $2
        AND ($4 = 'INSTITUTION_ADMIN' OR branch_id IS NOT DISTINCT FROM $5) RETURNING id, notification_consent`,
    [req.params.customerId, req.institutionAuth.institutionId, notificationConsent, req.institutionAuth.role, req.institutionAuth.branchId]
  )
  if (!rows.length) return res.status(404).json({ message: 'Customer not found in your branch.' })
  res.json(rows[0])
}))

institutionFinanceRouter.get('/products', requireInstitutionPermission('finance:view'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, s.first_name || ' ' || s.last_name AS created_by
       FROM institution_financial_products p LEFT JOIN institution_staff s ON s.id = p.created_by_staff_id
      WHERE p.institution_id = $1 ORDER BY p.product_type, p.created_at DESC`, [req.institutionAuth.institutionId]
  )
  res.json(rows)
}))

institutionFinanceRouter.post('/products', requireInstitutionPermission('product:manage'), asyncHandler(async (req, res) => {
  const body = req.body || {}
  const type = String(body.productType || '').toUpperCase()
  const interestModel = String(body.interestModel || '').toUpperCase()
  const repaymentFrequency = String(body.repaymentFrequency || '').toUpperCase()
  const contributionFrequency = String(body.contributionFrequency || 'PER_TRANSACTION').toUpperCase()
  const name = String(body.name || '').trim()
  if (!productTypes.has(type) || name.length < 2 || name.length > 120) return badRequest(res, 'Choose LOAN or SAVINGS and provide a 2–120 character product name.')
  if (type === 'LOAN' && (!loanModels.has(interestModel) || !repaymentFrequencies.has(repaymentFrequency))) return badRequest(res, 'Loan products require an interest model (FLAT or REDUCING_BALANCE) and repayment frequency (WEEKLY or MONTHLY).')
  if (type === 'SAVINGS' && !savingsFrequencies.has(contributionFrequency)) return badRequest(res, 'Savings contribution frequency must be PER_TRANSACTION, DAILY, WEEKLY, or MONTHLY.')
  try {
    const min = cents(body.minAmountCents, 'Minimum amount')
    const max = cents(body.maxAmountCents, 'Maximum amount')
    const rate = cents(body.annualRateBasisPoints ?? 0, 'Annual rate in basis points', { zero: true })
    const minBalance = cents(body.minBalanceCents ?? 0, 'Minimum balance', { zero: true })
    const savingsLockInMonths = type === 'SAVINGS' ? Number(body.savingsLockInMonths ?? 0) : 0
    const withdrawalPenaltyBps = type === 'SAVINGS' ? Number(body.earlyWithdrawalPenaltyBasisPoints ?? 0) : 0
    if (!Number.isInteger(savingsLockInMonths) || savingsLockInMonths < 0 || !Number.isInteger(withdrawalPenaltyBps) || withdrawalPenaltyBps < 0 || withdrawalPenaltyBps > 10000) return badRequest(res, 'Savings lock-in months or early withdrawal penalty is invalid.')
    const maxAccounts = Number(body.maxActiveAccountsPerCustomer ?? 1)
    if (max < min || maxAccounts < 1 || maxAccounts > 100 || !Number.isInteger(maxAccounts)) return badRequest(res, 'Amount bounds or maximum active account count are invalid.')
    const minTerm = type === 'LOAN' ? Number(body.minTermDays) : null
    const maxTerm = type === 'LOAN' ? Number(body.maxTermDays) : null
    if (type === 'LOAN' && (!Number.isInteger(minTerm) || !Number.isInteger(maxTerm) || minTerm < 1 || maxTerm < minTerm || maxTerm > 36500)) return badRequest(res, 'Loan products require valid minimum and maximum terms in days.')
    const tenorOptions = type === 'LOAN' ? body.tenorOptionsMonths : []
    if (type === 'LOAN' && (!Array.isArray(tenorOptions) || tenorOptions.length < 1 || tenorOptions.length > 20 || tenorOptions.some((n) => !Number.isInteger(n) || n < 1 || n > 120) || new Set(tenorOptions).size !== tenorOptions.length)) return badRequest(res, 'Loan products require unique tenor options from 1 to 120 months.')
    if (type === 'LOAN' && tenorOptions.some((months) => Math.round(months * 365 / 12) < minTerm || Math.round(months * 365 / 12) > maxTerm)) return badRequest(res, 'Each loan tenor must fall within the configured minimum and maximum term boundaries.')
    const lateFeeBps = type === 'LOAN' ? Number(body.lateFeeBasisPoints ?? 0) : 0
    const gracePeriodDays = type === 'LOAN' ? Number(body.gracePeriodDays ?? 0) : 0
    const recoveryMaxAttempts = type === 'LOAN' ? Number(body.recoveryMaxAttempts ?? 0) : 0
    const recoveryIntervalMinutes = type === 'LOAN' ? Number(body.recoveryIntervalMinutes ?? 1440) : 1440
    const minContributionHistory = type === 'LOAN' ? cents(body.minContributionHistoryCents ?? 0, 'Minimum contribution history', { zero: true }) : 0
    if (!Number.isInteger(lateFeeBps) || lateFeeBps < 0 || lateFeeBps > 10000 || !Number.isInteger(gracePeriodDays) || gracePeriodDays < 0 || gracePeriodDays > 365 || !Number.isInteger(recoveryMaxAttempts) || recoveryMaxAttempts < 0 || recoveryMaxAttempts > 20 || !Number.isInteger(recoveryIntervalMinutes) || recoveryIntervalMinutes < 15 || recoveryIntervalMinutes > 43200) return badRequest(res, 'Late fee, grace period, or loan recovery policy is invalid.')
    const { rows } = await query(
      `INSERT INTO institution_financial_products
        (institution_id, product_type, name, description, min_amount_cents, max_amount_cents, annual_rate_basis_points,
         min_term_days, max_term_days, min_balance_cents, withdrawals_per_month, max_active_accounts_per_customer, created_by_staff_id,
         loan_interest_model, repayment_frequency, savings_lock_in_months, early_withdrawal_penalty_basis_points, contribution_frequency,
         tenor_options_months, late_fee_basis_points, grace_period_days, min_contribution_history_cents,
         loan_recovery_max_attempts, loan_recovery_interval_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::institution_loan_interest_model,$15::institution_loan_repayment_frequency,$16,$17,$18::institution_savings_frequency,$19,$20,$21,$22,$23,$24) RETURNING *`,
      [req.institutionAuth.institutionId, type, name, String(body.description || '').slice(0, 2000), min, max, rate,
        minTerm, maxTerm, minBalance, body.withdrawalsPerMonth ? Number(body.withdrawalsPerMonth) : null, maxAccounts, req.institutionAuth.id,
        type === 'LOAN' ? interestModel : null, type === 'LOAN' ? repaymentFrequency : null, savingsLockInMonths, withdrawalPenaltyBps,
        type === 'SAVINGS' ? contributionFrequency : 'PER_TRANSACTION', tenorOptions || [], lateFeeBps, gracePeriodDays, minContributionHistory,
        recoveryMaxAttempts, recoveryIntervalMinutes]
    )
    res.status(201).json(rows[0])
  } catch (error) {
    if (error instanceof Error && !error.code) return badRequest(res, error.message)
    if (error.code === '23514') return badRequest(res, 'Product values are outside supported limits.')
    throw error
  }
}))

institutionFinanceRouter.patch('/products/:productId/policy', requireInstitutionPermission('product:manage'), asyncHandler(async (req, res) => {
  if (!uuid.test(req.params.productId)) return badRequest(res, 'Product ID is invalid.')
  const body = req.body || {}
  const { rows: existing } = await query('SELECT product_type, loan_recovery_max_attempts, loan_recovery_interval_minutes FROM institution_financial_products WHERE id = $1 AND institution_id = $2', [req.params.productId, req.institutionAuth.institutionId])
  const type = existing[0]?.product_type
  if (!type) return res.status(404).json({ message: 'Financial product not found.' })
  const name = String(body.name || '').trim()
  if (name.length < 2 || name.length > 120) return badRequest(res, 'Product name must be 2–120 characters.')
  try {
    const min = cents(body.minAmountCents, 'Minimum amount')
    const max = cents(body.maxAmountCents, 'Maximum amount')
    const rate = cents(body.annualRateBasisPoints ?? 0, 'Annual rate in basis points', { zero: true })
    if (max < min) return badRequest(res, 'Maximum amount cannot be below minimum amount.')
    if (type === 'LOAN') {
      const model = String(body.interestModel || '').toUpperCase()
      const frequency = String(body.repaymentFrequency || '').toUpperCase()
      const minTerm = Number(body.minTermDays); const maxTerm = Number(body.maxTermDays)
      const tenors = body.tenorOptionsMonths
      if (!loanModels.has(model) || !repaymentFrequencies.has(frequency) || !Number.isInteger(minTerm) || !Number.isInteger(maxTerm) || minTerm < 1 || maxTerm < minTerm ||
          !Array.isArray(tenors) || !tenors.length || tenors.length > 20 || tenors.some((n) => !Number.isInteger(n) || n < 1 || n > 120) || new Set(tenors).size !== tenors.length ||
          tenors.some((n) => Math.round(n * 365 / 12) < minTerm || Math.round(n * 365 / 12) > maxTerm)) return badRequest(res, 'Loan interest, frequency, term boundaries, or tenor choices are invalid.')
      const lateFee = Number(body.lateFeeBasisPoints ?? 0); const grace = Number(body.gracePeriodDays ?? 0)
      const recoveryMaxAttempts = Number(body.recoveryMaxAttempts ?? existing[0].loan_recovery_max_attempts)
      const recoveryIntervalMinutes = Number(body.recoveryIntervalMinutes ?? existing[0].loan_recovery_interval_minutes)
      const contributionMinimum = cents(body.minContributionHistoryCents ?? 0, 'Minimum contribution history', { zero: true })
      if (!Number.isInteger(lateFee) || lateFee < 0 || lateFee > 10000 || !Number.isInteger(grace) || grace < 0 || grace > 365 || !Number.isInteger(recoveryMaxAttempts) || recoveryMaxAttempts < 0 || recoveryMaxAttempts > 20 || !Number.isInteger(recoveryIntervalMinutes) || recoveryIntervalMinutes < 15 || recoveryIntervalMinutes > 43200) return badRequest(res, 'Late fee, grace period, or loan recovery policy is invalid.')
      const { rows } = await query(
        `UPDATE institution_financial_products SET name = $3, description = $4, min_amount_cents = $5, max_amount_cents = $6,
            annual_rate_basis_points = $7, min_term_days = $8, max_term_days = $9,
            loan_interest_model = $10::institution_loan_interest_model, repayment_frequency = $11::institution_loan_repayment_frequency,
            tenor_options_months = $12, late_fee_basis_points = $13, grace_period_days = $14,
            min_contribution_history_cents = $15, loan_recovery_max_attempts = $16,
            loan_recovery_interval_minutes = $17, updated_at = now()
          WHERE id = $1 AND institution_id = $2 RETURNING *`,
        [req.params.productId, req.institutionAuth.institutionId, name, String(body.description || '').slice(0, 2000), min, max, rate, minTerm, maxTerm, model, frequency, tenors, lateFee, grace, contributionMinimum, recoveryMaxAttempts, recoveryIntervalMinutes]
      )
      return res.json(rows[0])
    }
    const minBalance = cents(body.minBalanceCents ?? 0, 'Minimum balance', { zero: true })
    const withdrawals = body.withdrawalsPerMonth == null || body.withdrawalsPerMonth === '' ? null : Number(body.withdrawalsPerMonth)
    const lockMonths = Number(body.savingsLockInMonths ?? 0); const penalty = Number(body.earlyWithdrawalPenaltyBasisPoints ?? 0)
    const contributionFrequency = String(body.contributionFrequency || '').toUpperCase()
    if ((withdrawals !== null && (!Number.isInteger(withdrawals) || withdrawals < 1)) || !Number.isInteger(lockMonths) || lockMonths < 0 ||
        !Number.isInteger(penalty) || penalty < 0 || penalty > 10000 || !savingsFrequencies.has(contributionFrequency)) return badRequest(res, 'Savings product policy is invalid.')
    const { rows } = await query(
      `UPDATE institution_financial_products SET name = $3, description = $4, min_amount_cents = $5, max_amount_cents = $6,
          annual_rate_basis_points = $7, min_balance_cents = $8, withdrawals_per_month = $9,
          savings_lock_in_months = $10, early_withdrawal_penalty_basis_points = $11,
          contribution_frequency = $12::institution_savings_frequency, updated_at = now()
        WHERE id = $1 AND institution_id = $2 RETURNING *`,
      [req.params.productId, req.institutionAuth.institutionId, name, String(body.description || '').slice(0, 2000), min, max, rate, minBalance, withdrawals, lockMonths, penalty, contributionFrequency]
    )
    res.json(rows[0])
  } catch (error) {
    if (!error.code) return badRequest(res, error.message)
    throw error
  }
}))

institutionFinanceRouter.patch('/products/:productId', requireInstitutionPermission('product:manage'), asyncHandler(async (req, res) => {
  const status = String(req.body?.status || '').toUpperCase()
  if (!uuid.test(req.params.productId) || !productStatuses.has(status)) return badRequest(res, 'Provide a valid product ID and status.')
  const { rows } = await query(
    `UPDATE institution_financial_products SET status = $3, updated_at = now()
      WHERE id = $1 AND institution_id = $2
        AND ($3 <> 'ACTIVE' OR product_type = 'SAVINGS' OR (loan_interest_model IS NOT NULL AND repayment_frequency IS NOT NULL))
      RETURNING *`, [req.params.productId, req.institutionAuth.institutionId, status]
  )
  if (!rows.length) return res.status(404).json({ message: 'Product not found.' })
  res.json(rows[0])
}))

institutionFinanceRouter.get('/accounts', requireInstitutionPermission('finance:view'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, p.name AS product_name, p.product_type, c.customer_number, c.first_name, c.last_name, c.phone_number,
            schedule.installments, split_allocations.allocations AS split_allocations
       FROM institution_financial_accounts a
       JOIN institution_financial_products p ON p.id = a.product_id AND p.institution_id = a.institution_id
       JOIN institution_customers c ON c.id = a.customer_id AND c.institution_id = a.institution_id
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('installmentNumber', i.installment_number, 'dueDate', i.due_date,
                  'amountDueCents', i.amount_due_cents, 'amountPaidCents', i.amount_paid_cents, 'status', i.status)
                  ORDER BY i.installment_number) AS installments
           FROM institution_loan_installments i WHERE i.account_id = a.id
       ) schedule ON TRUE
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('type', x.allocation_type, 'amountCents', x.amount_cents,
                  'createdAt', x.created_at, 'sweepReference', t.internal_reference) ORDER BY x.created_at DESC) AS allocations
           FROM institution_split_financial_allocations x JOIN transactions t ON t.id = x.sweep_transaction_id
          WHERE x.account_id = a.id
       ) split_allocations ON TRUE
      WHERE a.institution_id = $1 AND ($2 = 'INSTITUTION_ADMIN' OR a.created_by_staff_id = $3 OR c.branch_id IS NOT DISTINCT FROM $4)
      ORDER BY a.created_at DESC LIMIT 500`, [req.institutionAuth.institutionId, req.institutionAuth.role, req.institutionAuth.id, req.institutionAuth.branchId]
  )
  res.json(rows)
}))

institutionFinanceRouter.post('/accounts', requireInstitutionPermission('account:open'), asyncHandler(async (req, res) => {
  const { customerId, productId, requestedAmountCents, termDays, termMonths } = req.body || {}
  if (!uuid.test(customerId || '') || !uuid.test(productId || '')) return badRequest(res, 'A valid customer and product are required.')
  let amount
  try { amount = cents(requestedAmountCents, 'Requested amount') } catch (error) { return badRequest(res, error.message) }
  const result = await withTransaction(async (tx) => {
    const { rows: customers } = await tx.query(
      `SELECT id FROM institution_customers WHERE id = $1 AND institution_id = $2 AND kyc_status = 'VERIFIED' AND is_active
        AND ($3 = 'INSTITUTION_ADMIN' OR branch_id IS NOT DISTINCT FROM $4) FOR UPDATE`,
      [customerId, req.institutionAuth.institutionId, req.institutionAuth.role, req.institutionAuth.branchId]
    )
    if (!customers.length) return { error: 'Verified customer was not found in your branch.' }
    const { rows: products } = await tx.query(
      `SELECT * FROM institution_financial_products WHERE id = $1 AND institution_id = $2 AND status = 'ACTIVE' FOR UPDATE`,
      [productId, req.institutionAuth.institutionId]
    )
    const product = products[0]
    if (!product) return { error: 'Active institution product was not found.' }
    if (amount < Number(product.min_amount_cents) || amount > Number(product.max_amount_cents)) return { error: 'Requested amount is outside this product’s configured bounds.' }
    const term = resolveTermDays(product, termDays, termMonths)
    if (product.product_type === 'LOAN' && !term) return { error: 'Select a configured loan tenor that is within the product’s term boundaries.' }
    if (product.product_type === 'LOAN' && Number(product.min_contribution_history_cents) > 0 &&
        await savingsContributionHistory(tx, req.institutionAuth.institutionId, customerId) < Number(product.min_contribution_history_cents)) {
      return { error: 'Customer contribution history is below this loan product’s eligibility minimum.' }
    }
    const { rows: existing } = await tx.query(
      `SELECT count(*)::int AS count FROM institution_financial_accounts
        WHERE customer_id = $1 AND product_id = $2 AND status IN ('PENDING_APPROVAL','APPROVED','ACTIVE')`, [customerId, productId]
    )
    if (existing[0].count >= product.max_active_accounts_per_customer) return { error: 'Customer reached the active account limit for this product.' }
    const accountNumber = `XG-${crypto.randomBytes(6).toString('hex').toUpperCase()}`
    const { rows } = await tx.query(
      `INSERT INTO institution_financial_accounts
        (institution_id, customer_id, product_id, account_number, requested_amount_cents, contractual_due_cents,
         outstanding_cents, annual_rate_basis_points, term_days, maturity_date, created_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$5,CASE WHEN $9 = 'LOAN' THEN $5 ELSE 0 END,$6,$7,
         CASE WHEN $9 = 'SAVINGS' AND $10::int > 0 THEN (CURRENT_DATE + make_interval(months => $10::int))::date WHEN $7::int IS NOT NULL THEN CURRENT_DATE + $7::int ELSE NULL END,$8)
       RETURNING *`,
      [req.institutionAuth.institutionId, customerId, productId, accountNumber, amount, product.annual_rate_basis_points, term, req.institutionAuth.id, product.product_type, product.savings_lock_in_months]
    )
    return { account: rows[0] }
  })
  if (result.error) return res.status(409).json({ message: result.error })
  res.status(201).json(result.account)
}))

institutionFinanceRouter.patch('/accounts/:accountId/decision', requireInstitutionPermission('account:approve'), asyncHandler(async (req, res) => {
  const { decision } = req.body || {}
  if (!uuid.test(req.params.accountId) || !['APPROVED', 'REJECTED'].includes(decision)) return badRequest(res, 'Provide a valid account ID and APPROVED or REJECTED decision.')
  if (decision === 'APPROVED' && req.institutionAuth.role === 'SUPERVISOR') {
    const { rows: accounts } = await query(
      `SELECT a.requested_amount_cents, i.supervisor_approval_limit_cents FROM institution_financial_accounts a
        JOIN institutions i ON i.id = a.institution_id
       WHERE a.id = $1 AND a.institution_id = $2 AND a.status = 'PENDING_APPROVAL'
         AND EXISTS (SELECT 1 FROM institution_customers c WHERE c.id = a.customer_id AND c.branch_id IS NOT DISTINCT FROM $3)`,
      [req.params.accountId, req.institutionAuth.institutionId, req.institutionAuth.branchId]
    )
    if (accounts.length && Number(accounts[0].requested_amount_cents) > Number(accounts[0].supervisor_approval_limit_cents)) return res.status(403).json({ message: 'This loan exceeds your approval limit and requires institution admin review.' })
  }
  const { rows } = await query(
    `UPDATE institution_financial_accounts a
        SET status = $3, approved_by_staff_id = $4, approved_at = now(), updated_at = now()
      WHERE a.id = $1 AND a.institution_id = $2 AND a.status = 'PENDING_APPROVAL'
        AND ($5 = 'INSTITUTION_ADMIN' OR EXISTS (
          SELECT 1 FROM institution_customers c WHERE c.id = a.customer_id AND c.branch_id IS NOT DISTINCT FROM $6
        )) RETURNING a.*`,
    [req.params.accountId, req.institutionAuth.institutionId, decision, req.institutionAuth.id, req.institutionAuth.role, req.institutionAuth.branchId]
  )
  if (!rows.length) return res.status(404).json({ message: 'Pending account not found in your approval scope.' })
  res.json(rows[0])
}))

institutionFinanceRouter.get('/transactions', requireInstitutionPermission('finance:view'), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT t.*, a.account_number, a.customer_id, c.customer_number, c.first_name, c.last_name
       FROM institution_financial_transactions t
       JOIN institution_financial_accounts a ON a.id = t.account_id AND a.institution_id = t.institution_id
       JOIN institution_customers c ON c.id = a.customer_id
      WHERE t.institution_id = $1
        AND ($2 = 'INSTITUTION_ADMIN' OR c.branch_id IS NOT DISTINCT FROM $3 OR t.created_by_staff_id = $4)
      ORDER BY t.created_at DESC LIMIT 500`,
    [req.institutionAuth.institutionId, req.institutionAuth.role, req.institutionAuth.branchId, req.institutionAuth.id]
  )
  res.json(rows)
}))

institutionFinanceRouter.post('/transactions', requireInstitutionPermission('transaction:create'), asyncHandler(async (req, res) => {
  const { accountId, transactionType, amountCents, externalReference, note, phoneNumber } = req.body || {}
  const allowed = new Set(['DEPOSIT', 'WITHDRAWAL', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT'])
  if (!uuid.test(accountId || '') || !allowed.has(transactionType) || !/^233[0-9]{9}$/.test(String(phoneNumber || '').replace(/\D/g, ''))) return badRequest(res, 'Provide a valid account, transaction type, and Ghana customer mobile number in 233XXXXXXXXX format.')
  const amount = Number(amountCents)
  if (!Number.isSafeInteger(amount) || amount < 1 || !/^[\w.-]{3,160}$/.test(String(externalReference || ''))) return badRequest(res, 'Amount must be positive cents and external reference must be 3–160 letters, numbers, dots, underscores, or hyphens.')
  const { rows } = await query(
    `INSERT INTO institution_financial_transactions
      (institution_id, account_id, transaction_type, amount_cents, external_reference, note, created_by_staff_id, payer_phone_number)
     SELECT $1, a.id, $3, $4, $5, $6, $7,
            CASE WHEN $3 IN ('LOAN_DISBURSEMENT','WITHDRAWAL') THEN c.phone_number ELSE $10 END
       FROM institution_financial_accounts a JOIN institution_customers c ON c.id = a.customer_id AND c.institution_id = a.institution_id
      WHERE a.id = $2 AND a.institution_id = $1
        AND (a.status IN ('APPROVED','ACTIVE') OR ($3 = 'LOAN_REPAYMENT' AND a.status = 'OVERDUE'))
        AND ($8 = 'INSTITUTION_ADMIN' OR EXISTS (
          SELECT 1 FROM institution_customers c WHERE c.id = a.customer_id AND c.branch_id IS NOT DISTINCT FROM $9
        )) RETURNING *`,
    [req.institutionAuth.institutionId, accountId, transactionType, amount, externalReference, String(note || '').slice(0, 1000) || null,
      req.institutionAuth.id, req.institutionAuth.role, req.institutionAuth.branchId, String(phoneNumber).replace(/\D/g, '')]
  )
  if (!rows.length) return res.status(404).json({ message: 'Active account not found in your branch.' })
  res.status(201).json(rows[0])
}))

institutionFinanceRouter.patch('/transactions/:transactionId/decision', requireInstitutionPermission('transaction:approve'), asyncHandler(async (req, res) => {
  const { decision, rejectionNote } = req.body || {}
  if (!uuid.test(req.params.transactionId) || !['POSTED', 'REJECTED'].includes(decision)) return badRequest(res, 'Provide a valid transaction ID and POSTED or REJECTED decision.')
  const { rows: selected } = await query(
      `SELECT t.*, a.product_id, a.customer_id, a.requested_amount_cents, a.balance_cents, a.outstanding_cents,
              a.maturity_date, (a.maturity_date > CURRENT_DATE) AS is_early_withdrawal,
              p.product_type, p.early_withdrawal_penalty_basis_points, p.min_amount_cents,
              p.max_amount_cents, p.min_balance_cents, p.withdrawals_per_month, c.branch_id
         FROM institution_financial_transactions t
         JOIN institution_financial_accounts a ON a.id = t.account_id AND a.institution_id = t.institution_id
         JOIN institution_financial_products p ON p.id = a.product_id
         JOIN institution_customers c ON c.id = a.customer_id
        WHERE t.id = $1 AND t.institution_id = $2 AND t.status = 'PENDING_APPROVAL'
          AND ($3 = 'INSTITUTION_ADMIN' OR c.branch_id IS NOT DISTINCT FROM $4)`,
      [req.params.transactionId, req.institutionAuth.institutionId, req.institutionAuth.role, req.institutionAuth.branchId]
    )
  const item = selected[0]
  if (!item) return res.status(404).json({ message: 'Pending transaction not found in your approval scope.' })
  if (decision === 'POSTED' && req.institutionAuth.role === 'SUPERVISOR') {
    const { rows: limits } = await query('SELECT supervisor_approval_limit_cents FROM institutions WHERE id = $1', [req.institutionAuth.institutionId])
    if (Number(item.amount_cents) > Number(limits[0]?.supervisor_approval_limit_cents || 0)) return res.status(403).json({ message: 'This transaction exceeds your approval limit and requires institution admin review.' })
  }
  if (decision === 'REJECTED') {
    const { rows } = await query(
      `UPDATE institution_financial_transactions SET status = 'REJECTED', approved_by_staff_id = $3, approved_at = now(),
          rejection_note = $4, updated_at = now()
        WHERE id = $1 AND institution_id = $2 AND status = 'PENDING_APPROVAL' RETURNING *`,
      [item.id, req.institutionAuth.institutionId, req.institutionAuth.id, String(rejectionNote || 'Rejected by reviewer.').slice(0, 1000)]
    )
    if (!rows.length) return res.status(409).json({ message: 'Transaction was already reviewed.' })
    return res.json(rows[0])
  }
  const amount = Number(item.amount_cents)
  const available = item.product_type === 'SAVINGS' ? Number(item.balance_cents) : Number(item.outstanding_cents)
  if (item.transaction_type === 'LOAN_DISBURSEMENT' && (item.product_type !== 'LOAN' || amount !== Number(item.requested_amount_cents))) return res.status(409).json({ message: 'Loan disbursement must match an approved loan principal.' })
  if (['DEPOSIT', 'WITHDRAWAL'].includes(item.transaction_type) && item.product_type !== 'SAVINGS') return res.status(409).json({ message: 'Deposit and withdrawal require a savings account.' })
  if (item.transaction_type === 'DEPOSIT' && amount < Number(item.min_amount_cents)) return res.status(409).json({ message: 'Deposit is below the product minimum.' })
  if (item.transaction_type === 'LOAN_REPAYMENT' && (item.product_type !== 'LOAN' || amount > available)) return res.status(409).json({ message: 'Loan repayment exceeds the remaining principal or does not match a loan account.' })
  if (item.transaction_type === 'WITHDRAWAL' && amount > available) return res.status(409).json({ message: 'Withdrawal exceeds the available savings balance.' })
  if (item.transaction_type === 'WITHDRAWAL' && available - amount < Number(item.min_balance_cents || 0)) return res.status(409).json({ message: 'Withdrawal would leave the savings account below its minimum balance.' })
  if (item.transaction_type === 'WITHDRAWAL' && item.withdrawals_per_month) {
    const { rows: count } = await query(
      `SELECT count(*)::int AS count FROM institution_financial_transactions
        WHERE account_id = $1 AND transaction_type = 'WITHDRAWAL' AND status IN ('PENDING_APPROVAL','PENDING_GATEWAY','POSTED')
          AND created_at >= date_trunc('month', now())`, [item.account_id]
    )
    if (count[0].count > Number(item.withdrawals_per_month)) return res.status(409).json({ message: 'Monthly withdrawal limit has been reached.' })
  }

  const feeOperation = { LOAN_REPAYMENT: 'LOAN_REPAYMENT', DEPOSIT: 'SAVINGS_CONTRIBUTION', WITHDRAWAL: 'SAVINGS_WITHDRAWAL' }[item.transaction_type]
  const fee = feeOperation ? await configuredFee(req.institutionAuth.institutionId, feeOperation, amount) : 0
  const penalty = item.transaction_type === 'WITHDRAWAL' && item.is_early_withdrawal
    ? Math.round(amount * Number(item.early_withdrawal_penalty_basis_points || 0) / 10000) : 0
  const payout = item.transaction_type === 'WITHDRAWAL' || item.transaction_type === 'LOAN_DISBURSEMENT'
  // Fees are recorded locally for reconciliation. Eganow is responsible for
  // applying them; only the separate early-withdrawal penalty changes principal.
  const gatewayAmount = payout ? amount - penalty : amount
  if (gatewayAmount <= 0) return res.status(409).json({ message: 'Configured penalty leaves no positive amount to pay out.' })

  const startResult = await withTransaction(async (tx) => {
    const { rows: accounts } = await tx.query(
      `SELECT a.balance_cents, a.outstanding_cents, a.status, p.product_type, p.min_balance_cents
         FROM institution_financial_accounts a JOIN institution_financial_products p ON p.id = a.product_id
        WHERE a.id = $1 AND a.institution_id = $2 FOR UPDATE OF a`, [item.account_id, req.institutionAuth.institutionId]
    )
    const accountRow = accounts[0]
    if (!accountRow) return { error: 'Account no longer exists.' }
    if (item.transaction_type === 'LOAN_DISBURSEMENT') {
      const { rows: priorDisbursements } = await tx.query(
        `SELECT count(*)::int AS count FROM institution_financial_transactions
          WHERE account_id = $1 AND id <> $2 AND transaction_type = 'LOAN_DISBURSEMENT'
            AND status IN ('PENDING_APPROVAL','PENDING_GATEWAY','POSTED')`, [item.account_id, item.id]
      )
      if (priorDisbursements[0].count) return { error: 'This loan account already has a pending or completed disbursement.' }
    }
    const { rows: reservations } = await tx.query(
      `SELECT COALESCE(sum(amount_cents),0)::bigint AS reserved_cents
         FROM institution_financial_transactions
        WHERE account_id = $1 AND id <> $2 AND transaction_type = $3
          AND status IN ('PENDING_APPROVAL','PENDING_GATEWAY')`,
      [item.account_id, item.id, item.transaction_type]
    )
    const balance = Number(accountRow.product_type === 'SAVINGS' ? accountRow.balance_cents : accountRow.outstanding_cents)
    const availableNow = balance - Number(reservations[0].reserved_cents)
    if (['LOAN_REPAYMENT', 'WITHDRAWAL'].includes(item.transaction_type) && amount > availableNow) return { error: 'Other pending transactions reserve the available balance.' }
    if (item.transaction_type === 'WITHDRAWAL' && availableNow - amount < Number(accountRow.min_balance_cents || 0)) return { error: 'Withdrawal would leave the savings account below its minimum balance.' }
    if (item.transaction_type === 'WITHDRAWAL' && item.withdrawals_per_month) {
      const { rows: count } = await tx.query(
        `SELECT count(*)::int AS count FROM institution_financial_transactions
          WHERE account_id = $1 AND id <> $2 AND transaction_type = 'WITHDRAWAL'
            AND status IN ('PENDING_APPROVAL','PENDING_GATEWAY','POSTED') AND created_at >= date_trunc('month', now())`,
        [item.account_id, item.id]
      )
      if (count[0].count >= Number(item.withdrawals_per_month)) return { error: 'Monthly withdrawal limit has been reached.' }
    }
    const { rows: started } = await tx.query(
      `UPDATE institution_financial_transactions SET status = 'PENDING_GATEWAY', approved_by_staff_id = $3,
          approved_at = now(), fee_cents = $4, penalty_cents = $5, payout_amount_cents = $6, updated_at = now()
        WHERE id = $1 AND institution_id = $2 AND status = 'PENDING_APPROVAL' RETURNING *`,
      [item.id, req.institutionAuth.institutionId, req.institutionAuth.id, fee, penalty, payout ? gatewayAmount : null]
    )
    return started.length ? { transaction: started[0] } : { error: 'Transaction was already reviewed.' }
  })
  if (startResult.error) return res.status(409).json({ message: startResult.error })
  await query(
    `INSERT INTO institution_transactions
       (institution_id, type, amount, internal_reference)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (internal_reference) DO NOTHING`,
    [req.institutionAuth.institutionId, payout ? 'PAYOUT' : 'COLLECTION', gatewayAmount / 100, item.external_reference]
  )
  try {
    const initiate = payout ? initiateInstitutionPayout : initiateInstitutionCollection
    const gateway = await initiate(req.institutionAuth.institutionId, {
      reference: item.external_reference, amount: gatewayAmount, msisdn: item.payer_phone_number,
      narration: `${item.transaction_type.replaceAll('_', ' ')} ${item.external_reference}`
    })
    const result = await reconcileInstitutionTransaction(req.institutionAuth.institutionId, item.id, gateway)
    return res.status(result.pending ? 202 : 200).json(result.transaction || { id: item.id, status: 'PENDING_GATEWAY', message: 'Awaiting Eganow result; reconcile by reference if callback is delayed.' })
  } catch (error) {
    const definitive = isDefinitiveEganowRejection(error)
    if (definitive) {
      await query(`UPDATE institution_financial_transactions SET status = 'FAILED', payment_gateway_status = 'REJECTED', failure_reason = $2, updated_at = now() WHERE id = $1 AND status = 'PENDING_GATEWAY'`, [item.id, 'Eganow rejected this payment request.'])
      await query(`UPDATE institution_transactions SET status = 'FAILED', updated_at = now() WHERE internal_reference = $1`, [item.external_reference])
    }
    else await query(`UPDATE institution_financial_transactions SET payment_gateway_status = 'UNKNOWN', failure_reason = 'Provider result is uncertain. Reconcile before retrying.', updated_at = now() WHERE id = $1 AND status = 'PENDING_GATEWAY'`, [item.id])
    return res.status(definitive ? 502 : 202).json({ id: item.id, status: definitive ? 'FAILED' : 'PENDING_GATEWAY', message: definitive ? 'Eganow rejected the payment request.' : 'Eganow response was uncertain. Check status before retrying.' })
  }
}))

institutionFinanceRouter.post('/transactions/:transactionId/reconcile', requireInstitutionPermission('finance:view'), asyncHandler(async (req, res) => {
  if (!uuid.test(req.params.transactionId)) return badRequest(res, 'Transaction ID is invalid.')
  const { rows } = await query(`SELECT id, external_reference, status FROM institution_financial_transactions WHERE id = $1 AND institution_id = $2`, [req.params.transactionId, req.institutionAuth.institutionId])
  if (!rows.length) return res.status(404).json({ message: 'Transaction not found.' })
  if (rows[0].status !== 'PENDING_GATEWAY') return res.json(rows[0])
  try {
    const gateway = await queryInstitutionEganowStatus(req.institutionAuth.institutionId, rows[0].external_reference)
    const result = await reconcileInstitutionTransaction(req.institutionAuth.institutionId, rows[0].id, gateway)
    res.json(result.transaction || { id: rows[0].id, status: 'PENDING_GATEWAY' })
  } catch (error) {
    const message = error instanceof InstitutionCredentialsError ? error.message : 'Unable to check Eganow status. Try again later.'
    res.status(502).json({ message })
  }
}))

institutionFinanceRouter.get('/fees', requireInstitutionPermission('finance:view'), asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT operation, fee_type, fee_value, currency, updated_at FROM institution_financial_fee_rules WHERE institution_id = $1 ORDER BY operation', [req.institutionAuth.institutionId])
  res.json(rows)
}))

institutionFinanceRouter.put('/fees', requireInstitutionPermission('rule_config:write'), asyncHandler(async (req, res) => {
  const rules = req.body?.rules
  if (!Array.isArray(rules) || rules.length > feeOperations.size) return badRequest(res, 'Provide fee rules as an array.')
  const unique = new Set()
  for (const rule of rules) {
    if (!feeOperations.has(rule.operation) || !feeTypes.has(rule.feeType) || unique.has(rule.operation)) return badRequest(res, 'Each fee operation must be unique and use a supported fee type.')
    const value = Number(rule.feeValue)
    if (!Number.isFinite(value) || value < 0 || (rule.feeType === 'PERCENTAGE' && value > 100) || (rule.feeType === 'NONE' && value !== 0)) return badRequest(res, 'Fee value is invalid for its fee type.')
    unique.add(rule.operation)
  }
  const rows = await withTransaction(async (tx) => {
    for (const rule of rules) await tx.query(
      `INSERT INTO institution_financial_fee_rules (institution_id, operation, fee_type, fee_value, updated_by_staff_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (institution_id, operation) DO UPDATE SET
         fee_type = EXCLUDED.fee_type, fee_value = EXCLUDED.fee_value, updated_by_staff_id = EXCLUDED.updated_by_staff_id, updated_at = now()`,
      [req.institutionAuth.institutionId, rule.operation, rule.feeType, Number(rule.feeValue), req.institutionAuth.id]
    )
    return tx.query('SELECT operation, fee_type, fee_value, currency, updated_at FROM institution_financial_fee_rules WHERE institution_id = $1 ORDER BY operation', [req.institutionAuth.institutionId])
  })
  res.json(rows.rows)
}))

// Tenant access is limited to active institution products on an approved link.
// Account access further requires explicit tenant association on the customer.
tenantInstitutionFinanceRouter.use(authenticate)

tenantInstitutionFinanceRouter.get('/products', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  const { rows } = await query(
    `SELECT p.id, p.institution_id, i.name AS institution_name, p.product_type, p.name, p.description,
            p.currency, p.min_amount_cents, p.max_amount_cents, p.annual_rate_basis_points,
            p.min_term_days, p.max_term_days, p.min_balance_cents, p.withdrawals_per_month,
            p.loan_interest_model, p.repayment_frequency, p.savings_lock_in_months, p.early_withdrawal_penalty_basis_points,
            p.contribution_frequency, p.tenor_options_months, p.late_fee_basis_points, p.grace_period_days,
            p.min_contribution_history_cents
       FROM institution_financial_products p JOIN institutions i ON i.id = p.institution_id
       JOIN tenant_institution_links l ON l.institution_id = p.institution_id AND l.tenant_id = $1
      WHERE p.status = 'ACTIVE' AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
      ORDER BY i.name, p.product_type, p.name`, [tenantId]
  )
  res.json(rows)
}))

tenantInstitutionFinanceRouter.get('/customers', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  const { rows } = await query(
    `SELECT c.id, c.institution_id, i.name AS institution_name, c.customer_number, c.first_name, c.last_name, c.phone_number
       FROM institution_customers c JOIN institutions i ON i.id = c.institution_id
       JOIN tenant_institution_links l ON l.institution_id = c.institution_id AND l.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND c.kyc_status = 'VERIFIED' AND c.is_active
        AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
      ORDER BY i.name, c.last_name, c.first_name`, [tenantId]
  )
  res.json(rows)
}))

tenantInstitutionFinanceRouter.get('/accounts', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  const { rows } = await query(
    `SELECT a.id, a.institution_id, i.name AS institution_name, a.account_number, a.status,
            a.requested_amount_cents, a.contractual_due_cents, a.balance_cents, a.outstanding_cents,
            a.maturity_date, p.name AS product_name, p.product_type, schedule.installments,
            split_allocations.allocations AS split_allocations
       FROM institution_financial_accounts a JOIN institution_customers c ON c.id = a.customer_id
       JOIN institution_financial_products p ON p.id = a.product_id
       JOIN institutions i ON i.id = a.institution_id
       JOIN tenant_institution_links l ON l.institution_id = a.institution_id AND l.tenant_id = $1
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('installmentNumber', x.installment_number, 'dueDate', x.due_date,
                  'amountDueCents', x.amount_due_cents, 'amountPaidCents', x.amount_paid_cents, 'status', x.status)
                  ORDER BY x.installment_number) AS installments
           FROM institution_loan_installments x WHERE x.account_id = a.id
       ) schedule ON TRUE
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('type', x.allocation_type, 'amountCents', x.amount_cents,
                  'createdAt', x.created_at, 'sweepReference', t.internal_reference) ORDER BY x.created_at DESC) AS allocations
           FROM institution_split_financial_allocations x JOIN transactions t ON t.id = x.sweep_transaction_id
          WHERE x.account_id = a.id
       ) split_allocations ON TRUE
      WHERE c.tenant_id = $1 AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
      ORDER BY a.created_at DESC`, [tenantId]
  )
  res.json(rows)
}))

tenantInstitutionFinanceRouter.post('/accounts', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  const { customerId, productId, requestedAmountCents, termDays, termMonths } = req.body || {}
  if (!uuid.test(customerId || '') || !uuid.test(productId || '')) return badRequest(res, 'A linked customer and institution product are required.')
  if (!['TENANT_ADMIN', 'TENANT_MANAGER'].includes(req.user.role)) return res.status(403).json({ message: 'Only tenant administrators and managers can submit institution account requests.' })
  let amount
  try { amount = cents(requestedAmountCents, 'Requested amount') } catch (error) { return badRequest(res, error.message) }
  const result = await withTransaction(async (tx) => {
    const { rows: customers } = await tx.query(
      `SELECT c.id, c.institution_id FROM institution_customers c
        JOIN tenant_institution_links l ON l.institution_id = c.institution_id AND l.tenant_id = c.tenant_id
       WHERE c.id = $1 AND c.tenant_id = $2 AND c.kyc_status = 'VERIFIED' AND c.is_active
         AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED' FOR UPDATE OF c`, [customerId, tenantId]
    )
    if (!customers.length) return { error: 'Customer is not verified and associated with this tenant and an approved institution link.' }
    const { rows: products } = await tx.query(
      `SELECT p.* FROM institution_financial_products p
        JOIN tenant_institution_links l ON l.institution_id = p.institution_id AND l.tenant_id = $2
       WHERE p.id = $1 AND p.status = 'ACTIVE' AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'`, [productId, tenantId]
    )
    const product = products[0]
    if (!product) return { error: 'Product is not active or the tenant link is not approved.' }
    if (amount < Number(product.min_amount_cents) || amount > Number(product.max_amount_cents)) return { error: 'Requested amount is outside the product bounds.' }
    const term = resolveTermDays(product, termDays, termMonths)
    if (product.product_type === 'LOAN' && !term) return { error: 'Select a configured loan tenor that is within the product term boundaries.' }
    if (product.product_type === 'LOAN' && Number(product.min_contribution_history_cents) > 0 &&
        await savingsContributionHistory(tx, product.institution_id, customerId) < Number(product.min_contribution_history_cents)) {
      return { error: 'Customer contribution history is below this loan product’s eligibility minimum.' }
    }
    const { rows: existing } = await tx.query(`SELECT count(*)::int AS count FROM institution_financial_accounts WHERE customer_id = $1 AND product_id = $2 AND status IN ('PENDING_APPROVAL','APPROVED','ACTIVE')`, [customerId, productId])
    if (existing[0].count >= product.max_active_accounts_per_customer) return { error: 'Customer reached the account limit for this product.' }
    const { rows } = await tx.query(
      `INSERT INTO institution_financial_accounts
        (institution_id, customer_id, product_id, account_number, requested_amount_cents, contractual_due_cents,
         outstanding_cents, annual_rate_basis_points, term_days, maturity_date, created_by_tenant_user_id)
       VALUES ($1,$2,$3,$4,$5,$5,CASE WHEN $9 = 'LOAN' THEN $5 ELSE 0 END,$6,$7,
         CASE WHEN $9 = 'SAVINGS' AND $10::int > 0 THEN (CURRENT_DATE + make_interval(months => $10::int))::date WHEN $7::int IS NOT NULL THEN CURRENT_DATE + $7::int ELSE NULL END,$8)
       RETURNING id, institution_id, account_number, status, requested_amount_cents, outstanding_cents, term_days`,
      [product.institution_id, customerId, productId, `XG-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
        amount, product.annual_rate_basis_points, term, req.user.id, product.product_type, product.savings_lock_in_months]
    )
    return { account: rows[0] }
  })
  if (result.error) return res.status(409).json({ message: result.error })
  res.status(201).json(result.account)
}))

tenantInstitutionFinanceRouter.get('/fees', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  const { rows } = await query(
    `SELECT f.institution_id, i.name AS institution_name, f.operation, f.fee_type, f.fee_value, f.currency
       FROM institution_financial_fee_rules f JOIN institutions i ON i.id = f.institution_id
       JOIN tenant_institution_links l ON l.institution_id = f.institution_id AND l.tenant_id = $1
      WHERE l.status = 'ACTIVE' AND l.verification_status = 'APPROVED' ORDER BY i.name, f.operation`, [tenantId]
  )
  res.json(rows)
}))

tenantInstitutionFinanceRouter.get('/transactions', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  const { rows } = await query(
    `SELECT t.id, t.institution_id, t.account_id, t.transaction_type, t.status, t.amount_cents,
            t.external_reference, t.note, t.created_at, a.account_number, p.name AS product_name, i.name AS institution_name
       FROM institution_financial_transactions t JOIN institution_financial_accounts a ON a.id = t.account_id
       JOIN institution_customers c ON c.id = a.customer_id JOIN institution_financial_products p ON p.id = a.product_id
       JOIN institutions i ON i.id = t.institution_id
      WHERE c.tenant_id = $1 ORDER BY t.created_at DESC LIMIT 300`, [tenantId]
  )
  res.json(rows)
}))

tenantInstitutionFinanceRouter.post('/transactions', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res)
  if (!tenantId) return
  if (!['TENANT_ADMIN', 'TENANT_MANAGER'].includes(req.user.role)) return res.status(403).json({ message: 'Only tenant administrators and managers can submit financial transactions.' })
  const { accountId, transactionType, amountCents, externalReference, note, phoneNumber } = req.body || {}
  if (!uuid.test(accountId || '') || !['DEPOSIT', 'WITHDRAWAL', 'LOAN_REPAYMENT'].includes(transactionType)) return badRequest(res, 'Select a linked account and supported settlement operation.')
  const amount = Number(amountCents)
  if (!Number.isSafeInteger(amount) || amount < 1 || !/^233[0-9]{9}$/.test(String(phoneNumber || '').replace(/\D/g, ''))) return badRequest(res, 'Provide a positive amount in cents and a Ghana mobile number in 233XXXXXXXXX format.')
  const reference = String(externalReference || `XG-${crypto.randomUUID()}`).trim()
  if (!/^[\w.-]{3,160}$/.test(reference)) return badRequest(res, 'Payment reference must be 3–160 letters, numbers, dots, underscores, or hyphens.')
  const created = await withTransaction(async (tx) => {
    const { rows: accountRows } = await tx.query(
      `SELECT a.institution_id, a.status AS account_status, a.balance_cents, a.outstanding_cents,
              c.phone_number, p.product_type, p.min_amount_cents, p.min_balance_cents, p.withdrawals_per_month
         FROM institution_financial_accounts a
         JOIN institution_customers c ON c.id = a.customer_id
         JOIN institution_financial_products p ON p.id = a.product_id
         JOIN tenant_institution_links l ON l.institution_id = a.institution_id AND l.tenant_id = $1
        WHERE a.id = $2 AND c.tenant_id = $1 AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
        FOR UPDATE OF a`, [tenantId, accountId]
    )
    const accountRow = accountRows[0]
    if (!accountRow) return { error: 'Account not found or not associated with an approved institution link.' }
    const correctType = transactionType === 'LOAN_REPAYMENT' ? accountRow.product_type === 'LOAN' : accountRow.product_type === 'SAVINGS'
    const allowedStatus = ['APPROVED', 'ACTIVE'].includes(accountRow.account_status) || (transactionType === 'LOAN_REPAYMENT' && accountRow.account_status === 'OVERDUE')
    if (!correctType || !allowedStatus) return { error: 'Account state or operation does not match the requested transaction.' }
    if (transactionType === 'DEPOSIT' && amount < Number(accountRow.min_amount_cents)) return { error: 'Contribution is below the product minimum.' }
    const { rows: reservations } = await tx.query(
      `SELECT COALESCE(sum(amount_cents),0)::bigint AS reserved_cents FROM institution_financial_transactions
        WHERE account_id = $1 AND transaction_type = $2 AND status IN ('PENDING_APPROVAL','PENDING_GATEWAY')`,
      [accountId, transactionType]
    )
    const available = Number(transactionType === 'LOAN_REPAYMENT' ? accountRow.outstanding_cents : accountRow.balance_cents) - Number(reservations[0].reserved_cents)
    if (transactionType === 'LOAN_REPAYMENT' && amount > available) return { error: 'Repayment exceeds the unreserved loan balance.' }
    if (transactionType === 'WITHDRAWAL' && amount > available) return { error: 'Withdrawal exceeds the unreserved savings balance.' }
    if (transactionType === 'WITHDRAWAL' && available - amount < Number(accountRow.min_balance_cents)) return { error: 'Withdrawal would leave the account below its minimum balance.' }
    if (transactionType === 'WITHDRAWAL' && accountRow.withdrawals_per_month) {
      const { rows: count } = await tx.query(
        `SELECT count(*)::int AS count FROM institution_financial_transactions
          WHERE account_id = $1 AND transaction_type = 'WITHDRAWAL'
            AND status IN ('PENDING_APPROVAL','PENDING_GATEWAY','POSTED') AND created_at >= date_trunc('month', now())`, [accountId]
      )
      if (count[0].count >= Number(accountRow.withdrawals_per_month)) return { error: 'Monthly withdrawal limit has been reached.' }
    }
    const { rows } = await tx.query(
      `INSERT INTO institution_financial_transactions
        (institution_id, account_id, transaction_type, status, amount_cents, external_reference, note, created_by_tenant_user_id, payer_phone_number)
       VALUES ($1,$2,$3,CASE WHEN $3 = 'WITHDRAWAL' THEN 'PENDING_APPROVAL'::institution_financial_transaction_status ELSE 'PENDING_GATEWAY'::institution_financial_transaction_status END,
         $4,$5,$6,$7,CASE WHEN $3 = 'WITHDRAWAL' THEN $8 ELSE $9 END) RETURNING *`,
      [accountRow.institution_id, accountId, transactionType, amount, reference, String(note || '').slice(0, 1000) || null,
        req.user.id, accountRow.phone_number, String(phoneNumber).replace(/\D/g, '')]
    )
    return { transaction: rows[0] }
  })
  if (created.error) return res.status(409).json({ message: created.error })
  const transaction = created.transaction
  if (transactionType === 'WITHDRAWAL') return res.status(201).json(transaction)
  const feeOperation = transactionType === 'LOAN_REPAYMENT' ? 'LOAN_REPAYMENT' : 'SAVINGS_CONTRIBUTION'
  const fee = await configuredFee(transaction.institution_id, feeOperation, amount)
  await query(`UPDATE institution_financial_transactions SET fee_cents = $2 WHERE id = $1`, [transaction.id, fee])
  try {
    const gateway = await initiateInstitutionCollection(transaction.institution_id, {
      reference, amount: amount / 100, msisdn: transaction.payer_phone_number,
      narration: `${transactionType.replaceAll('_', ' ')} ${reference}`
    })
    const result = await reconcileInstitutionTransaction(transaction.institution_id, transaction.id, gateway)
    res.status(result.pending ? 202 : 201).json(result.transaction || { id: transaction.id, status: 'PENDING_GATEWAY' })
  } catch (error) {
    const definitive = isDefinitiveEganowRejection(error)
    if (definitive) await query(`UPDATE institution_financial_transactions SET status = 'FAILED', fee_cents = $2, payment_gateway_status = 'REJECTED', failure_reason = 'Eganow rejected the collection request.', updated_at = now() WHERE id = $1`, [transaction.id, fee])
    else await query(`UPDATE institution_financial_transactions SET fee_cents = $2, payment_gateway_status = 'UNKNOWN', failure_reason = 'Provider result is uncertain. Reconcile before retrying.', updated_at = now() WHERE id = $1`, [transaction.id, fee])
    res.status(definitive ? 502 : 202).json({ id: transaction.id, status: definitive ? 'FAILED' : 'PENDING_GATEWAY', message: definitive ? 'Eganow rejected the collection request.' : 'Eganow response is uncertain; check status before retrying.' })
  }
}))
