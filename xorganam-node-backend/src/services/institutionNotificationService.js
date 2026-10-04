import { query } from '../db/pool.js'
import { sendInstitutionSms } from './notificationService.js'

export const institutionNotificationEvents = Object.freeze([
  'CONTRIBUTION_REMINDER', 'REPAYMENT_DUE', 'REPAYMENT_OVERDUE',
  'SAVINGS_MATURITY', 'VERIFICATION_APPROVED', 'VERIFICATION_REJECTED', 'DISPUTE_UPDATE'
])

function renderTemplate(template, values) {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, key) => String(values[key] ?? ''))
}

export async function dispatchInstitutionNotification({ institutionId, customerId, event, values = {}, sentByStaffId = null, dedupeKey = null }) {
  const { rows } = await query(
    `SELECT c.first_name, c.last_name, c.phone_number, c.notification_consent,
            s.enabled, s.template_text
       FROM institution_customers c
       JOIN institution_notification_settings s ON s.institution_id = c.institution_id AND s.event = $3
      WHERE c.id = $1 AND c.institution_id = $2 AND c.is_active`,
    [customerId, institutionId, event]
  )
  const customer = rows[0]
  if (!customer) return { sent: false, reason: 'customer-or-template-not-found' }
  if (!customer.enabled) return { sent: false, reason: 'notification-disabled' }
  if (!customer.notification_consent) return { sent: false, reason: 'customer-has-not-consented' }

  const message = renderTemplate(customer.template_text, {
    customerName: `${customer.first_name} ${customer.last_name}`.trim(), ...values
  }).trim()
  if (!message || message.length > 500) return { sent: false, reason: 'rendered-message-invalid' }

  const { rows: inserted } = await query(
    `INSERT INTO institution_notification_log
      (institution_id, customer_id, event, delivery_status, sent_by_user_id, dedupe_key)
     VALUES ($1,$2,$3,'PENDING',$4,$5)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [institutionId, customerId, event, sentByStaffId, dedupeKey]
  )
  if (!inserted.length) return { sent: false, reason: 'already-processed' }

  const sent = await sendInstitutionSms(institutionId, customer.phone_number, message)
  await query(
    `UPDATE institution_notification_log SET delivery_status = $2,
        sent_at = CASE WHEN $2 = 'SENT' THEN now() ELSE NULL END,
        failure_reason = CASE WHEN $2 = 'FAILED' THEN 'SMS gateway did not accept the message.' ELSE NULL END
      WHERE id = $1`, [inserted[0].id, sent ? 'SENT' : 'FAILED']
  )
  return { sent, logId: inserted[0].id }
}
