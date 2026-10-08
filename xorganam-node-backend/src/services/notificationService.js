import axios from 'axios'
import { env } from '../config/env.js'
import { query } from '../db/pool.js'

/**
 * Looks up a tenant's SMS sender ID preference (e.g. a custom sender ID
 * like 'TENANT_MOMO') and dispatches a message. Falls back to the
 * platform default sender ID if the tenant hasn't set one.
 *
 * This intentionally never throws on send failure - a failed SMS should
 * never fail the transaction it's notifying about. Callers get a boolean
 * back and decide whether to log/retry.
 */
export async function sendMerchantSms(tenantId, toMsisdn, message) {
  try {
    const { rows } = await query(
      `SELECT c.eganow_merchant_code AS sender_id_hint
         FROM tenant_eganow_credentials c
        WHERE c.tenant_id = $1`,
      [tenantId]
    )

    const senderId = (rows[0]?.sender_id_hint || env.sms.defaultSenderId).slice(0, 11)

    const client = axios.create({ baseURL: env.sms.gatewayBaseUrl, timeout: 15_000 })

    const response = await client.post('send', {
      senderId,
      to: toMsisdn,
      message
    })

    return response.status >= 200 && response.status < 300
  } catch (err) {
    console.error('[sms] delivery failed', { code: err?.code || 'GATEWAY_ERROR' })
    return false
  }
}

export async function sendPlatformSms(toMsisdn, message) {
  try {
    const client = axios.create({ baseURL: env.sms.gatewayBaseUrl, timeout: 15_000 })
    const response = await client.post('send', {
      senderId: env.sms.defaultSenderId.slice(0, 11),
      to: toMsisdn,
      message
    })
    return response.status >= 200 && response.status < 300
  } catch (err) {
    console.error('[sms] verification delivery failed', { code: err?.code || 'GATEWAY_ERROR' })
    return false
  }
}

export async function sendInstitutionSms(institutionId, toMsisdn, message) {
  try {
    const { rows } = await query('SELECT name FROM institutions WHERE id = $1 AND status = \'ACTIVE\'', [institutionId])
    if (!rows.length) return false
    const senderId = rows[0].name.replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 11) || env.sms.defaultSenderId.slice(0, 11)
    const client = axios.create({ baseURL: env.sms.gatewayBaseUrl, timeout: 15_000 })
    const response = await client.post('send', { senderId, to: toMsisdn, message })
    return response.status >= 200 && response.status < 300
  } catch (err) {
    console.error('[sms] institution delivery failed', { code: err?.code || 'GATEWAY_ERROR' })
    return false
  }
}

/**
 * Email is unavailable until an email provider is configured. Never log
 * message contents or report a delivery that did not happen.
 */
export async function sendMerchantEmail(tenantId, toEmail, subject, body) {
  void tenantId; void toEmail; void subject; void body
  console.warn('[email] delivery skipped: no email provider is configured')
  return false
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export async function sendPasswordResetEmail({ email, firstName, lastName, resetUrl }) {
  const apiKey = process.env.RESEND_API_KEY
  const fromEmail = process.env.RESEND_FROM_EMAIL
  if (!apiKey || !fromEmail) {
    console.warn('[password-reset] delivery skipped: Resend is not configured')
    return false
  }

  const safeFirstName = escapeHtml(firstName)
  const safeLastName = escapeHtml(lastName)
  const safeResetUrl = escapeHtml(resetUrl)
  const safeSubject = `Password reset request for ${safeFirstName} ${safeLastName}`.replace(/[\r\n]+/g, ' ')

  try {
    const response = await axios.post(
      'https://api.resend.com/emails',
      {
        from: fromEmail,
        to: [email],
        subject: safeSubject,
        html: `<p>Hello ${safeFirstName},</p><p>Use the secure link below to reset your password. This link expires in 30 minutes.</p><p><a href="${safeResetUrl}">Reset password</a></p>`
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15_000
      }
    )
    return response.status >= 200 && response.status < 300
  } catch (err) {
    console.error('[password-reset] delivery failed', { code: err?.code || 'EMAIL_GATEWAY_ERROR' })
    return false
  }
}
