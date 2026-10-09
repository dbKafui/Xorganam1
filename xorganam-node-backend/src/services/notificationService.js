import axios from 'axios'
import { env } from '../config/env.js'
import { query } from '../db/pool.js'
import { resolveMerchantNotificationPreferences } from './notificationPolicy.js'

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

export async function sendMerchantEmail(toEmail, subject, body) {
  const apiKey = process.env.RESEND_API_KEY
  const fromEmail = process.env.RESEND_FROM_EMAIL
  if (!apiKey || !fromEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(toEmail || ''))) {
    if (!apiKey || !fromEmail) console.warn('[email] merchant delivery skipped: Resend is not configured')
    return false
  }
  const safeSubject = String(subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200)
  const safeBody = String(body || '').slice(0, 10000)
  if (!safeSubject || !safeBody) return false

  try {
    const response = await axios.post(
      'https://api.resend.com/emails',
      {
        from: fromEmail,
        to: [toEmail],
        subject: safeSubject,
        text: safeBody,
        html: `<p>${escapeHtml(safeBody).replaceAll('\n', '<br>')}</p>`
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15_000
      }
    )
    return response.status >= 200 && response.status < 300
  } catch (err) {
    console.error('[email] merchant delivery failed', { code: err?.code || 'EMAIL_GATEWAY_ERROR' })
    return false
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export async function notifyMerchant(tenantId, merchantId, { toMsisdn, message, subject }) {
  let preferences
  try {
    const { rows } = await query(
      `SELECT notify_sms, notify_email, contact_email
         FROM merchant_settings WHERE tenant_id = $1 AND merchant_id = $2`,
      [tenantId, merchantId]
    )
    preferences = resolveMerchantNotificationPreferences(rows[0])
  } catch (err) {
    console.error('[notification] merchant preferences unavailable', { code: err?.code || 'DB_ERROR' })
    return { smsDelivered: false, emailDelivered: false }
  }

  const [smsDelivered, emailDelivered] = await Promise.all([
    preferences.notifySms && toMsisdn && message
      ? sendMerchantSms(tenantId, toMsisdn, message)
      : false,
    preferences.notifyEmail && preferences.contactEmail && subject && message
      ? sendMerchantEmail(tenantId, preferences.contactEmail, subject, message)
      : false
  ])
  return { smsDelivered, emailDelivered }
}

export async function sendPasswordResetEmail({ email, firstName, resetUrl, purpose = 'reset' }) {
  const apiKey = process.env.RESEND_API_KEY
  const fromEmail = process.env.RESEND_FROM_EMAIL
  if (!apiKey || !fromEmail) {
    console.warn('[password-reset] delivery skipped: Resend is not configured')
    return false
  }

  const safeFirstName = escapeHtml(firstName)
  const safeResetUrl = escapeHtml(resetUrl)
  const setup = purpose === 'setup'
  const safeSubject = `${setup ? 'Set up your' : 'Password reset for your'} XORGANAM account`.replace(/[\r\n]+/g, ' ')
  const actionText = setup ? 'Set password' : 'Reset password'
  const instruction = setup
    ? 'Use the secure link below to set your account password. This link expires in 30 minutes.'
    : 'Use the secure link below to reset your password. This link expires in 30 minutes.'

  try {
    const response = await axios.post(
      'https://api.resend.com/emails',
      {
        from: fromEmail,
        to: [email],
        subject: safeSubject,
        html: `<p>Hello ${safeFirstName},</p><p>${instruction}</p><p><a href="${safeResetUrl}">${actionText}</a></p>`
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

export async function sendEmailVerificationEmail({ email, firstName, token }) {
  const apiKey = process.env.RESEND_API_KEY
  const fromEmail = process.env.RESEND_FROM_EMAIL
  if (!apiKey || !fromEmail) {
    console.warn('[email-verification] delivery skipped: Resend is not configured')
    return false
  }

  const safeFirstName = escapeHtml(firstName)
  try {
    const verificationUrl = new URL('/verify-email', process.env.APP_URL || 'http://localhost:5174')
    verificationUrl.searchParams.set('token', token)
    const safeVerificationUrl = escapeHtml(verificationUrl.toString())
    const response = await axios.post(
      'https://api.resend.com/emails',
      {
        from: fromEmail,
        to: [email],
        subject: 'Verify your XORGANAM email address',
        html: `<p>Hello ${safeFirstName},</p><p>Verify your email address to activate your operator account. This link expires in 30 minutes and can only be used once.</p><p><a href="${safeVerificationUrl}">Verify email address</a></p>`
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
    console.error('[email-verification] delivery failed', { code: err?.code || 'EMAIL_GATEWAY_ERROR' })
    return false
  }
}
