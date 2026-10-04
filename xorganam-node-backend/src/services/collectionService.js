import crypto from 'node:crypto'
import { query, withTransaction } from '../db/pool.js'
import { createEganowClientForTenant, normalizePaypartnerCode, normalizeEganowResponse } from './eganowClient.js'
import { getTenantEganowContext, TenantCredentialsError } from './credentialsService.js'
import { enqueueCollectionStatusPollJob } from '../queue/queue.js'

export class CollectionRejectedError extends Error {}

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
    `SELECT m.id, m.tenant_id, m.display_name, m.is_active, m.account_setup_status, m.eganow_collection_account_id,
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
export async function initiateCollection(merchantId, { amount, msisdn, network, narration, payoutMsisdn = null, callback = null, creditPlanId = null, creditInstallmentId = null, orderId = null }) {
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
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
    throw new CollectionRejectedError('Amount must be a valid positive amount with at most two decimal places.')
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
  if (!/^233[0-9]{9}$/.test(normalizedMsisdn)) {
    throw new CollectionRejectedError('A valid Ghana mobile number is required.')
  }
  const normalizedPayoutMsisdn = payoutMsisdn ? normalizeMsisdn(payoutMsisdn) : null
  if (normalizedPayoutMsisdn && !/^233[0-9]{9}$/.test(normalizedPayoutMsisdn)) {
    throw new CollectionRejectedError('A valid payout phone number is required in local or international format.')
  }

  let transactionId
  if (creditInstallmentId || creditPlanId || orderId) {
    transactionId = await withTransaction(async (client) => {
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
      if (Math.round(Number(amount) * 100) !== Math.round(Number(installment.amount_due) * 100)) {
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
        if (!plan || plan.plan_status !== 'ACTIVE' || plan.order_status !== 'PENDING_PAYMENT' || Number(plan.down_payment) <= 0) {
          throw new CollectionRejectedError('The credit order down payment is not available.')
        }
        if (Math.round(Number(amount) * 100) !== Math.round(Number(plan.down_payment) * 100)) {
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
        if (Math.round(Number(amount) * 100) !== Math.round(Number(order.total_amount) * 100)) {
          throw new CollectionRejectedError('The collection amount must match the order total.')
        }
        validatedOrderId = orderId
      }

      const inserted = await client.query(
        `INSERT INTO transactions
           (tenant_id, merchant_id, type, status, amount, currency, internal_reference,
            collection_msisdn, kyc_msisdn, payment_gateway_status, payout_msisdn,
            notification_sent, credit_plan_id, credit_installment_id, order_id)
         VALUES ($1, $2, 'COLLECTION', 'PENDING', $3, 'GHS', $4, $5, $5, 'INITIATED', $6, FALSE, $7, $8, $9)
         RETURNING id`,
        [merchant.tenant_id, merchant.id, amount, internalReference, normalizedMsisdn, normalizedPayoutMsisdn,
          validatedPlanId, validatedInstallmentId, validatedOrderId]
      )
      return inserted.rows[0].id
    })
  } else {
    const { rows } = await query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, type, status, amount, currency, internal_reference, collection_msisdn, kyc_msisdn, payment_gateway_status, payout_msisdn, notification_sent)
       VALUES ($1, $2, 'COLLECTION', 'PENDING', $3, 'GHS', $4, $5, $6, 'INITIATED', $7, FALSE)
       RETURNING id`,
      [merchant.tenant_id, merchant.id, amount, internalReference, normalizedMsisdn, normalizedMsisdn, normalizedPayoutMsisdn]
    )
    transactionId = rows[0].id
  }

  try {
    let paypartnerCode
    const inferredPaypartnerCode = inferPaypartnerCodeFromMsisdn(normalizedMsisdn)

    if (inferredPaypartnerCode) {
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

    let kycResponse
    try {
      kycResponse = await client.post('/api/vas/kyc', kycBody)
    } catch {
      const failureReason = 'Customer verification failed. Verify the payment details or contact support.'
      await query(
        `UPDATE transactions
            SET status = 'FAILED',
                payment_gateway_status = 'KYC_FAILED',
                failure_reason = $2,
                updated_at = now(),
                completed_at = now()
          WHERE id = $1`,
        [transactionId, failureReason]
      )

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
      // continue to attempt collection
    } else if (!kycStatus && typeof kycResponse.data === 'string') {
      // continue to attempt collection
    }

    const accountName = kycResponse?.data?.accountName || null

    // Persist the KYC / name-enquiry result for display in transaction views
    try {
      if (accountName) {
        await query(`UPDATE transactions SET kyc_name = $2 WHERE id = $1`, [transactionId, accountName])
      }
    } catch {
      // Name enquiry is supplemental; do not print customer data or provider errors.
    }

    const body = {
      paypartnerCode,
      amount,
      accountNoOrCardNoOrMSISDN: normalizedMsisdn,
      countryCode,
      accountName: accountName || merchant.display_name,
      transactionId: internalReference,
      transCurrencyIso: 'GHS',
      languageId: 'en',
      callback: callbackUrl
    }
    
    // Include narration only if provided (avoid sending undefined/null)
    if (narration) {
      body.narration = narration
    }

    const response = await client.post('/api/transactions/collection', body)

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
      message: 'Transaction initiated.',
      tenantId: merchant.tenant_id
    }
  } catch (err) {
    const message = err instanceof CollectionRejectedError || err instanceof TenantCredentialsError
      ? err.message
      : 'Payment service is temporarily unavailable. Check transaction status or contact support.'

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
