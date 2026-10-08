import crypto from 'node:crypto'
import { Router } from 'express'
import { query, withTransaction } from '../db/pool.js'
import { authenticate, requirePlatformAdmin } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { hashPassword } from '../security/password.js'
import { writePlatformAudit } from '../services/auditService.js'
import { hasCompleteInstitutionVerification, normalizeInstitutionVerificationChecks } from '../services/institutionOnboardingPolicy.js'

export const institutionOnboardingPublicRouter = Router()
export const institutionOnboardingAdminRouter = Router()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TYPES = new Set(['SAVINGS_AND_LOANS', 'CREDIT_UNION'])

function normalizePhone(value) {
  const digits = String(value || '').trim().replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) return `233${digits.slice(1)}`
  if (digits.startsWith('233') && digits.length === 12) return digits
  return null
}

function verifyTrackingToken(token, digest) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return false
  const supplied = crypto.createHash('sha256').update(token).digest()
  const stored = Buffer.from(digest, 'hex')
  return supplied.length === stored.length && crypto.timingSafeEqual(supplied, stored)
}

institutionOnboardingPublicRouter.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {}
  const institutionName = String(body.institutionName || '').trim()
  const institutionType = String(body.institutionType || '').toUpperCase()
  const settlementMsisdn = normalizePhone(body.settlementMsisdn)
  const settlementAccountName = String(body.settlementAccountName || '').trim()
  const firstName = String(body.adminFirstName || '').trim()
  const lastName = String(body.adminLastName || '').trim()
  const email = String(body.adminEmail || '').trim().toLowerCase()
  const password = body.adminPassword

  if (institutionName.length < 2 || institutionName.length > 160 || !TYPES.has(institutionType) ||
      !settlementMsisdn || settlementAccountName.length < 2 || settlementAccountName.length > 160 ||
      firstName.length < 1 || firstName.length > 100 || lastName.length < 1 || lastName.length > 100 ||
      email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return res.status(400).json({ message: 'Provide valid institution, settlement, administrator, and password details. Passwords must be 12–128 characters.' })
  }

  const { rows: existingStaff } = await query('SELECT 1 FROM institution_staff WHERE lower(email) = $1 LIMIT 1', [email])
  if (existingStaff.length) return res.status(409).json({ message: 'An institution staff account already uses this email.' })

  const trackingToken = crypto.randomBytes(32).toString('base64url')
  const trackingTokenHash = crypto.createHash('sha256').update(trackingToken).digest('hex')
  const passwordHash = await hashPassword(password)
  try {
    const { rows } = await query(
      `INSERT INTO institution_onboarding_applications
         (institution_name, institution_type, settlement_msisdn, settlement_account_name,
          admin_first_name, admin_last_name, admin_email, admin_password_hash, tracking_token_hash)
       VALUES ($1, $2::institution_type, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, status, created_at`,
      [institutionName, institutionType, settlementMsisdn, settlementAccountName,
        firstName, lastName, email, passwordHash, trackingTokenHash]
    )
    res.status(201).json({ ...rows[0], trackingToken })
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'An application or institution staff account already uses this email.' })
    throw error
  }
}))

institutionOnboardingPublicRouter.post('/:applicationId/status', asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.applicationId)) return res.status(400).json({ message: 'Invalid application ID.' })
  const { rows } = await query(
    `SELECT id, status, institution_name, reviewer_note, created_at, reviewed_at, tracking_token_hash
       FROM institution_onboarding_applications WHERE id = $1`, [req.params.applicationId]
  )
  const application = rows[0]
  if (!application || !verifyTrackingToken(req.body?.trackingToken, application.tracking_token_hash)) {
    return res.status(404).json({ message: 'Application not found. Check the application ID and tracking code.' })
  }
  res.json({ id: application.id, status: application.status, institutionName: application.institution_name,
    reviewerNote: application.reviewer_note, createdAt: application.created_at, reviewedAt: application.reviewed_at })
}))

institutionOnboardingAdminRouter.use(authenticate, requirePlatformAdmin)

institutionOnboardingAdminRouter.get('/applications', asyncHandler(async (req, res) => {
  const status = String(req.query.status || 'PENDING').toUpperCase()
  if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) return res.status(400).json({ message: 'Invalid application status.' })
  const { rows } = await query(
    `SELECT a.id, a.institution_name, a.institution_type, a.settlement_msisdn,
            a.settlement_account_name, a.admin_first_name, a.admin_last_name, a.admin_email,
            a.status, a.institution_id, a.reviewer_note, a.created_at, a.reviewed_at,
            u.first_name AS reviewer_first_name, u.last_name AS reviewer_last_name
       FROM institution_onboarding_applications a
       LEFT JOIN users u ON u.id = a.reviewed_by_user_id
      WHERE a.status = $1::institution_onboarding_status
      ORDER BY a.created_at DESC LIMIT 500`, [status]
  )
  res.json(rows)
}))

