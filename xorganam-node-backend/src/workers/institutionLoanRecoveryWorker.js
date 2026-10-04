import { Queue, Worker } from 'bullmq'
import { getRedisConnection, INSTITUTION_LOAN_RECOVERY_QUEUE } from '../queue/queue.js'
import { query, withTransaction } from '../db/pool.js'
import { initiateInstitutionCollection } from '../services/institutionEganowService.js'
import { reconcileInstitutionTransaction } from '../services/institutionFinancialLedger.js'

const connection = getRedisConnection()
const scheduler = new Queue(INSTITUTION_LOAN_RECOVERY_QUEUE, { connection })
const batchSize = 200

async function createRecoveryAttempt(installmentId) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT i.id AS installment_id, i.institution_id, i.account_id,
              i.amount_due_cents - i.amount_paid_cents AS amount_cents,
              a.customer_id, c.phone_number, a.status AS account_status,
              p.loan_recovery_max_attempts, p.loan_recovery_interval_minutes
         FROM institution_loan_installments i
         JOIN institution_financial_accounts a ON a.id = i.account_id AND a.institution_id = i.institution_id
         JOIN institution_financial_products p ON p.id = a.product_id AND p.institution_id = a.institution_id
         JOIN institution_customers c ON c.id = a.customer_id AND c.institution_id = a.institution_id
        WHERE i.id = $1 AND p.product_type = 'LOAN'
          AND i.status = 'OVERDUE' AND i.amount_paid_cents < i.amount_due_cents
          AND a.status = 'OVERDUE' AND p.loan_recovery_max_attempts > 0
        FOR UPDATE OF i, a`, [installmentId]
    )
    const installment = rows[0]
    if (!installment) return null

    const { rows: inFlight } = await tx.query(
      `SELECT 1 FROM institution_financial_transactions
        WHERE account_id = $1 AND transaction_type = 'LOAN_REPAYMENT'
          AND status IN ('PENDING_APPROVAL', 'PENDING_GATEWAY') LIMIT 1`, [installment.account_id]
    )
    if (inFlight.length) return null

    const { rows: prior } = await tx.query(
      `SELECT attempt.attempt_number, attempt.created_at, finance_tx.status
         FROM institution_loan_recovery_attempts attempt
         JOIN institution_financial_transactions finance_tx ON finance_tx.id = attempt.transaction_id
        WHERE attempt.installment_id = $1
        ORDER BY attempt.attempt_number DESC LIMIT 1`, [installmentId]
    )
    const previous = prior[0]
    if (previous?.status !== undefined && previous.status !== 'FAILED') return null
    if (previous && Date.now() - new Date(previous.created_at).getTime() < Number(installment.loan_recovery_interval_minutes) * 60_000) return null
    const attemptNumber = Number(previous?.attempt_number || 0) + 1
    if (attemptNumber > Number(installment.loan_recovery_max_attempts)) return null

    const reference = `ILR-${String(installmentId).replaceAll('-', '')}-${attemptNumber}`
    const { rows: transactions } = await tx.query(
      `INSERT INTO institution_financial_transactions
        (institution_id, account_id, transaction_type, status, amount_cents, external_reference,
         created_by_staff_id, created_by_tenant_user_id, created_by_system, payer_phone_number)
       VALUES ($1, $2, 'LOAN_REPAYMENT', 'PENDING_GATEWAY', $3, $4, NULL, NULL, TRUE, $5)
       ON CONFLICT (institution_id, external_reference) DO NOTHING
       RETURNING id`,
      [installment.institution_id, installment.account_id, Number(installment.amount_cents), reference, installment.phone_number]
    )
    if (!transactions.length) return null
    const { rows: attempts } = await tx.query(
      `INSERT INTO institution_loan_recovery_attempts
        (institution_id, installment_id, attempt_number, transaction_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [installment.institution_id, installmentId, attemptNumber, transactions[0].id]
    )
    return { ...installment, amount_cents: Number(installment.amount_cents), reference, transaction_id: transactions[0].id, attempt_id: attempts[0].id }
  })
}

async function startRecovery(installmentId) {
  const attempt = await createRecoveryAttempt(installmentId)
  if (!attempt) return { skipped: true }
  try {
    const result = await initiateInstitutionCollection(attempt.institution_id, {
      reference: attempt.reference,
      amount: attempt.amount_cents / 100,
      msisdn: attempt.phone_number,
      narration: `Overdue loan repayment ${attempt.reference}`
    })
    await reconcileInstitutionTransaction(attempt.institution_id, attempt.transaction_id, result)
    return { attempted: true, reference: attempt.reference, status: result.status || 'PENDING' }
  } catch (error) {
    const definitive = error.response?.status >= 400 && error.response?.status < 500
    if (definitive) {
      await reconcileInstitutionTransaction(attempt.institution_id, attempt.transaction_id, {
        status: 'FAILED', message: 'Eganow rejected the overdue repayment collection.'
      })
    } else {
      await query(
        `UPDATE institution_financial_transactions
            SET payment_gateway_status = 'UNKNOWN',
                failure_reason = 'Provider response is uncertain; reconcile before retrying.', updated_at = now()
          WHERE id = $1 AND status = 'PENDING_GATEWAY'`, [attempt.transaction_id]
      )
    }
    console.error('[institution-loan-recovery] collection initiation failed', { code: error?.code || 'GATEWAY_ERROR' })
    return { attempted: true, uncertain: !definitive }
  }
}

async function scanOverdueInstallments() {
  const { rows } = await query(
    `SELECT i.id
       FROM institution_loan_installments i
       JOIN institution_financial_accounts a ON a.id = i.account_id AND a.institution_id = i.institution_id
       JOIN institution_financial_products p ON p.id = a.product_id AND p.institution_id = a.institution_id
      WHERE p.product_type = 'LOAN' AND p.loan_recovery_max_attempts > 0
        AND i.status = 'OVERDUE' AND i.amount_paid_cents < i.amount_due_cents
        AND a.status = 'OVERDUE'
      ORDER BY i.due_date LIMIT $1`, [batchSize]
  )
  let attempted = 0
  for (const row of rows) {
    const result = await startRecovery(row.id)
    if (result.attempted) attempted += 1
  }
  return { scanned: rows.length, attempted }
}

scheduler.add('scan-overdue-institution-loans', {}, {
  repeat: { every: 15 * 60 * 1000 }, jobId: 'institution-loan-recovery-quarter-hourly'
}).catch((error) => console.error('[institution-loan-recovery] schedule failed', { code: error?.code || 'WORKER_ERROR' }))
scheduler.add('scan-overdue-institution-loans', {}, {
  jobId: `institution-loan-recovery-initial-${Date.now()}`
}).catch((error) => console.error('[institution-loan-recovery] initial schedule failed', { code: error?.code || 'WORKER_ERROR' }))

export const institutionLoanRecoveryWorker = new Worker(INSTITUTION_LOAN_RECOVERY_QUEUE, async (job) => {
  if (job.name === 'scan-overdue-institution-loans') return scanOverdueInstallments()
  return { skipped: true }
}, { connection, concurrency: 1 })

institutionLoanRecoveryWorker.on('error', (error) => console.error('[institution-loan-recovery] worker error', { code: error?.code || 'WORKER_ERROR' }))
