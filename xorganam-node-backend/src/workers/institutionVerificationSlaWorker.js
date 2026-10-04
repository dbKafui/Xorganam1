import { withTransaction } from '../db/pool.js'

function positiveIntegerSetting(name, fallback) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return value
}

const INTERVAL_MS = positiveIntegerSetting('INSTITUTION_VERIFICATION_SLA_INTERVAL_MS', 15 * 60 * 1000)
const INITIAL_DELAY_MS = positiveIntegerSetting('INSTITUTION_VERIFICATION_SLA_INITIAL_DELAY_MS', 15000)

let timer = null
let running = false

export async function escalateOverdueInstitutionVerifications() {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `WITH overdue AS (
         SELECT a.id, a.institution_id, a.tenant_institution_link_id,
                a.field_officer_staff_id, h.supervisor_staff_id
           FROM institution_member_assignment a
           JOIN tenant_institution_links l
             ON l.id = a.tenant_institution_link_id
            AND l.tenant_id = a.tenant_id
            AND l.institution_id = a.institution_id
           JOIN institutions i ON i.id = a.institution_id AND i.status = 'ACTIVE'
           JOIN institution_staff_hierarchy h
             ON h.institution_id = a.institution_id
            AND h.field_officer_staff_id = a.field_officer_staff_id
            AND h.effective_to IS NULL
          WHERE a.effective_to IS NULL
            AND a.escalated_to_supervisor_id IS NULL
            AND l.verification_status IN ('PENDING', 'UNDER_REVIEW')
            AND l.verification_sla_started_at <= now() - make_interval(hours => i.verification_sla_hours)
          ORDER BY l.verification_sla_started_at, a.id
          LIMIT 100
          FOR UPDATE OF a SKIP LOCKED
       ),
       escalated AS (
         UPDATE institution_member_assignment a
            SET escalated_to_supervisor_id = overdue.supervisor_staff_id,
                escalated_at = now()
           FROM overdue
          WHERE a.id = overdue.id
          RETURNING a.institution_id, a.tenant_institution_link_id,
                    a.escalated_to_supervisor_id
       )
       INSERT INTO institution_audit_log
         (institution_id, tenant_institution_link_id, actor_staff_id, action, note)
       SELECT escalated.institution_id, escalated.tenant_institution_link_id, NULL,
              'VERIFICATION_ESCALATED',
              jsonb_build_object(
                'supervisorStaffId', escalated.escalated_to_supervisor_id,
                'reason', 'verification-sla-exceeded'
              )
         FROM escalated
       RETURNING tenant_institution_link_id, institution_id`,
      []
    )
    return { escalated: rows.length }
  })
}

export function startInstitutionVerificationSlaWorker() {
  if (timer) return timer

  const run = async () => {
    if (running) return
    running = true
    try {
      const result = await escalateOverdueInstitutionVerifications()
      if (result.escalated) {
        console.info('[institution-verification-sla] escalated overdue links', { count: result.escalated })
      }
    } catch (error) {
      console.error('[institution-verification-sla] escalation run failed', { code: error?.code || 'WORKER_ERROR' })
    } finally {
      running = false
    }
  }

  setTimeout(() => { void run() }, INITIAL_DELAY_MS)
  timer = setInterval(() => { void run() }, INTERVAL_MS)
  return timer
}
