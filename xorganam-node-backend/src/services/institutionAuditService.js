import { query } from '../db/pool.js'

export async function writeInstitutionAudit(client, {
  institutionId,
  tenantInstitutionLinkId = null,
  actorStaffId = null,
  actorUserId = null,
  action,
  note = null
}) {
  if (!institutionId || !action) {
    throw new Error('Institution audit requires institutionId and action.')
  }
  if (actorStaffId !== null && actorUserId !== null) {
    throw new Error('Institution audit permits at most one actor.')
  }
  const { rows } = await client.query(
    `INSERT INTO institution_audit_log
       (institution_id, tenant_institution_link_id, actor_staff_id, actor_user_id, action, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [institutionId, tenantInstitutionLinkId, actorStaffId, actorUserId, action, note ? { ...note } : null]
  )
  return rows[0]
}

export async function auditInstitutionDecision({
  institutionId,
  actorStaffId = null,
  actorUserId = null,
  tenantInstitutionLinkId = null,
  transactionId = null,
  action,
  reason,
  fromStatus = null,
  toStatus = null
}) {
  return writeInstitutionAudit(query, {
    institutionId,
    tenantInstitutionLinkId,
    actorStaffId,
    actorUserId,
    action,
    note: {
      transactionId,
      action,
      reason,
      fromStatus,
      toStatus
    }
  })
}
