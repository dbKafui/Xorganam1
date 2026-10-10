import crypto from 'node:crypto'
import { env } from '../config/env.js'
import { query, withTransaction } from '../db/pool.js'
import { createEganowClientForMerchant, normalizeEganowResponse } from './eganowClient.js'
import { resolveInstitutionMomoNetwork } from './institutionPaymentMethods.js'
import { TenantCredentialsError } from './credentialsService.js'
import { enqueueCollectionStatusPollJob } from '../queue/queue.js'
import { computeFee } from './feeService.js'
import { createVendorReference } from './referenceIds.js'
import { updateTransactionStatus } from './transactionStateService.js'
import { normalizeAmountMinorUnits } from './providerResultValidation.js'

export class CollectionRejectedError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export function collectionFingerprint({ merchantId, amount, collectionMethod, network, narration, msisdn, payoutMsisdn, cardNumber, expiryDateMonth, expiryDateYear, creditPlanId, creditInstallmentId, orderId }) {
  const cardFingerprint = cardNumber
    ? crypto.createHmac('sha256', env.jwt.secret).update(JSON.stringify({
        number: String(cardNumber).replace(/[\s-]/g, ''),
        month: expiryDateMonth || null,
        year: expiryDateYear || null
      })).digest('hex')
    : null
  const payload = JSON.stringify({
    merchantId,
    amountCents: normalizeAmountMinorUnits(amount)?.toString() ?? 'invalid',
    currency: 'GHS',
    collectionMethod,
    network: network || null,
    narration: narration || null,
    msisdn: msisdn || null,
    payoutMsisdn: payoutMsisdn || null,
    cardFingerprint,
    creditPlanId: creditPlanId || null,
    creditInstallmentId: creditInstallmentId || null,
    orderId: orderId || null
  })
  return crypto.createHmac('sha256', env.jwt.secret).update(payload).digest('hex')
}

