import { Queue, Worker } from 'bullmq'
import { getRedisConnection } from '../queue/queue.js'
import { query } from '../db/pool.js'
import { dispatchInstitutionNotification } from '../services/institutionNotificationService.js'

const QUEUE = 'institution-notifications'
const connection = getRedisConnection()
const scheduler = new Queue(QUEUE, { connection })

async function dueNotifications() {
  await query(
    `UPDATE institution_loan_installments i SET status = 'OVERDUE', updated_at = now()
      FROM institution_financial_accounts a, institution_financial_products p
     WHERE a.id = i.account_id AND a.institution_id = i.institution_id
       AND p.id = a.product_id AND p.institution_id = a.institution_id
       AND p.product_type = 'LOAN' AND i.status IN ('DUE', 'PARTIALLY_PAID')
       AND i.amount_paid_cents < i.amount_due_cents
       AND i.due_date + p.grace_period_days < CURRENT_DATE`
  )
  await query(
    `UPDATE institution_financial_accounts a SET status = 'OVERDUE', updated_at = now()
      WHERE a.status = 'ACTIVE' AND EXISTS (
        SELECT 1 FROM institution_loan_installments i
        JOIN institution_financial_products p ON p.id = a.product_id
        WHERE i.account_id = a.id AND i.status <> 'PAID' AND i.amount_paid_cents < i.amount_due_cents
          AND i.due_date + p.grace_period_days < CURRENT_DATE
      )`
  )
  const { rows: late } = await query(
    `SELECT i.id, i.institution_id, i.account_id,
            round((i.amount_due_cents - i.amount_paid_cents) * p.late_fee_basis_points / 10000.0)::bigint AS fee_cents
       FROM institution_loan_installments i
       JOIN institution_financial_accounts a ON a.id = i.account_id AND a.institution_id = i.institution_id
       JOIN institution_financial_products p ON p.id = a.product_id
      WHERE i.status <> 'PAID' AND i.late_fee_applied_at IS NULL AND p.late_fee_basis_points > 0
        AND i.due_date + p.grace_period_days < CURRENT_DATE AND i.amount_paid_cents < i.amount_due_cents
      ORDER BY i.due_date LIMIT 3000`
  )
  for (const installment of late) {
    await query(
      `WITH charged AS (
         UPDATE institution_loan_installments SET status = 'OVERDUE',
                amount_due_cents = amount_due_cents + $2, late_fee_applied_at = now(), updated_at = now()
          WHERE id = $1 AND late_fee_applied_at IS NULL AND status <> 'PAID'
          RETURNING institution_id, account_id
       )
       UPDATE institution_financial_accounts a SET outstanding_cents = a.outstanding_cents + $2, updated_at = now()
         FROM charged c WHERE a.institution_id = c.institution_id AND a.id = c.account_id`,
      [installment.id, installment.fee_cents]
    )
  }

  const { rows: installments } = await query(
    `SELECT CURRENT_DATE::text AS scan_date, i.institution_id, a.customer_id, i.id AS installment_id, i.installment_number,
            i.amount_due_cents - i.amount_paid_cents AS amount_cents, i.due_date::text AS due_date,
            c.first_name, c.last_name, p.name AS product_name,
            CASE WHEN i.due_date + p.grace_period_days < CURRENT_DATE THEN 'REPAYMENT_OVERDUE' ELSE 'REPAYMENT_DUE' END AS event
       FROM institution_loan_installments i
       JOIN institution_financial_accounts a ON a.id = i.account_id AND a.institution_id = i.institution_id
       JOIN institution_customers c ON c.id = a.customer_id
       JOIN institution_financial_products p ON p.id = a.product_id
       JOIN institution_notification_settings s ON s.institution_id = i.institution_id
        AND s.event = CASE WHEN i.due_date + p.grace_period_days < CURRENT_DATE THEN 'REPAYMENT_OVERDUE'::institution_notification_event ELSE 'REPAYMENT_DUE'::institution_notification_event END
        AND s.enabled
      WHERE i.status <> 'PAID' AND i.amount_paid_cents < i.amount_due_cents
        AND i.due_date <= CURRENT_DATE AND c.notification_consent AND c.is_active
      ORDER BY i.due_date LIMIT 3000`
  )
  for (const item of installments) await dispatchInstitutionNotification({
    institutionId: item.institution_id, customerId: item.customer_id, event: item.event,
    values: { amount: (Number(item.amount_cents) / 100).toFixed(2), dueDate: item.due_date, productName: item.product_name },
    dedupeKey: `${item.event}:${item.installment_id}:${item.scan_date}`
  })

  const { rows: maturities } = await query(
    `SELECT CURRENT_DATE::text AS scan_date, a.institution_id, a.customer_id, a.id AS account_id, a.balance_cents,
            a.maturity_date::text AS due_date, p.name AS product_name
       FROM institution_financial_accounts a
       JOIN institution_financial_products p ON p.id = a.product_id
       JOIN institution_customers c ON c.id = a.customer_id
       JOIN institution_notification_settings s ON s.institution_id = a.institution_id
        AND s.event = 'SAVINGS_MATURITY' AND s.enabled
      WHERE p.product_type = 'SAVINGS' AND a.status = 'ACTIVE' AND a.maturity_date = CURRENT_DATE
        AND a.balance_cents > 0 AND c.notification_consent AND c.is_active LIMIT 3000`
  )
  for (const item of maturities) await dispatchInstitutionNotification({
    institutionId: item.institution_id, customerId: item.customer_id, event: 'SAVINGS_MATURITY',
    values: { amount: (Number(item.balance_cents) / 100).toFixed(2), dueDate: item.due_date, productName: item.product_name },
    dedupeKey: `SAVINGS_MATURITY:${item.account_id}:${item.scan_date}`
  })

  const { rows: savings } = await query(
    `SELECT CURRENT_DATE::text AS scan_date, a.institution_id, a.customer_id, a.id AS account_id, a.balance_cents, a.created_at,
            p.name AS product_name, p.min_amount_cents, p.contribution_frequency,
            latest.last_contribution_at::date::text AS last_contribution_date
       FROM institution_financial_accounts a
       JOIN institution_financial_products p ON p.id = a.product_id
       JOIN institution_customers c ON c.id = a.customer_id
       JOIN institution_notification_settings s ON s.institution_id = a.institution_id
        AND s.event = 'CONTRIBUTION_REMINDER' AND s.enabled
       LEFT JOIN LATERAL (
         SELECT max(contributions.contributed_at) AS last_contribution_at FROM (
           SELECT t.created_at AS contributed_at FROM institution_financial_transactions t
            WHERE t.account_id = a.id AND t.transaction_type = 'DEPOSIT' AND t.status = 'POSTED'
           UNION ALL
           SELECT allocation.created_at AS contributed_at FROM institution_split_financial_allocations allocation
            WHERE allocation.account_id = a.id AND allocation.allocation_type = 'SAVINGS_CONTRIBUTION'
         ) contributions
       ) latest ON TRUE
      WHERE p.product_type = 'SAVINGS' AND a.status = 'ACTIVE' AND c.notification_consent AND c.is_active LIMIT 3000`
  )
  for (const item of savings) {
    if (item.contribution_frequency === 'PER_TRANSACTION') continue
    const reference = item.last_contribution_date || new Date(item.created_at).toISOString().slice(0, 10)
    const last = new Date(`${reference}T00:00:00.000Z`)
    const cutoff = new Date(`${item.scan_date}T00:00:00.000Z`)
    if (item.contribution_frequency === 'DAILY') cutoff.setUTCDate(cutoff.getUTCDate() - 1)
    else if (item.contribution_frequency === 'WEEKLY') cutoff.setUTCDate(cutoff.getUTCDate() - 7)
    else if (last.getUTCFullYear() === cutoff.getUTCFullYear() && last.getUTCMonth() === cutoff.getUTCMonth()) continue
    if (item.contribution_frequency !== 'MONTHLY' && last.getTime() > cutoff.getTime()) continue
    await dispatchInstitutionNotification({
      institutionId: item.institution_id, customerId: item.customer_id, event: 'CONTRIBUTION_REMINDER',
      values: { amount: (Number(item.min_amount_cents) / 100).toFixed(2), productName: item.product_name },
      dedupeKey: `CONTRIBUTION_REMINDER:${item.account_id}:${item.scan_date}`
    })
  }
  return { repayments: installments.length, maturities: maturities.length, savings: savings.length }
}

scheduler.add('scan-institution-notifications', {}, {
  repeat: { every: 60 * 60 * 1000 }, jobId: 'institution-notifications-hourly'
}).catch((error) => console.error('[institution-notifications] schedule failed', { code: error?.code || 'WORKER_ERROR' }))
scheduler.add('scan-institution-notifications', {}, {
  jobId: `institution-notifications-initial-${Date.now()}`
}).catch((error) => console.error('[institution-notifications] initial schedule failed', { code: error?.code || 'WORKER_ERROR' }))

export const institutionNotificationWorker = new Worker(QUEUE, async (job) => {
  if (job.name === 'scan-institution-notifications') return dueNotifications()
  return { skipped: true }
}, { connection, concurrency: 1 })

institutionNotificationWorker.on('error', (error) => console.error('[institution-notifications] worker error', { code: error?.code || 'WORKER_ERROR' }))
