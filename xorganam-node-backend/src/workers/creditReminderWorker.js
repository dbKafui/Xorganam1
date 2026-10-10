import { Queue, Worker } from 'bullmq'
import { getRedisConnection, CREDIT_REMINDER_QUEUE, enqueueCreditReminder } from '../queue/queue.js'
import { query, withTransaction } from '../db/pool.js'
import { sendMerchantSms } from '../services/notificationService.js'
import { issueInstallmentToken, installmentPaymentUrl } from '../services/creditInstallmentToken.js'
import { recordCreditWebhookEvent } from '../services/creditWebhookOutbox.js'
import { CREDIT_PLAN_PAYMENT_STATUSES, updateCreditInstallmentStatus, updateCreditPlanStatus } from '../services/creditStateService.js'
import { normalizeAmountMinorUnits, formatMinorUnits } from '../services/providerResultValidation.js'

const connection = getRedisConnection()
const producerQueue = new Queue(CREDIT_REMINDER_QUEUE, { connection })
const preDueDays = Math.max(1, Math.min(30, Number.parseInt(process.env.CREDIT_PRE_DUE_REMINDER_DAYS || '3', 10) || 3))

async function scanCreditInstallments() {
  const { rows } = await query(
    `SELECT i.id AS installment_id,
            CURRENT_DATE::text AS reminder_date,
            CASE WHEN i.status = 'PENDING' AND i.due_date = CURRENT_DATE + $1::int THEN 'PRE_DUE'
                 WHEN i.status = 'PENDING' AND i.due_date = CURRENT_DATE THEN 'DUE_TODAY'
                 ELSE 'OVERDUE' END AS reminder_type
       FROM credit_plan_installments i JOIN credit_plans p ON p.id = i.credit_plan_id
      WHERE p.status = ANY($2::credit_plan_status[]) AND (
        (i.status = 'PENDING' AND i.due_date IN (CURRENT_DATE, CURRENT_DATE + $1::int)) OR
        (i.status = 'PENDING' AND i.due_date + p.late_fee_grace_days < CURRENT_DATE)
      ) ORDER BY i.due_date LIMIT 5000`, [preDueDays, CREDIT_PLAN_PAYMENT_STATUSES]
  )
  for (const row of rows) {
    if (row.reminder_type === 'OVERDUE') {
      await enqueueCreditReminder({ type: 'OVERDUE', installmentId: row.installment_id })
    } else {
      const alreadySent = await query(
        `SELECT 1 FROM credit_reminder_delivery
          WHERE credit_plan_installment_id = $1 AND reminder_type = $2
            AND reminder_date = CURRENT_DATE AND sent_at IS NOT NULL`, [row.installment_id, row.reminder_type]
      )
      if (!alreadySent.rows.length) await enqueueCreditReminder({ type: row.reminder_type, installmentId: row.installment_id, reminderDate: row.reminder_date })
    }
  }
  return { queued: rows.length }
}

