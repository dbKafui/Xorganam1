import { Router } from 'express'
import crypto from 'node:crypto'
import { query, withTransaction } from '../db/pool.js'
import { hashPassword } from '../security/password.js'
import { signToken } from '../security/jwt.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { initiateCollection, CollectionRejectedError } from '../services/collectionService.js'

export const publicRouter = Router()

function getEganowCallbackUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim()
  return process.env.EGANOW_CALLBACK_URL || `${proto}://${req.get('host')}/api/v1/webhooks/eganow`
}

// =====================================================================
// Operator (Tenant) self-registration - the business holding Eganow
// credentials and managing many market-woman Merchants underneath it.
// Market women themselves never hit this router with a login - only SMS.
// =====================================================================
publicRouter.post(
  '/tenants/register',
  asyncHandler(async (req, res) => {
    const { companyName, contactPhone, contactEmail, firstName, lastName, email, password } = req.body || {}

    if (!companyName || !contactPhone || !contactEmail || !firstName || !lastName || !email || !password) {
      return res.status(400).json({ message: 'All fields are required.' })
    }
    if (String(password).length < 10) {
      return res.status(400).json({ message: 'Password must be at least 10 characters.' })
    }

    const normalizedEmail = String(email).toLowerCase().trim()

    const existing = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail])
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: 'An account with this email already exists. Try logging in instead.' })
    }

    const result = await withTransaction(async (client) => {
      const apiKeySalt = crypto.randomBytes(16).toString('hex')

      const tenantResult = await client.query(
        `INSERT INTO tenants (company_name, contact_phone, contact_email, api_key_salt, status)
         VALUES ($1, $2, $3, $4, 'PENDING')
         RETURNING id, company_name`,
        [companyName, contactPhone, contactEmail, apiKeySalt]
      )
      const tenant = tenantResult.rows[0]

      const passwordHash = await hashPassword(password)

      const userResult = await client.query(
        `INSERT INTO users (tenant_id, first_name, last_name, email, phone_number, password_hash, role, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, 'TENANT_ADMIN', TRUE)
         RETURNING id, tenant_id, first_name, last_name, email, role`,
        [tenant.id, firstName, lastName, normalizedEmail, contactPhone, passwordHash]
      )

      return { tenant, user: userResult.rows[0] }
    })

    const token = signToken({ id: result.user.id, tenantId: result.tenant.id, role: 'TENANT_ADMIN' })

    res.status(201).json({
      token,
      user: {
        id: result.user.id,
        tenantId: result.tenant.id,
        tenantCompanyName: result.tenant.company_name,
        firstName: result.user.first_name,
        lastName: result.user.last_name,
        email: result.user.email,
        role: 'TENANT_ADMIN',
        isPlatformAdmin: false
      }
    })
  })
)

// =====================================================================
// Customer checkout - anonymous, scoped to a single merchant (market
// woman). The customer never needs to know which tenant/operator she
// belongs to.
// =====================================================================
publicRouter.get(
  '/merchants/:merchantId',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT m.id, m.display_name, m.is_active,
              t.status AS tenant_status,
              c.is_enabled AS eganow_enabled
         FROM merchants m
         JOIN tenants t ON t.id = m.tenant_id
         JOIN tenant_eganow_credentials c ON c.tenant_id = t.id
        WHERE m.id = $1`,
      [req.params.merchantId]
    )

    if (rows.length === 0) return res.status(404).json({ message: 'Merchant not found.' })

    const merchant = rows[0]
    res.json({
      merchantId: merchant.id,
      displayName: merchant.display_name,
      acceptingPayments: merchant.is_active && merchant.tenant_status === 'ACTIVE' && merchant.eganow_enabled
    })
  })
)

publicRouter.post(
  '/collect',
  asyncHandler(async (req, res) => {
    const { merchantId, amount, msisdn, network } = req.body || {}

    if (!merchantId) return res.status(400).json({ message: 'merchantId is required.' })

    try {
      const result = await initiateCollection(merchantId, {
        amount: Number(amount),
        msisdn,
        network,
        narration: 'Customer checkout payment',
        callback: getEganowCallbackUrl(req)
      })

      res.json({
        reference: result.internalReference,
        status: result.status,
        failureReason: result.status === 'FAILED' ? result.failureReason || null : null,
        message:
          result.status === 'FAILED'
            ? result.failureReason || 'Payment could not be started.'
            : 'Check your phone to approve the payment prompt.'
      })
    } catch (err) {
      if (err instanceof CollectionRejectedError) {
        return res.status(400).json({ status: 'Rejected', message: err.message })
      }
      throw err
    }
  })
)

publicRouter.get(
  '/collect/:reference/status',
  asyncHandler(async (req, res) => {
    // Reference is a high-entropy, single-use, unguessable token, which is
    // an acceptable ownership check for a status-only read with no side
    // effects - no MSISDN needs to be persisted/compared for this schema.
    const { rows } = await query(
      `SELECT internal_reference, status, amount, failure_reason FROM transactions WHERE internal_reference = $1`,
      [req.params.reference]
    )

    if (rows.length === 0) return res.status(404).json({ message: 'Payment not found.' })

    const txn = rows[0]
    res.json({
      reference: txn.internal_reference,
      status: txn.status,
      amount: txn.amount,
      failureReason: txn.status === 'FAILED' ? txn.failure_reason : null
    })
  })
)
