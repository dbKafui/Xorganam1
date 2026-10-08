import { query } from '../db/pool.js'
import { isFinalWorkerAttempt } from './operationalFailurePolicy.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_CODE_PATTERN = /^[A-Z0-9_-]{1,64}$/

function safeId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
}

function safeErrorCode(error) {
  const code = String(error?.code || 'WORKER_ERROR').toUpperCase()
  return SAFE_CODE_PATTERN.test(code) ? code : 'WORKER_ERROR'
}

export async function recordOperationalFailure({ queueName, job, error }) {
  if (!queueName || !job?.id || !isFinalWorkerAttempt(job)) return null
  const data = job.data || {}
  const { rows } = await query(
    `INSERT INTO operational_failure_alerts
       (queue_name, job_id, job_name, tenant_id, merchant_id, transaction_id, attempts_made, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (queue_name, job_id) DO UPDATE
       SET job_name = EXCLUDED.job_name,
           tenant_id = EXCLUDED.tenant_id,
           merchant_id = EXCLUDED.merchant_id,
           transaction_id = EXCLUDED.transaction_id,
           attempts_made = EXCLUDED.attempts_made,
           error_code = EXCLUDED.error_code,
           status = 'OPEN', resolution_note = NULL,
           resolved_by_user_id = NULL, resolved_at = NULL, updated_at = now()
     RETURNING id, status`,
    [
      String(queueName).slice(0, 100),
      String(job.id).slice(0, 200),
      String(job.name || '').slice(0, 200),
      safeId(data.tenantId),
      safeId(data.merchantId),
      safeId(data.transactionId),
      Math.max(0, Number(job.attemptsMade || 0)),
      safeErrorCode(error)
    ]
  )
  return rows[0] || null
}