async function processOverdue(installmentId) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT p.id AS plan_id, p.tenant_id, p.merchant_id, p.status AS plan_status,
              p.late_fee_amount, p.late_fee_grace_days, p.missed_installment_threshold,
              i.id AS installment_id, i.installment_number, i.amount_due, i.due_date::text AS due_date
         FROM credit_plans p JOIN credit_plan_installments i ON i.credit_plan_id = p.id
        WHERE i.id = $1 AND i.status = 'PENDING'
          AND p.status = ANY($2::credit_plan_status[])
          AND i.due_date + p.late_fee_grace_days < CURRENT_DATE
        FOR UPDATE OF p, i`, [installmentId, CREDIT_PLAN_PAYMENT_STATUSES]
    )
    const plan = rows[0]
    if (!plan) return { skipped: true }
    const amountDueCents = normalizeAmountMinorUnits(plan.amount_due)
    const lateFeeCents = normalizeAmountMinorUnits(plan.late_fee_amount)
    if (amountDueCents === null || lateFeeCents === null) throw new Error('Credit installment amount has unsupported precision.')
    const updatedAmountDue = formatMinorUnits(amountDueCents + lateFeeCents)
    await updateCreditInstallmentStatus(tx, {
      id: plan.installment_id,
      currentStatus: 'PENDING',
      nextStatus: 'OVERDUE',
      fields: { amount_due: updatedAmountDue }
    })
    const { rows: overdues } = await tx.query(
      `SELECT COUNT(*)::int AS count FROM credit_plan_installments
        WHERE credit_plan_id = $1 AND status = 'OVERDUE'`, [plan.plan_id]
    )
    const nextStatus = plan.plan_status === 'DEFAULTED' || overdues[0].count >= plan.missed_installment_threshold ? 'DEFAULTED' : 'OVERDUE'
    if (plan.plan_status !== nextStatus) {
      await updateCreditPlanStatus(tx, {
        id: plan.plan_id,
        currentStatus: plan.plan_status,
        nextStatus
      })
    }
    await recordCreditWebhookEvent(tx, {
      tenantId: plan.tenant_id, merchantId: plan.merchant_id,
      eventType: 'installment.overdue', eventKey: `installment.overdue:${plan.installment_id}`,
      payload: { planId: plan.plan_id, installmentId: plan.installment_id, installmentNumber: plan.installment_number,
        merchantId: plan.merchant_id, dueDate: plan.due_date, amountDue: updatedAmountDue,
        status: 'OVERDUE', planStatus: nextStatus }
    })
    return { overdue: true, planStatus: nextStatus }
  })
}

async function sendReminder({ installmentId, type, reminderDate }) {
  const { rows } = await query(
    `SELECT p.id AS plan_id, p.tenant_id, p.customer_identifier, p.late_fee_grace_days,
            i.installment_number, i.due_date::text AS due_date, i.amount_due, i.status,
            m.display_name AS merchant_name, n.sms_enabled
       FROM credit_plans p
       JOIN credit_plan_installments i ON i.credit_plan_id = p.id
       JOIN merchants m ON m.id = p.merchant_id AND m.tenant_id = p.tenant_id
       LEFT JOIN tenant_notification_settings n ON n.tenant_id = p.tenant_id
      WHERE i.id = $1 AND p.status = ANY($2::credit_plan_status[])`, [installmentId, CREDIT_PLAN_PAYMENT_STATUSES]
  )
  const installment = rows[0]
  if (!installment || installment.status !== 'PENDING') return { skipped: true }
  if (!installment.sms_enabled) return { skipped: true, reason: 'tenant-sms-disabled' }
  const { rows: deliveries } = await query(
    `INSERT INTO credit_reminder_delivery (credit_plan_installment_id, reminder_type, reminder_date)
     VALUES ($1, $2, $3::date)
     ON CONFLICT (credit_plan_installment_id, reminder_type, reminder_date) DO UPDATE SET reminder_date = EXCLUDED.reminder_date
     RETURNING id, sent_at`, [installmentId, type, reminderDate]
  )
  if (deliveries[0].sent_at) return { skipped: true, reason: 'already-sent' }
  const dueDate = new Date(`${installment.due_date}T00:00:00.000Z`)
  dueDate.setUTCDate(dueDate.getUTCDate() + installment.late_fee_grace_days + 30)
  const token = issueInstallmentToken({ planId: installment.plan_id, installmentId, expiresAt: new Date(Math.max(dueDate.getTime(), Date.now() + 30 * 86400000)) })
  const url = installmentPaymentUrl(token)
  const text = type === 'PRE_DUE'
    ? `Reminder: GHS ${formatMinorUnits(normalizeAmountMinorUnits(installment.amount_due))} is due ${installment.due_date} to ${installment.merchant_name}. Pay securely: ${url}`
    : `GHS ${formatMinorUnits(normalizeAmountMinorUnits(installment.amount_due))} is due today to ${installment.merchant_name}. Pay securely: ${url}`
  const sent = await sendMerchantSms(installment.tenant_id, installment.customer_identifier, text)
  if (!sent) throw new Error('Credit installment reminder SMS was not accepted by the gateway.')
  await query(`UPDATE credit_reminder_delivery SET sent_at = now() WHERE id = $1`, [deliveries[0].id])
  return { sent: true }
}

producerQueue.add('scan-credit-installments', {}, {
  repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'credit-installment-daily-scan'
}).catch((error) => console.error('[credit-reminders] producer scheduling failed', { code: error?.code || 'WORKER_ERROR' }))
producerQueue.add('scan-credit-installments', {}, {
  jobId: `credit-installment-initial-scan-${Date.now()}`
}).catch((error) => console.error('[credit-reminders] initial scan scheduling failed', { code: error?.code || 'WORKER_ERROR' }))

export const creditReminderWorker = new Worker(CREDIT_REMINDER_QUEUE, async (job) => {
  if (job.name === 'scan-credit-installments') return scanCreditInstallments()
  if (job.name === 'mark-installment-overdue') return processOverdue(job.data.installmentId)
  if (job.name === 'send-installment-reminder') return sendReminder(job.data)
  throw new Error(`Unknown credit reminder job: ${job.name}`)
}, { connection, concurrency: 5 })

creditReminderWorker.on('failed', (_job, error) => console.error('[credit-reminders] job failed', { code: error?.code || 'WORKER_ERROR' }))
creditReminderWorker.on('error', (error) => console.error('[credit-reminders] worker error', { code: error?.code || 'WORKER_ERROR' }))
