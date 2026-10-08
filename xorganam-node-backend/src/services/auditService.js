import { query } from '../db/pool.js'

export function validateAuditActor(actorUserId, actorInstitutionStaffId) {
  const userActor = actorUserId !== null && actorUserId !== undefined
  const institutionActor = actorInstitutionStaffId !== null && actorInstitutionStaffId !== undefined
  if (userActor && institutionActor) {
    throw new Error('Platform audit permits at most one actor.')
  }
  return { userActor, institutionActor }
}

export async function writePlatformAudit({
  actorUserId = null,
  actorInstitutionStaffId = null,
  tenantId = null,
  merchantId = null,
  action,
  resourceType,
  resourceId = null,
  details = {},
  ipAddress = null,
  userAgent = null,
  requestId = null,
  client = null
}) {
  if (!action || !resourceType) {
    throw new Error('Platform audit requires action and resourceType.')
  }
  validateAuditActor(actorUserId, actorInstitutionStaffId)

  const runner = client || query
  const result = await runner(
    `INSERT INTO platform_audit_log
       (actor_user_id, actor_institution_staff_id, tenant_id, merchant_id, action,
        resource_type, resource_id, details, ip_address, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, created_at`,
    [
      actorUserId,
      actorInstitutionStaffId,
      tenantId,
      merchantId,
      action,
      resourceType,
      resourceId,
      JSON.stringify(details),
      ipAddress,
      userAgent,
      requestId
    ]
  )
  return result.rows[0]
}

export async function auditRequest(req, action, resourceType, resourceId, details = {}) {
  return writePlatformAudit({
    actorUserId: req.user?.id || null,
    actorInstitutionStaffId: req.institutionAuth?.id || null,
    tenantId: req.user?.tenantId || req.institutionAuth?.institutionId || null,
    merchantId: req.user?.merchantId || null,
    action,
    resourceType,
    resourceId,
    details,
    ipAddress: req.ip || null,
    userAgent: req.headers['user-agent'] || null,
    requestId: req.id || null
  })
}
