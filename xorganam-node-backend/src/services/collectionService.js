import crypto from 'node:crypto'
import { query } from '../db/pool.js'
import { createEganowClientForTenant, EganowApiError, normalizePaypartnerCode, normalizeEganowResponse } from './eganowClient.js'
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
  const strippedLeadingZero = digits.replace(/^0+/, '')
  if (strippedLeadingZero.length === 9) {
    return `233${strippedLeadingZero}`
  }
  if (digits.startsWith('2330') && digits.length === 13) {
    return `233${digits.slice(4)}`
  }
  if (digits.startsWith('233') && digits.length === 12) {
    return digits
  }
  if (digits.length === 9) {
    return `233${digits}`
  }
  return digits
}

function inferPaypartnerCodeFromMsisdn(msisdn) {
  if (!msisdn) return null
  const digits = String(msisdn).replace(/\D/g, '')
  if (digits.startsWith('23324') || digits.startsWith('23354') || digits.startsWith('23355') || digits.startsWith('23359') || digits.startsWith('23325')) {
    return 'MTNGH'
  }
  if (digits.startsWith('23320') || digits.startsWith('23350')) {
    return 'TCELGH'
  }
  if (digits.startsWith('23326') || digits.startsWith('23327') || digits.startsWith('23356') || digits.startsWith('23357')) {
    return 'ATGH'
  }
  return null
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
            m.eganow_payout_account_id, m.network_provider,
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
 * @param {{ amount: number, msisdn: string, network?: string, narration?: string, payoutMsisdn?: string }} input
 * @returns {Promise<{ transactionId: string, internalReference: string, status: string, tenantId: string }>}
 */
export async function initiateCollection(merchantId, { amount, msisdn, network, narration, payoutMsisdn = null, callback = null }) {
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

  // Load tenant-scoped config before inserting the transaction. The Eganow
  // client will use the tenant DB base URL first, then its developer fallback.
  let tenantCtx
  try {
    tenantCtx = await getTenantEganowContext(merchant.tenant_id)
  } catch (err) {
    if (err instanceof TenantCredentialsError) {
      throw new CollectionRejectedError(`Eganow configuration error: ${err.message}`)
    }
    throw err
  }

  const internalReference = `COL-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
  const normalizedMsisdn = normalizeMsisdn(msisdn)
  const normalizedPayoutMsisdn = payoutMsisdn ? normalizeMsisdn(payoutMsisdn) : null
  if (normalizedPayoutMsisdn && !/^233[0-9]{9}$/.test(normalizedPayoutMsisdn)) {
    throw new CollectionRejectedError('A valid payout phone number is required in local or international format.')
  }

  const { rows } = await query(
    `INSERT INTO transactions
       (tenant_id, merchant_id, type, status, amount, currency, internal_reference, collection_msisdn, kyc_msisdn, payment_gateway_status, payout_msisdn, notification_sent)
     VALUES ($1, $2, 'COLLECTION', 'PENDING', $3, 'GHS', $4, $5, $6, 'INITIATED', $7, FALSE)
     RETURNING id`,
    [merchant.tenant_id, merchant.id, amount, internalReference, normalizedMsisdn, normalizedMsisdn, normalizedPayoutMsisdn]
  )
  const transactionId = rows[0].id

  try {
    let paypartnerCode
    const inferredPaypartnerCode = inferPaypartnerCodeFromMsisdn(normalizedMsisdn)

    if (inferredPaypartnerCode) {
      if (network) {
        const explicitPaypartnerCode = normalizePaypartnerCode(network)
        if (explicitPaypartnerCode && explicitPaypartnerCode !== inferredPaypartnerCode) {
          console.log('[collection] explicit network differs from MSISDN paypartner; using inferred paypartner', {
            tenantId: merchant.tenant_id,
            merchantId: merchant.id,
            explicitNetwork: network,
            explicitPaypartnerCode,
            inferredPaypartnerCode,
            msisdn: maskMsisdn(normalizedMsisdn)
          })
        }
      }
      const merchantPaypartnerCode = normalizePaypartnerCode(merchant.network_provider)
      if (merchantPaypartnerCode && merchantPaypartnerCode !== inferredPaypartnerCode) {
        console.log('[collection] merchant network provider differs from MSISDN paypartner; using inferred paypartner', {
          tenantId: merchant.tenant_id,
          merchantId: merchant.id,
          merchantNetworkProvider: merchant.network_provider,
          merchantPaypartnerCode,
          inferredPaypartnerCode,
          msisdn: maskMsisdn(normalizedMsisdn)
        })
      }
      paypartnerCode = inferredPaypartnerCode
    } else if (network) {
      paypartnerCode = normalizePaypartnerCode(network)
    } else {
      paypartnerCode = normalizePaypartnerCode(merchant.network_provider)
    }

    if (!paypartnerCode) {
      throw new CollectionRejectedError('Payment network is not configured for this merchant. Contact support.')
    }

    // Callback URL priority: explicit callback > tenant config
    // Do not fall back to any environment-level value — tenant must provide the callback.
    let callbackUrl = callback || (tenantCtx.callbackUrl || null)
    if (!callbackUrl) {
      throw new TenantCredentialsError('Tenant Eganow callback URL is not configured.', merchant.tenant_id)
    }

    if (String(callbackUrl).includes('localhost') || String(callbackUrl).includes('127.0.0.1') || String(callbackUrl).includes('::1')) {
      console.warn('[collection] callback URL is local and may not be reachable by Eganow:', { tenantId: merchant.tenant_id, callbackUrl })
    }

    if (!normalizedMsisdn || !/^233[0-9]{9}$/.test(normalizedMsisdn)) {
      throw new CollectionRejectedError('A valid phone number is required in local or international format (e.g., 0244123456 or 233244123456).')
    }

    const { client } = await createEganowClientForTenant(merchant.tenant_id)

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
      mobileNumber: normalizedMsisdn,
      accountNoOrCardNoOrMSISDN: normalizedMsisdn,
      languageId: 'en',
      countryCode
    }

    console.log('[collection] kyc.request', {
      tenantId: merchant.tenant_id,
      merchantId: merchant.id,
      paypartnerCode,
      mobileNumber: maskMsisdn(normalizedMsisdn),
      kycEndpoint: `${client.defaults.baseURL}/api/vas/kyc`,
      requestBody: {
        paypartnerCode,
        mobileNumber: maskMsisdn(normalizedMsisdn),
        accountNoOrCardNoOrMSISDN: maskMsisdn(normalizedMsisdn),
        languageId: 'en',
        countryCode
      }
    })

    let kycResponse
    try {
      kycResponse = await client.post('/api/vas/kyc', kycBody)
      console.log('[collection] kyc.response.data', kycResponse.data)
    } catch (kycErr) {
      console.error('[collection] kyc call failed', { tenantId: merchant.tenant_id, merchantId: merchant.id, err: kycErr.message })
      await query(
        `UPDATE transactions
            SET status = 'FAILED',
                payment_gateway_status = 'KYC_FAILED',
                failure_reason = $2,
                updated_at = now(),
                completed_at = now()
          WHERE id = $1`,
        [transactionId, `KYC lookup failed: ${kycErr.message}`]
      )

      return { transactionId, internalReference, status: 'FAILED', paymentGatewayStatus: 'KYC_FAILED', failureReason: `KYC lookup failed: ${kycErr.message}`, tenantId: merchant.tenant_id }
    }

    // Inspect KYC response for definitive status. If the provider returns
    // an explicit non-SUCCESSFUL status, abort. However some Eganow
    // deployments return an unstructured string like "Failed. Please
    // try again later." — treat those as non-fatal (log and continue),
    // so we still attempt the collection and rely on webhook/status
    // polling to reconcile the final outcome.
    const kycStatus = kycResponse?.data?.transactionStatus || kycResponse?.data?.status
    const kycStatusStr = String(kycStatus || '').toLowerCase().trim()
    const kycExplicitFailure = 
      kycStatusStr === 'failed' || 
      kycStatusStr === 'declined' ||
      kycStatusStr === 'rejected' ||
      (kycResponse?.data?.isSuccess === false)
    
    if (kycExplicitFailure) {
      const raw = typeof kycResponse.data === 'string' ? kycResponse.data : JSON.stringify(kycResponse.data)
      const reason = `KYC failed: ${kycStatus || 'DECLINED'}`
      console.warn('[collection] kyc failed - aborting collection', { tenantId: merchant.tenant_id, merchantId: merchant.id, reason, raw })

      await query(
        `UPDATE transactions
            SET status = 'FAILED',
                payment_gateway_status = $3,
                failure_reason = $2,
                updated_at = now(),
                completed_at = now()
          WHERE id = $1`,
        [transactionId, reason, kycStatusStr || 'KYC_FAILED']
      )

      return { transactionId, internalReference, status: 'FAILED', paymentGatewayStatus: kycStatusStr || 'KYC_FAILED', failureReason: reason, tenantId: merchant.tenant_id }
    } else if (kycStatus && kycStatusStr !== 'successful' && kycStatusStr !== 'success') {
      console.warn('[collection] kyc returned non-success status but not explicit failure; proceeding with collection', { tenantId: merchant.tenant_id, merchantId: merchant.id, kycStatus })
      // continue to attempt collection
    } else if (!kycStatus && typeof kycResponse.data === 'string') {
      console.warn('[collection] kyc returned unstructured response; proceeding with collection', { tenantId: merchant.tenant_id, merchantId: merchant.id, raw: kycResponse.data })
      // continue to attempt collection
    }

    const body = {
      paypartnerCode,
      amount,
      accountNoOrCardNoOrMSISDN: normalizedMsisdn,
      countryCode,
      accountName: kycResponse?.data?.accountName || merchant.display_name,
      transactionId: internalReference,
      transCurrencyIso: 'GHS',
      languageId: 'en',
      callback: callbackUrl
    }
    
    // Include narration only if provided (avoid sending undefined/null)
    if (narration) {
      body.narration = narration
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

    const normalized = normalizeEganowResponse(response.data)

    console.log('[collection] response.data', response.data)
    console.log('[collection] response', {
      tenantId: merchant.tenant_id,
      merchantId: merchant.id,
      eganowStatus: normalized.status,
      reference: normalized.reference || internalReference,
      transactionId: normalized.transactionId || null
    })

    const eganowReference = normalized.reference || internalReference
    const eganowTransactionId = normalized.transactionId || null

    const gatewayStatus = normalized.status || 'UNKNOWN_RESPONSE'

    if (!normalized.status && !normalized.reference && !normalized.transactionId) {
      console.warn('[collection] unrecognized Eganow collection response; keeping transaction pending for status polling', {
        tenantId: merchant.tenant_id,
        merchantId: merchant.id,
        transactionId,
        internalReference,
        response: response.data
      })
    }

    await query(
      `UPDATE transactions
          SET eganow_reference = $2,
              eganow_transaction_id = $3,
              payment_gateway_status = $4,
              updated_at = now()
        WHERE id = $1`,
      [transactionId, eganowReference, eganowTransactionId, gatewayStatus]
    )

    await enqueueCollectionStatusPollJob({ tenantId: merchant.tenant_id, merchantId: merchant.id, transactionId })

    return {
      transactionId,
      internalReference,
      status: 'PENDING',
      paymentGatewayStatus: gatewayStatus,
      message: normalized.message || response.data?.message || 'Transaction initiated.',
      tenantId: merchant.tenant_id
    }
  } catch (err) {
    const message = err instanceof EganowApiError ? err.message : `Collection request failed: ${err.message}`
    console.error(`[collection] Eganow collection failed for tenant ${merchant.tenant_id}, merchant ${merchant.id}:`, err)

    await query(
      `UPDATE transactions
          SET status = 'FAILED',
              payment_gateway_status = 'REQUEST_FAILED',
              failure_reason = $2,
              updated_at = now(),
              completed_at = now()
        WHERE id = $1`,
      [transactionId, message]
    )

    return { transactionId, internalReference, status: 'FAILED', paymentGatewayStatus: 'REQUEST_FAILED', failureReason: message, tenantId: merchant.tenant_id }
  }
}
