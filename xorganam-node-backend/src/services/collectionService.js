import crypto from 'node:crypto'
import { query } from '../db/pool.js'
import { env } from '../config/env.js'
import { createEganowClientForTenant, EganowApiError, normalizePaypartnerCode } from './eganowClient.js'
import { getTenantEganowContext, TenantCredentialsError } from './credentialsService.js'
import { enqueueCollectionStatusPollJob } from '../queue/queue.js'

export class CollectionRejectedError extends Error {}

function maskMsisdn(msisdn) {
  if (!msisdn) return msisdn
  const digits = String(msisdn).replace(/\D/g, '')
  return digits.length <= 4 ? digits : `***${digits.slice(-4)}`
}

function normalizeMsisdn(rawMsisdn) {
  if (!rawMsisdn) return rawMsisdn
  const digits = String(rawMsisdn).trim().replace(/\D/g, '')
  if (digits.startsWith('0') && digits.length === 10) {
    return `233${digits.slice(1)}`
  }
  if (digits.startsWith('233') && digits.length === 12) {
    return digits
  }
  if (digits.startsWith('2330') && digits.length === 13) {
    return `233${digits.slice(4)}`
  }
  if (digits.length === 9) {
    return `233${digits}`
  }
  return digits
}

/**
 * Looks up a merchant by id with no tenant assumption - used by the
 * anonymous checkout flow, which only ever knows a merchantId (the
 * customer is paying a specific market woman, not "a business").
 * Also used by the authenticated path, which additionally checks the
 * resolved tenantId against the caller's own tenant.
 */
export async function findMerchantForCollection(merchantId) {
  const { rows } = await query(
    `SELECT m.id, m.tenant_id, m.display_name, m.is_active, m.eganow_collection_account_id,
            m.network_provider,
            t.status AS tenant_status,
            c.is_enabled AS eganow_enabled
       FROM merchants m
       JOIN tenants t ON t.id = m.tenant_id
       JOIN tenant_eganow_credentials c ON c.tenant_id = t.id
      WHERE m.id = $1`,
    [merchantId]
  )
  return rows[0] || null
}

/**
 * @param {string} merchantId
 * @param {{ amount: number, msisdn: string, network?: string, narration?: string, channel?: string }} input
 * @returns {Promise<{ transactionId: string, internalReference: string, status: string, tenantId: string }>}
 */