institutionOnboardingAdminRouter.post('/applications/:applicationId/approve', asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.applicationId)) return res.status(400).json({ message: 'Invalid application ID.' })
  const reviewerNote = String(req.body?.reviewerNote || '').trim()
  if (reviewerNote.length > 2000) return res.status(400).json({ message: 'Reviewer notes must be at most 2000 characters.' })
  const verificationChecks = normalizeInstitutionVerificationChecks(req.body?.verification)
  if (!hasCompleteInstitutionVerification(verificationChecks)) {
    return res.status(400).json({ message: 'Verify the legal entity, settlement account, and applicant authority independently before approval.' })
  }

  try {
    const result = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT * FROM institution_onboarding_applications WHERE id = $1 FOR UPDATE`, [req.params.applicationId]
      )
      const application = rows[0]
      if (!application) return { notFound: true }
      if (application.status !== 'PENDING') return { conflict: true }
      if (!application.admin_password_hash) throw new Error('Pending application is missing its administrator password hash.')

      const { rows: existingStaff } = await tx.query(
        'SELECT 1 FROM institution_staff WHERE lower(email) = $1 LIMIT 1', [application.admin_email]
      )
      if (existingStaff.length) return { emailConflict: true }

      const { rows: institutionRows } = await tx.query(
        `INSERT INTO institutions (name, institution_type, settlement_msisdn, settlement_account_name)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [application.institution_name, application.institution_type, application.settlement_msisdn, application.settlement_account_name]
      )
      const institutionId = institutionRows[0].id
      const { rows: adminRows } = await tx.query(
        `INSERT INTO institution_staff
           (institution_id, first_name, last_name, email, password_hash, role)
         VALUES ($1, $2, $3, $4, $5, 'INSTITUTION_ADMIN')
         RETURNING id, email, first_name, last_name`,
        [institutionId, application.admin_first_name, application.admin_last_name,
          application.admin_email, application.admin_password_hash]
      )
      await tx.query(
        `UPDATE institution_onboarding_applications
            SET status = 'APPROVED', institution_id = $2, admin_password_hash = NULL,
                reviewer_note = NULLIF($3, ''), reviewed_by_user_id = $4, reviewed_at = now()
          WHERE id = $1`, [application.id, institutionId, reviewerNote, req.user.id]
      )
      await writePlatformAudit({
        actorUserId: req.user.id,
        action: 'institution.application.approved',
        resourceType: 'institution_onboarding_application',
        resourceId: String(application.id),
        details: {
          institutionId,
          administratorStaffId: adminRows[0].id,
          verificationChecks,
          reviewerNote: reviewerNote || null
        },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.id || null,
        client: tx
      })
      return { institutionId, admin: adminRows[0] }
    })
    if (result.notFound) return res.status(404).json({ message: 'Application not found.' })
    if (result.conflict) return res.status(409).json({ message: 'This application has already been reviewed.' })
    if (result.emailConflict) return res.status(409).json({ message: 'An institution staff account already uses the applicant email. Reject this application and have them apply with a different address.' })
    res.json({ status: 'APPROVED', institutionId: result.institutionId, administrator: result.admin })
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'An institution or staff account with conflicting details already exists.' })
    throw error
  }
}))

institutionOnboardingAdminRouter.post('/applications/:applicationId/reject', asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.applicationId)) return res.status(400).json({ message: 'Invalid application ID.' })
  const reason = String(req.body?.reason || '').trim()
  if (reason.length < 5 || reason.length > 2000) return res.status(400).json({ message: 'Provide a rejection reason between 5 and 2000 characters.' })
  const result = await withTransaction(async (tx) => {
    const { rows: applicationRows } = await tx.query(
      `SELECT id FROM institution_onboarding_applications WHERE id = $1 AND status = 'PENDING' FOR UPDATE`,
      [req.params.applicationId]
    )
    if (!applicationRows.length) return null
    const { rows } = await tx.query(
      `UPDATE institution_onboarding_applications
          SET status = 'REJECTED', reviewer_note = $2, admin_password_hash = NULL,
              reviewed_by_user_id = $3, reviewed_at = now()
        WHERE id = $1 AND status = 'PENDING'
        RETURNING id, status, reviewer_note, reviewed_at`,
      [req.params.applicationId, reason, req.user.id]
    )
    await writePlatformAudit({
      actorUserId: req.user.id,
      action: 'institution.application.rejected',
      resourceType: 'institution_onboarding_application',
      resourceId: String(req.params.applicationId),
      details: { reason },
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      requestId: req.id || null,
      client: tx
    })
    return rows[0]
  })
  if (!result) return res.status(409).json({ message: 'Pending application not found or already reviewed.' })
  res.json(result)
}))