async function findExistingIdempotentCollection(client, merchantId, key, fingerprint) {
  if (!key) return null
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`collection:${merchantId}:${key}`])
  const { rows } = await client.query(
    `SELECT id, internal_reference, status, payment_gateway_status, failure_reason, idempotency_fingerprint
       FROM transactions WHERE merchant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
    [merchantId, key]
  )
  if (!rows.length) return null
  if (rows[0].idempotency_fingerprint !== fingerprint) {
    throw new CollectionRejectedError('This idempotency key was already used for a different payment request.', 409)
  }
  return rows[0]
}

export function isUncertainProviderOutcome(error) {
  const statusCode = Number(error?.response?.status)
  return !statusCode || statusCode === 429 || statusCode >= 500
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

function validCardNumber(value) {
  const digits = String(value || '').replace(/[\s-]/g, '')
  if (!/^\d{12,19}$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
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
    `SELECT m.id, m.tenant_id, m.display_name, m.is_active, m.account_setup_status, m.eganow_collection_account_id,
            m.eganow_payout_account_id, m.network_provider,
            t.status AS tenant_status,
            e.is_enabled AS eganow_enabled
       FROM merchants m
       JOIN tenants t ON t.id = m.tenant_id
       JOIN merchant_eganow_credentials e ON e.merchant_id = m.id
      WHERE m.id = $1`,
    [merchantId]
  )
  return rows[0] || null
}

/**
 * @param {string} merchantId
 * @param {{ amount: string|number, msisdn: string, network?: string, narration?: string, payoutMsisdn?: string }} input
 * @returns {Promise<{ transactionId: string, internalReference: string, status: string, tenantId: string }>}
 */
export async function initiateCollection(merchantId, { amount, msisdn, network, narration, collectionMethod = 'MOMO', cardNumber = null, cardholderName = null, expiryDateMonth = null, expiryDateYear = null, cvv = null, payoutMsisdn = null, callback = null, creditPlanId = null, creditInstallmentId = null, orderId = null, idempotencyKey = null }) {
  const merchant = await findMerchantForCollection(merchantId)

  if (!merchant || !merchant.is_active) {
    throw new CollectionRejectedError('This merchant is not available to accept payments.')
  }
  if (merchant.tenant_status !== 'ACTIVE') {
    throw new CollectionRejectedError('This merchant is not currently able to accept payments.')
  }
  if (merchant.account_setup_status && merchant.account_setup_status !== 'ACTIVE') {
    throw new CollectionRejectedError('Eganow account setup is pending for this merchant. Contact platform support before accepting payments.')
  }
  if (!merchant.eganow_collection_account_id || !merchant.eganow_payout_account_id) {
    throw new CollectionRejectedError('Eganow account setup is pending for this merchant. Contact platform support before accepting payments.')
  }
  if (!merchant.eganow_enabled) {
    throw new CollectionRejectedError('Payments are not configured for this merchant yet.')
  }
  const amountMinorUnits = normalizeAmountMinorUnits(amount)
  if (amountMinorUnits === null || amountMinorUnits <= 0n || amountMinorUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CollectionRejectedError('Amount must be a valid positive amount with at most two decimal places.')
  }
  const collectionFee = await computeFee(merchant.tenant_id, 'COLLECTION', amount)
  // Fees are recorded for reconciliation; Eganow applies any actual deduction.
  const gatewayAmount = Number(amountMinorUnits) / 100
  const normalizedCollectionMethod = String(collectionMethod || 'MOMO').toUpperCase()
  if (!['MOMO', 'CARD'].includes(normalizedCollectionMethod)) throw new CollectionRejectedError('Choose Mobile Money or Card collection.')
  if (normalizedCollectionMethod === 'MOMO' && !msisdn) throw new CollectionRejectedError('A mobile number is required.')
  if (normalizedCollectionMethod === 'CARD' && !validCardNumber(cardNumber)) throw new CollectionRejectedError('Enter a valid payment card number.')
  if (normalizedCollectionMethod === 'CARD' && (!String(cardholderName || '').trim() || !Number.isInteger(Number(expiryDateMonth)) || Number(expiryDateMonth) < 1 || Number(expiryDateMonth) > 12 || !/^\d{2}$/.test(String(expiryDateYear || '')) || !/^\d{3,4}$/.test(String(cvv || '')))) throw new CollectionRejectedError('Enter the cardholder name, expiry date, and valid CVV.')

  const internalReference = createVendorReference(merchant.display_name, 'COL')
  const normalizedMsisdn = msisdn ? normalizeMsisdn(msisdn) : null
  if ((normalizedCollectionMethod === 'MOMO' || normalizedMsisdn) && !/^233[0-9]{9}$/.test(normalizedMsisdn || '')) {
    throw new CollectionRejectedError('A valid Ghana mobile number is required.')
  }
  const normalizedPayoutMsisdn = payoutMsisdn ? normalizeMsisdn(payoutMsisdn) : null
  if (normalizedPayoutMsisdn && !/^233[0-9]{9}$/.test(normalizedPayoutMsisdn)) {
    throw new CollectionRejectedError('A valid payout phone number is required in local or international format.')
  }

  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw new CollectionRejectedError('Idempotency-Key must be 8 to 128 characters using letters, numbers, period, underscore, colon, or hyphen.')
  }
  const fingerprint = collectionFingerprint({
    merchantId: merchant.id,
    amount,
    collectionMethod: normalizedCollectionMethod,
    network,
    narration,
    msisdn: normalizedMsisdn,
    payoutMsisdn: normalizedPayoutMsisdn,
    cardNumber,
    expiryDateMonth,
    expiryDateYear,
    creditPlanId,
    creditInstallmentId,
    orderId
  })

  let transactionId
  let existingTransaction = null
  if (creditInstallmentId || creditPlanId || orderId) {
    transactionId = await withTransaction(async (client) => {
      existingTransaction = await findExistingIdempotentCollection(client, merchant.id, idempotencyKey, fingerprint)
      if (existingTransaction) return existingTransaction.id
      let validatedPlanId = null
      let validatedInstallmentId = null
      let validatedOrderId = null
      if (creditInstallmentId || (creditPlanId && !orderId)) {
        if (!creditInstallmentId || !creditPlanId || orderId) throw new CollectionRejectedError('Credit installment checkout requires a plan and installment without an order.')
      const { rows: installmentRows } = await client.query(
        `SELECT p.id AS plan_id, p.tenant_id, p.merchant_id, p.customer_identifier,
                p.status AS plan_status, i.id AS installment_id, i.status AS installment_status,
                i.amount_due
           FROM credit_plans p
           JOIN credit_plan_installments i ON i.credit_plan_id = p.id
          WHERE p.id = $1 AND i.id = $2 AND p.tenant_id = $3 AND p.merchant_id = $4
          FOR UPDATE OF p, i`,
        [creditPlanId, creditInstallmentId, merchant.tenant_id, merchant.id]
      )
      const installment = installmentRows[0]
      // DEFAULTED is a reporting state only; it does not block repayment.
      if (!installment || !['ACTIVE', 'OVERDUE', 'DEFAULTED'].includes(installment.plan_status) || !['PENDING', 'OVERDUE'].includes(installment.installment_status)) {
        throw new CollectionRejectedError('This installment is not available for payment.')
      }
      if (installment.customer_identifier !== normalizedMsisdn) {
        throw new CollectionRejectedError('The mobile number must match the number on this credit plan.')
      }
      if (amountMinorUnits !== normalizeAmountMinorUnits(installment.amount_due)) {
        throw new CollectionRejectedError('Installments must be paid in full.')
      }
      const { rows: activePayment } = await client.query(
        `SELECT id FROM transactions
          WHERE credit_installment_id = $1 AND type = 'COLLECTION' AND status <> 'FAILED'
          LIMIT 1`, [creditInstallmentId]
      )
      if (activePayment.length) throw new CollectionRejectedError('A payment for this installment is already in progress or complete.')
      validatedPlanId = creditPlanId
      validatedInstallmentId = creditInstallmentId
      } else if (creditPlanId) {
        const { rows } = await client.query(
          `SELECT p.id AS plan_id, p.tenant_id, p.merchant_id, p.status AS plan_status,
                  p.down_payment, o.status AS order_status, o.collection_transaction_id
             FROM credit_plans p JOIN orders o ON o.id = p.order_id
            WHERE p.id = $1 AND o.id = $2 AND p.tenant_id = $3 AND p.merchant_id = $4
            FOR UPDATE OF p, o`, [creditPlanId, orderId, merchant.tenant_id, merchant.id]
        )
        const plan = rows[0]
        if (!plan || plan.plan_status !== 'ACTIVE' || plan.order_status !== 'PENDING_PAYMENT' || (normalizeAmountMinorUnits(plan.down_payment) ?? 0n) <= 0n) {
          throw new CollectionRejectedError('The credit order down payment is not available.')
        }
        if (amountMinorUnits !== normalizeAmountMinorUnits(plan.down_payment)) {
          throw new CollectionRejectedError('The collection amount must match the order down payment.')
        }
        if (plan.collection_transaction_id) throw new CollectionRejectedError('A payment has already been started for this order.')
        validatedPlanId = creditPlanId
        validatedOrderId = orderId
      } else {
        const { rows } = await client.query(
          `SELECT o.id, o.tenant_id, o.merchant_id, o.status, o.collection_transaction_id,
                  COALESCE(SUM(oi.subtotal), 0) AS total_amount
             FROM orders o JOIN order_items oi ON oi.order_id = o.id
            WHERE o.id = $1 AND o.tenant_id = $2 AND o.merchant_id = $3
            GROUP BY o.id FOR UPDATE OF o`, [orderId, merchant.tenant_id, merchant.id]
        )
        const order = rows[0]
        if (!order || order.status !== 'PENDING_PAYMENT' || order.collection_transaction_id) {
          throw new CollectionRejectedError('This order is not available for payment.')
        }
        if (amountMinorUnits !== normalizeAmountMinorUnits(order.total_amount)) {
          throw new CollectionRejectedError('The collection amount must match the order total.')
        }
        validatedOrderId = orderId
      }

      const inserted = await client.query(
        `INSERT INTO transactions
           (tenant_id, merchant_id, type, status, amount, currency, internal_reference,
            collection_msisdn, kyc_msisdn, payment_gateway_status, payout_msisdn,
            notification_sent, credit_plan_id, credit_installment_id, order_id, base_amount,
              fee_charged_amount, fee_charged_payer, fee_eganow_cost, fee_platform_margin, fee_config_version_id,
              idempotency_key, idempotency_fingerprint)
           VALUES ($1, $2, 'COLLECTION', 'PENDING', $3, 'GHS', $4, $5, $5, 'INITIATED', $6, FALSE, $7, $8, $9,
             $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING id`,
        [merchant.tenant_id, merchant.id, gatewayAmount, internalReference, normalizedMsisdn, normalizedPayoutMsisdn,
          validatedPlanId, validatedInstallmentId, validatedOrderId, amount, collectionFee.chargedAmount,
            collectionFee.chargedPayer, collectionFee.eganowCost, collectionFee.platformMargin, collectionFee.feeConfigVersionId,
            idempotencyKey, fingerprint]
      )
      return inserted.rows[0].id
    })
  } else {
    transactionId = await withTransaction(async (client) => {
      existingTransaction = await findExistingIdempotentCollection(client, merchant.id, idempotencyKey, fingerprint)
      if (existingTransaction) return existingTransaction.id
      const { rows } = await client.query(
        `INSERT INTO transactions
         (tenant_id, merchant_id, type, status, amount, currency, internal_reference, collection_msisdn, kyc_msisdn, payment_gateway_status, payout_msisdn, notification_sent,
          base_amount, fee_charged_amount, fee_charged_payer, fee_eganow_cost, fee_platform_margin, fee_config_version_id,
          idempotency_key, idempotency_fingerprint)
       VALUES ($1, $2, 'COLLECTION', 'PENDING', $3, 'GHS', $4, $5, $6, 'INITIATED', $7, FALSE, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
        [merchant.tenant_id, merchant.id, gatewayAmount, internalReference, normalizedMsisdn, normalizedMsisdn, normalizedPayoutMsisdn,
          amount, collectionFee.chargedAmount, collectionFee.chargedPayer, collectionFee.eganowCost,
          collectionFee.platformMargin, collectionFee.feeConfigVersionId, idempotencyKey, fingerprint]
      )
      return rows[0].id
    })
  }

  if (existingTransaction) {
    return {
      transactionId: existingTransaction.id,
      internalReference: existingTransaction.internal_reference,
      status: existingTransaction.status,
      paymentGatewayStatus: existingTransaction.payment_gateway_status,
      failureReason: existingTransaction.failure_reason,
      message: 'This payment request already exists. Check its status instead of submitting again.',
      tenantId: merchant.tenant_id,
      duplicate: true
    }
  }

  let providerSubmissionAttempted = false
  try {
    let paypartnerCode
    const inferredPaypartnerCode = normalizedCollectionMethod === 'CARD' ? 'CARDGATEWAY' : inferPaypartnerCodeFromMsisdn(normalizedMsisdn)

    paypartnerCode = normalizedCollectionMethod === 'CARD'
      ? 'CARDGATEWAY'
      : resolveInstitutionMomoNetwork(network, inferredPaypartnerCode, merchant.network_provider)

    if (!paypartnerCode) {
      throw new CollectionRejectedError('Payment network is not configured for this merchant. Contact support.')
    }

    const { client, callbackUrl: vendorCallbackUrl } = await createEganowClientForMerchant(merchant.tenant_id, merchant.id)
    // Vendor credentials own the Eganow callback configuration.
    let callbackUrl = callback || vendorCallbackUrl || null
    if (!callbackUrl) {
      throw new TenantCredentialsError('Tenant Eganow callback URL is not configured.', merchant.tenant_id)
    }

    if (String(callbackUrl).includes('localhost') || String(callbackUrl).includes('127.0.0.1') || String(callbackUrl).includes('::1')) {
      throw new TenantCredentialsError('Tenant Eganow callback URL must not use a local address.', merchant.tenant_id)
    }

    if (normalizedCollectionMethod === 'MOMO' && (!normalizedMsisdn || !/^233[0-9]{9}$/.test(normalizedMsisdn))) {
      throw new CollectionRejectedError('A valid phone number is required in local or international format (e.g., 0244123456 or 233244123456).')
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

    const countryCode = normalizedMsisdn ? inferCountryCode(normalizedMsisdn) : 'GH0233'
    let accountName = merchant.display_name

    if (normalizedCollectionMethod === 'MOMO') {

    const kycBody = {
      paypartnerCode,
      mobileNumber: normalizedMsisdn,
      languageId: 'en',
      countryCode
    }

    let kycResponse
    try {
      kycResponse = await client.post('/api/vas/kyc', kycBody)
    } catch {
      const failureReason = 'Customer verification failed. Verify the payment details or contact support.'
      await updateTransactionStatus(query, {
        id: transactionId,
        type: 'COLLECTION',
        currentStatus: 'PENDING',
        nextStatus: 'FAILED',
        fields: {
          payment_gateway_status: 'KYC_FAILED',
          failure_reason: failureReason,
          completed_at: new Date()
        }
      })

      return { transactionId, internalReference, status: 'FAILED', paymentGatewayStatus: 'KYC_FAILED', failureReason, tenantId: merchant.tenant_id }
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
      const reason = `KYC failed: ${kycStatus || 'DECLINED'}`

      await updateTransactionStatus(query, {
        id: transactionId,
        type: 'COLLECTION',
        currentStatus: 'PENDING',
        nextStatus: 'FAILED',
        fields: {
          payment_gateway_status: kycStatusStr || 'KYC_FAILED',
          failure_reason: reason,
          completed_at: new Date()
        }
      })

      return { transactionId, internalReference, status: 'FAILED', paymentGatewayStatus: kycStatusStr || 'KYC_FAILED', failureReason: reason, tenantId: merchant.tenant_id }
    } else if (kycStatus && kycStatusStr !== 'successful' && kycStatusStr !== 'success') {
      // continue to attempt collection
    } else if (!kycStatus && typeof kycResponse.data === 'string') {
      // continue to attempt collection
    }

    accountName = kycResponse?.data?.accountName || accountName

    // Persist the KYC / name-enquiry result for display in transaction views
    try {
      if (accountName) {
        await query(`UPDATE transactions SET kyc_name = $2 WHERE id = $1`, [transactionId, accountName])
      }
    } catch {
      // Name enquiry is supplemental; do not print customer data or provider errors.
    }
    }

    const body = {
      paypartnerCode,
      amount,
      accountNoOrCardNoOrMSISDN: normalizedMsisdn || String(cardNumber).replace(/[\s-]/g, ''),
      accountName: normalizedCollectionMethod === 'CARD' ? String(cardholderName).trim() : accountName || merchant.display_name,
      transactionId: internalReference,
      transCurrencyIso: 'GHS',
      languageId: 'en',
      callback: callbackUrl
    }
    if (normalizedCollectionMethod === 'CARD') {
      body.expiryDateMonth = Number(expiryDateMonth)
      body.expiryDateYear = Number(expiryDateYear)
      body.cvv = String(cvv)
    }
    
    // Include narration only if provided (avoid sending undefined/null)
    if (narration) {
      body.narration = narration
    }

    body.amount = gatewayAmount
    providerSubmissionAttempted = true
    const response = await client.post(normalizedCollectionMethod === 'CARD' ? '/api/transactions/card/collect' : '/api/transactions/collection', body)

    const normalized = normalizeEganowResponse(response.data)

    const eganowReference = normalized.reference || internalReference
    const eganowTransactionId = normalized.transactionId || null

    const gatewayStatus = normalized.status || 'UNKNOWN_RESPONSE'

    if (!normalized.status && !normalized.reference && !normalized.transactionId) {
      // Keep this transaction pending and let status polling reconcile it.
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
      redirectHtml: normalized.redirectHtml || response.data?.redirectHtml || response.data?.data?.redirectHtml || null,
      message: 'Transaction initiated.',
      tenantId: merchant.tenant_id
    }
  } catch (err) {
    if (providerSubmissionAttempted && isUncertainProviderOutcome(err)) {
      const message = 'The payment provider outcome is not confirmed. Do not submit another payment; check this transaction status first.'
      await updateTransactionStatus(query, {
        id: transactionId,
        type: 'COLLECTION',
        currentStatus: 'PENDING',
        nextStatus: 'PENDING',
        fields: {
          payment_gateway_status: 'OUTCOME_UNKNOWN',
          failure_reason: message,
          completed_at: null
        }
      })
      try {
        await enqueueCollectionStatusPollJob({ tenantId: merchant.tenant_id, merchantId: merchant.id, transactionId })
      } catch (queueError) {
        console.error('[collection] status reconciliation enqueue failed', { code: queueError?.code || 'QUEUE_ERROR' })
      }
      return {
        transactionId,
        internalReference,
        status: 'PENDING',
        paymentGatewayStatus: 'OUTCOME_UNKNOWN',
        failureReason: message,
        message,
        tenantId: merchant.tenant_id
      }
    }

    const message = err instanceof CollectionRejectedError || err instanceof TenantCredentialsError
      ? err.message
      : 'Payment service is temporarily unavailable. Check transaction status or contact support.'

    await updateTransactionStatus(query, {
      id: transactionId,
      type: 'COLLECTION',
      currentStatus: 'PENDING',
      nextStatus: 'FAILED',
      fields: {
        payment_gateway_status: 'REQUEST_FAILED',
        failure_reason: message,
        completed_at: new Date()
      }
    })

    return { transactionId, internalReference, status: 'FAILED', paymentGatewayStatus: 'REQUEST_FAILED', failureReason: message, tenantId: merchant.tenant_id }
  }
}