export async function initiateCollection(merchantId, { amount, msisdn, network, narration, channel = 'USSD', callback = null }) {
  const merchant = await findMerchantForCollection(merchantId)

  if (!merchant || !merchant.is_active) {
    throw new CollectionRejectedError('This merchant is not available to accept payments.')
  }
  if (merchant.tenant_status !== 'ACTIVE') {
    throw new CollectionRejectedError('This merchant is not currently able to accept payments.')
  }
  if (!merchant.eganow_enabled) {
    throw new CollectionRejectedError('Payments are not configured for this merchant yet.')
  }
  if (!amount || amount <= 0) {
    throw new CollectionRejectedError('Amount must be greater than zero.')
  }
  if (!msisdn) {
    throw new CollectionRejectedError('A mobile number is required.')
  }

  // Validate tenant credentials and base URL are configured
  try {
    const tenantCtx = await getTenantEganowContext(merchant.tenant_id)
    if (!tenantCtx.baseUrl) {
      throw new CollectionRejectedError('Eganow base URL is not configured for this merchant.')
    }
  } catch (err) {
    if (err instanceof TenantCredentialsError) {
      throw new CollectionRejectedError(`Eganow configuration error: ${err.message}`)
    }
    throw err
  }

  const internalReference = `COL-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`

  const { rows } = await query(
    `INSERT INTO transactions
       (tenant_id, merchant_id, type, status, amount, currency, internal_reference, notification_sent)
     VALUES ($1, $2, 'COLLECTION', 'RECEIVED', $3, 'GHS', $4, FALSE)
     RETURNING id`,
    [merchant.tenant_id, merchant.id, amount, internalReference]
  )
  const transactionId = rows[0].id

  try {
    const { client } = await createEganowClientForTenant(merchant.tenant_id)
    const paypartnerCode = normalizePaypartnerCode(network || merchant.network_provider)
    if (!paypartnerCode) {
      throw new CollectionRejectedError('Payment partner code is not configured for this merchant.')
    }

    const callbackUrl = callback || env.eganow.callbackUrl
    if (!callbackUrl) {
      throw new CollectionRejectedError('Eganow callback URL is not configured. Set EGANOW_CALLBACK_URL or pass a callback URL.')
    }

    const normalizedMsisdn = normalizeMsisdn(msisdn)
    if (!normalizedMsisdn || !/^233[0-9]{9}$/.test(normalizedMsisdn)) {
      throw new CollectionRejectedError('A valid phone number is required in local or international format.')
    }

    // Perform a KYC / name-enquiry lookup before attempting collection.
    // Some Eganow deployments require verification of MSISDN/account
    // before initiating a transaction — calling `/api/vas/kyc` first
    // helps surface those failures earlier and avoid opaque gateway
    // responses when the customer details are invalid.
    // Infer countryCode from MSISDN once and reuse for KYC + collection.
    const inferCountryCode = (msisdnStr) => {
      const digits = String(msisdnStr || '').replace(/[^0-9]/g, '')
      if (digits.startsWith('233')) return 'GH0233'
      if (digits.startsWith('255')) return 'TZ0255'
      if (digits.startsWith('256')) return 'UG0256'
      return 'GH0233'
    }

    const countryCode = inferCountryCode(normalizedMsisdn)

    const kycBody = {
      paypartnerCode,
      accountNoOrCardNoOrMSISDN: normalizedMsisdn,
      languageId: 'en',
      countryCode
    }

    console.log('[collection] kyc.request', {
      tenantId: merchant.tenant_id,
      merchantId: merchant.id,
      paypartnerCode,
      msisdn: maskMsisdn(normalizedMsisdn),
      kycEndpoint: `${client.defaults.baseURL}/api/vas/kyc`,
      requestBody: { paypartnerCode, accountNoOrCardNoOrMSISDN: maskMsisdn(normalizedMsisdn) }
    })

    let kycResponse
    try {
      kycResponse = await client.post('/api/vas/kyc', kycBody)
      console.log('[collection] kyc.response.data', kycResponse.data)
    } catch (kycErr) {
      console.error('[collection] kyc call failed', { tenantId: merchant.tenant_id, merchantId: merchant.id, err: kycErr.message })
      await query(
        `UPDATE transactions SET status = 'FAILED', failure_reason = $2, updated_at = now(), completed_at = now() WHERE id = $1`,
        [transactionId, `KYC lookup failed: ${kycErr.message}`]
      )

      return { transactionId, internalReference, status: 'FAILED', failureReason: `KYC lookup failed: ${kycErr.message}`, tenantId: merchant.tenant_id }
    }

    // Inspect KYC response for definitive status. If the provider returns
    // an explicit non-SUCCESSFUL status, abort. However some Eganow
    // deployments return an unstructured string like "Failed. Please
    // try again later." — treat those as non-fatal (log and continue),
    // so we still attempt the collection and rely on webhook/status
    // polling to reconcile the final outcome.
    const kycStatus = kycResponse && kycResponse.data && (kycResponse.data.transactionStatus || kycResponse.data.status)
    if (kycStatus && kycStatus !== 'SUCCESSFUL') {
      const raw = typeof kycResponse.data === 'string' ? kycResponse.data : JSON.stringify(kycResponse.data)
      const reason = `KYC not successful: ${kycStatus} - ${raw}`
      console.warn('[collection] kyc failed - aborting collection', { tenantId: merchant.tenant_id, merchantId: merchant.id, reason })

      await query(
        `UPDATE transactions SET status = 'FAILED', failure_reason = $2, updated_at = now(), completed_at = now() WHERE id = $1`,
        [transactionId, reason]
      )

      return { transactionId, internalReference, status: 'FAILED', failureReason: reason, tenantId: merchant.tenant_id }
    } else if (!kycStatus && typeof kycResponse.data === 'string') {
      console.warn('[collection] kyc returned unstructured response; proceeding with collection', { tenantId: merchant.tenant_id, merchantId: merchant.id, raw: kycResponse.data })
      // continue to attempt collection
    }

    const body = {
      paypartnerCode,
      amount,
      accountNoOrCardNoOrMSISDN: normalizedMsisdn,
      countryCode,
      accountName: merchant.display_name || 'Customer',
      transactionId: internalReference,
      narration,
      transCurrencyIso: 'GHS',
      expiryDateMonth: 0,
      expiryDateYear: 0,
      cvv: '',
      languageId: 'en',
      callback: callbackUrl
    }

    console.log('[collection] request', {
      tenantId: merchant.tenant_id,
      merchantId: merchant.id,
      paypartnerCode,
      amount,
      msisdn: maskMsisdn(normalizedMsisdn),
      callbackUrl,
      eganowEndpoint: `${client.defaults.baseURL}/api/transactions/collection`,
      requestBody: {
        paypartnerCode,
        amount,
        accountNoOrCardNoOrMSISDN: maskMsisdn(normalizedMsisdn),
        transactionId: internalReference,
        callback: callbackUrl
      }
    })

    const response = await client.post('/api/transactions/collection', body)

    console.log('[collection] response.data', response.data)
    console.log('[collection] response', {
      tenantId: merchant.tenant_id,
      merchantId: merchant.id,
      eganowStatus: response.data.transactionStatus || response.data.status || response.data.message,
      reference: response.data.eganowReferenceNo || response.data.reference || internalReference,
      transactionId: response.data.transactionId || null
    })

    await query(
      `UPDATE transactions SET eganow_reference = $2, eganow_transaction_id = $3, updated_at = now() WHERE id = $1`,
      [transactionId, response.data.eganowReferenceNo || response.data.reference || internalReference, response.data.transactionId || null]
    )

    await enqueueCollectionStatusPollJob({ tenantId: merchant.tenant_id, merchantId: merchant.id, transactionId })

    return { transactionId, internalReference, status: 'RECEIVED', tenantId: merchant.tenant_id }
  } catch (err) {
    const message = err instanceof EganowApiError ? err.message : `Collection request failed: ${err.message}`
    console.error(`[collection] Eganow collection failed for tenant ${merchant.tenant_id}, merchant ${merchant.id}:`, err)

    await query(
      `UPDATE transactions SET status = 'FAILED', failure_reason = $2, updated_at = now(), completed_at = now() WHERE id = $1`,
      [transactionId, message]
    )

    return { transactionId, internalReference, status: 'FAILED', failureReason: message, tenantId: merchant.tenant_id }
  }
}
