import { Router } from 'express'
import { query, withTransaction } from '../db/pool.js'
import { authenticate, resolveTenantScope, ForbiddenError, requireAnyRole } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/asyncHandler.js'
import { verifyInstitutionMembership } from '../services/institutionMembershipAdapterService.js'

export const tenantInstitutionLinksRouter = Router()
tenantInstitutionLinksRouter.use(authenticate)

function tenantScope(req, res, requestedId) {
  try { return resolveTenantScope(req, requestedId) } catch (error) {
    if (error instanceof ForbiddenError) { res.status(403).json({ message: error.message }); return null }
    throw error
  }
}

async function writeInstitutionAudit(client, institutionId, linkId, action, actorUserId, note) {
  await client.query(
    `INSERT INTO institution_audit_log
       (institution_id, tenant_institution_link_id, actor_user_id, action, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [institutionId, linkId, actorUserId, action, note ? { ...note } : null]
  )
}

async function notifyTenantUsers(client, tenantId, linkId, status) {
  if (!['APPROVED', 'REJECTED'].includes(status)) return
  await client.query(
    `INSERT INTO tenant_notifications (tenant_id, user_id, notification_type, title, body, data)
     SELECT u.tenant_id, u.id, $2, $3, $4, $5::jsonb
       FROM users u
      WHERE u.tenant_id = $1 AND u.is_active`,
    [
      tenantId,
      `INSTITUTION_LINK_${status}`,
      `Institution membership ${status.toLowerCase()}`,
      `Your institution membership claim was ${status.toLowerCase()}.`,
      JSON.stringify({ linkId, status })
    ]
  )
}

tenantInstitutionLinksRouter.get('/institutions', asyncHandler(async (_req, res) => {
  const { rows } = await query(
    `SELECT id, name, institution_type, api_verification_supported
       FROM institutions WHERE status = 'ACTIVE' ORDER BY name`
  )
  res.json(rows.map((row) => ({ id: row.id, name: row.name, type: row.institution_type, apiVerificationSupported: row.api_verification_supported })))
}))

tenantInstitutionLinksRouter.get('/', asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res, req.query.tenantId)
  if (!tenantId) return
  const { rows } = await query(
    `SELECT l.id, l.institution_id, i.name AS institution_name, l.member_id,
            l.verification_status, l.verification_method, l.verified_at,
            l.sourced_by_staff_id, l.source_channel, l.min_percentage, l.max_percentage,
            l.min_fixed_amount, l.max_fixed_amount, l.frequency_mode_min, l.frequency_mode_max,
            l.periodic_schedule_min, l.periodic_schedule_max, l.priority_deduction_allowed, l.status, l.linked_at
       FROM tenant_institution_links l JOIN institutions i ON i.id = l.institution_id
      WHERE l.tenant_id = $1 ORDER BY l.linked_at DESC`, [tenantId]
  )
  res.json(rows)
}))

tenantInstitutionLinksRouter.post('/', requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER', 'TENANT_BRANCH_MANAGER'), asyncHandler(async (req, res) => {
  const tenantId = tenantScope(req, res, req.body?.tenantId)
  if (!tenantId) return
  if (req.user.role === 'TENANT_BRANCH_MANAGER' && req.body?.acknowledgeTenantWideScope !== true) {
    return res.status(400).json({ message: 'Confirm that linking this institution applies to every branch in your business.' })
  }
  const institutionId = req.body?.institutionId
  const memberId = String(req.body?.memberId || '').trim()
  const referralCode = String(req.body?.ref || req.body?.referralCode || '').trim()
  if (!institutionId || !memberId) return res.status(400).json({ message: 'institutionId and memberId are required.' })
  let verification = { status: 'PENDING', method: 'MANUAL', detail: null }
  const activeInstitution = await query("SELECT api_verification_supported FROM institutions WHERE id = $1 AND status = 'ACTIVE'", [institutionId])
  if (!activeInstitution.rows.length) return res.status(404).json({ message: 'Active institution not found.' })
  if (activeInstitution.rows[0].api_verification_supported) {
    try {
      const result = await verifyInstitutionMembership(institutionId, memberId)
      verification = {
        status: result.active ? 'APPROVED' : 'REJECTED',
        method: 'API',
        detail: result.statusDetail
      }
    } catch {
      return res.status(502).json({ message: 'The institution could not verify this membership right now.' })
    }
  }
  try {
    const link = await withTransaction(async (tx) => {
      const institution = await tx.query("SELECT id, api_verification_supported FROM institutions WHERE id = $1 AND status = 'ACTIVE'", [institutionId])
      if (!institution.rows.length) return { notFound: true }
      let referrer = null
      if (referralCode) {
        const staff = await tx.query(
          `SELECT id FROM institution_staff
            WHERE referral_code = $1 AND institution_id = $2 AND role = 'FIELD_OFFICER' AND is_active = TRUE`,
          [referralCode, institutionId]
        )
        if (!staff.rows.length) return { invalidReferral: true }
        referrer = staff.rows[0].id
      }
      const prior = await tx.query('SELECT id, verification_status, status FROM tenant_institution_links WHERE tenant_id = $1 AND institution_id = $2 FOR UPDATE', [tenantId, institutionId])
      if (prior.rows.length &&
          prior.rows[0].status !== 'INACTIVE' &&
          prior.rows[0].verification_status !== 'REJECTED') return { alreadyExists: true }
      const sourceChannel = referralCode ? (req.body?.ref ? 'FIELD_QR' : 'FIELD_REFERRAL_CODE') : 'TENANT_INITIATED'
      const inserted = prior.rows.length
        ? await tx.query(
          `UPDATE tenant_institution_links
              SET member_id = $2, verification_method = $5, verification_status = $6,
                  status = 'ACTIVE',
                  verified_at = CASE WHEN $6 IN ('APPROVED', 'REJECTED') THEN now() ELSE NULL END,
                  verification_sla_started_at = now(),
                  verified_by_user_id = NULL, verified_by_staff_id = NULL,
                  sourced_by_staff_id = $3, source_channel = $4,
                  linked_at = now(), updated_at = now()
            WHERE id = $1
            RETURNING id, tenant_id, institution_id, member_id, verification_status, verification_method,
                      sourced_by_staff_id, source_channel, status, linked_at, created_at, updated_at`,
          [prior.rows[0].id, memberId, referrer, sourceChannel, verification.method, verification.status]
        )
        : await tx.query(
          `INSERT INTO tenant_institution_links
             (tenant_id, institution_id, member_id, verification_status, verification_method,
              sourced_by_staff_id, source_channel)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, tenant_id, institution_id, member_id, verification_status, verification_method,
                     sourced_by_staff_id, source_channel, status, linked_at, created_at, updated_at`,
          [tenantId, institutionId, memberId, verification.status, verification.method, referrer, sourceChannel]
        )
      const row = inserted.rows[0]
      await writeInstitutionAudit(
        tx,
        institutionId,
        row.id,
        prior.rows.length
          ? 'MEMBERSHIP_LINK_REACTIVATED'
          : verification.method === 'API' ? 'MEMBERSHIP_API_VERIFIED' : 'MEMBERSHIP_LINK_CREATED',
        req.user.id,
        {
          verificationMethod: verification.method,
          verificationStatus: verification.status,
          ...(verification.detail ? { statusDetail: verification.detail } : {})
        }
      )
      await notifyTenantUsers(tx, tenantId, row.id, verification.status)
      const activeAssignment = await tx.query(
        `SELECT 1 FROM institution_member_assignment
          WHERE tenant_institution_link_id = $1 AND effective_to IS NULL`,
        [row.id]
      )
      const officer = activeAssignment.rows.length ? { rows: [] } : await tx.query(
        `SELECT s.id FROM institution_staff s
          WHERE s.institution_id = $1 AND s.role = 'FIELD_OFFICER' AND s.is_active = TRUE
          ORDER BY (SELECT MAX(a.effective_from) FROM institution_member_assignment a WHERE a.institution_id = $1 AND a.field_officer_staff_id = s.id) ASC NULLS FIRST,
                   s.id ASC LIMIT 1`, [institutionId]
      )
      if (!activeAssignment.rows.length && officer.rows.length) {
        await tx.query(
          `INSERT INTO institution_member_assignment (institution_id, tenant_id, tenant_institution_link_id, field_officer_staff_id)
           VALUES ($1, $2, $3, $4)`, [institutionId, tenantId, row.id, officer.rows[0].id]
        )
      }
      return { row, assignmentOfficerId: officer.rows[0]?.id || null }
    })
    if (link.notFound) return res.status(404).json({ message: 'Active institution not found.' })
    if (link.invalidReferral) return res.status(400).json({ message: 'Referral code is invalid for this institution.' })
    if (link.alreadyExists) return res.status(409).json({ message: 'A link to this institution already exists and is awaiting verification or is active.' })
    res.status(201).json({ ...link.row, assignedFieldOfficerId: link.assignmentOfficerId })
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'A link to this institution already exists for this business.' })
    throw error
  }
}))

tenantInstitutionLinksRouter.delete(
  '/:linkId',
  requireAnyRole('TENANT_ADMIN', 'TENANT_MANAGER'),
  asyncHandler(async (req, res) => {
    const tenantId = tenantScope(req, res, req.query.tenantId)
    if (!tenantId) return
    const result = await withTransaction(async (tx) => {
      const { rows: links } = await tx.query(
        `SELECT id, institution_id, status FROM tenant_institution_links
          WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.linkId, tenantId]
      )
      if (!links.length) return { notFound: true }
      const link = links[0]
      if (link.status === 'INACTIVE') return { alreadyInactive: true }

      const { rows: outstanding } = await tx.query(
        `SELECT 1
           FROM institution_sweep_ledger
          WHERE tenant_id = $1 AND institution_id = $2
            AND status IN ('PENDING', 'PARTIALLY_SETTLED', 'ACCRUED_UNSWEPT')
          UNION ALL
         SELECT 1
           FROM periodic_accrual_ledger
          WHERE tenant_id = $1 AND institution_id = $2 AND status = 'PENDING'
          LIMIT 1`,
        [tenantId, link.institution_id]
      )
      if (outstanding.length) return { outstanding: true }

      await tx.query(
        `UPDATE tenant_institution_links
            SET status = 'INACTIVE', updated_at = now()
          WHERE id = $1`,
        [link.id]
      )
      await tx.query(
        `UPDATE institution_member_assignment
            SET effective_to = now()
          WHERE tenant_institution_link_id = $1 AND effective_to IS NULL`,
        [link.id]
      )
      await tx.query(
        `UPDATE split_rules
            SET active = FALSE, effective_to = now()
          WHERE tenant_id = $1 AND institution_id = $2 AND active`,
        [tenantId, link.institution_id]
      )
      await writeInstitutionAudit(
        tx, link.institution_id, link.id, 'INSTITUTION_LINK_DEACTIVATED',
        req.user.id, { reason: 'tenant-requested' }
      )
      return { deactivated: true }
    })

    if (result.notFound) return res.status(404).json({ message: 'Institution link not found for this business.' })
    if (result.alreadyInactive) return res.status(409).json({ message: 'Institution link is already inactive.' })
    if (result.outstanding) return res.status(409).json({ message: 'Resolve pending, partially settled, or accrued institution payouts before deactivating this link.' })
    res.json({ status: 'INACTIVE' })
  })
)
