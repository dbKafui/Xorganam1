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
    console.error(`[sms] failed to notify ${toMsisdn} for tenant ${tenantId}:`, err.message)
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
    console.error(`[sms] failed to deliver customer verification message to ***${String(toMsisdn).slice(-4)}:`, err.message)
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
