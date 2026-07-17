import { Router } from 'express'
import crypto from 'node:crypto'
import { query, withTransaction } from '../db/pool.js'
import { getTenantWebhookSecret, TenantCredentialsError } from '../services/credentialsService.js'
import { hmacSha256Hex, timingSafeEqualHex } from '../security/encryption.js'
import { enqueueCollectForMeJob } from '../queue/queue.js'
import { sendMerchantSms, sendMerchantEmail } from '../services/notificationService.js'

export const webhooksRouter = Router()

const SIGNATURE_HEADER = 'x-eganow-signature'

/**
 * Registered twice in server.js:
 *   POST /api/v1/webhooks/eganow/:tenant_id   (tenant known from the URL)
 *   POST /api/v1/webhooks/eganow              (tenant resolved from payload)
 * Both converge on this one handler so signature verification and
 * transaction logging can never drift between the two entry points.
 */
webhooksRouter.post('/eganow/:tenant_id?', async (req, res) => {
  try {
    await handleEganowWebhook(req, res)
  } catch (err) {
    // Absolute last resort - anything that slipped past the inner
    // try/catches still gets a response instead of hanging the request
    // (and, for Eganow, timing out and triggering an unwanted retry storm).
    console.error('[webhook:eganow] unhandled error in webhook handler', err)
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error.' })
    }
  }
})

async function handleEganowWebhook(req, res) {
  // req.rawBody is populated by the raw-body capturing middleware in
  // server.js, registered ahead of express.json() for this route -
  // signature verification MUST run against the exact bytes Eganow
  // signed, not a re-serialized copy of the parsed JSON.
  const rawBody = req.rawBody
  const payload = req.body

  if (!rawBody || !payload || typeof payload !== 'object') {
    return res.status(400).json({ message: 'Malformed payload.' })
  }

  const eganowAccountId = payload.accountId || payload.collectionAccountId || payload.destinationAccountId
  const eganowReference = payload.reference
  const eganowTransactionId = payload.transactionId
  const status = payload.status
  const amount = payload.amount

  if (!eganowReference || !status || !eganowAccountId) {
    return res.status(400).json({ message: 'Payload missing required fields.' })
  }

  // ---- Step 1: resolve tenant + merchant -------------------------------
  let tenantId = req.params.tenant_id || null
  let merchant

  try {
    if (tenantId) {
      merchant = await findMerchantByAccountId(tenantId, eganowAccountId)
    } else {
      // No tenant in the URL - the only safe way to find one is by
      // looking up the Eganow account id against merchants, which also
      // gives us tenant_id and merchant_id in a single query.
      merchant = await findMerchantByAccountIdAnyTenant(eganowAccountId)
      tenantId = merchant?.tenant_id ?? null
    }
  } catch (err) {
    console.error('[webhook:eganow] tenant/merchant lookup failed', err)
    return res.status(401).json({ message: 'Unable to verify webhook.' })
  }

  if (!tenantId || !merchant) {
    // Deliberately generic - do not reveal whether the tenant exists,
    // whether the account id is unrecognized, or anything else.
    return res.status(401).json({ message: 'Unable to verify webhook.' })
  }

  // ---- Step 2: verify signature using THAT tenant's own secret --------
  const providedSignature = req.headers[SIGNATURE_HEADER]

  if (!providedSignature) {
    console.warn(`[webhook:eganow] missing signature header for tenant ${tenantId}`)
    return res.status(401).json({ message: 'Unable to verify webhook.' })
  }

  let webhookSecret
  try {
    webhookSecret = await getTenantWebhookSecret(tenantId)
  } catch (err) {
    if (err instanceof TenantCredentialsError) {
      // Tenant not found / not active - same generic 401, no distinction
      // exposed to the caller between "bad signature" and "unknown tenant".
      return res.status(401).json({ message: 'Unable to verify webhook.' })
    }
    console.error('[webhook:eganow] credential lookup error', err)
    return res.status(401).json({ message: 'Unable to verify webhook.' })
  }

  if (!webhookSecret) {
    // Tenant exists but hasn't had a webhook secret configured yet (e.g.
    // still mid-onboarding, before a platform admin activated Eganow) -
    // there is no valid signature to compare against, so this can never
    // succeed. Fail the same generic way rather than crashing on a null key.
    console.warn(`[webhook:eganow] tenant ${tenantId} has no webhook secret configured.`)
    return res.status(401).json({ message: 'Unable to verify webhook.' })
  }

  const expectedSignature = hmacSha256Hex(rawBody, webhookSecret)

  console.log(`[webhook:eganow] tenant=${tenantId} rawBodyLength=${rawBody.length} provided=${String(providedSignature).slice(0, 16)}... expected=${expectedSignature.slice(0, 16)}...`)

  if (!timingSafeEqualHex(expectedSignature, String(providedSignature))) {
    console.warn(`[webhook:eganow] signature mismatch for tenant ${tenantId}. Provided: ${String(providedSignature).slice(0, 32)}... Expected: ${expectedSignature.slice(0, 32)}...`)
    return res.status(401).json({ message: 'Unable to verify webhook.' })
  }

  // ---- Step 3: log the transaction, scoped to tenant + merchant -------
  let transaction
  try {
    transaction = await recordCollectionTransaction({
      tenantId,
      merchantId: merchant.id,
      eganowReference,
      eganowTransactionId,
      status,
      amount,
      currency: payload.currency || 'GHS',
      rawPayload: payload
    })
  } catch (err) {
    console.error(`[webhook:eganow] failed to log transaction for tenant ${tenantId}`, err)
    // Still acknowledge with 200 only once persisted - a 500 here tells
    // Eganow to retry delivery, which is what we want if our own write
    // failed transiently.
    return res.status(500).json({ message: 'Failed to record transaction.' })
  }

  // Acknowledge immediately - everything past this point is best-effort
  // dispatch, not something Eganow should retry the webhook over.
  res.status(200).json({ message: 'Webhook processed.', transactionId: transaction.id })

  if (transaction.alreadyProcessed) {
    return // duplicate delivery of a webhook we've already routed
  }

  const successStatuses = ['success', 'successful', 'completed']
  const isSuccess = successStatuses.includes(String(status).toLowerCase())

  if (!isSuccess) {
    return // only successful collections continue into the payout pipeline
  }

  // ---- Step 4: check merchant configuration, fork the pipeline --------
  try {
    if (merchant.payout_mode === 'AUTO_SWEEP') {
      await enqueueCollectForMeJob({
        tenantId,
        merchantId: merchant.id,
        transactionId: transaction.id
      })
      console.log(`[webhook:eganow] queued AUTO_SWEEP job for tenant=${tenantId} merchant=${merchant.id} txn=${transaction.id}`)
    } else {
      const message = `Payment of ${amount} received. Ref: ${eganowReference}. Log in to move it to your MoMo account.`
      await sendMerchantSms(tenantId, merchant.mobile_money_number, message)
      if (merchant.notify_email && merchant.contact_email) {
        await sendMerchantEmail(tenantId, merchant.contact_email, 'Payment received', message)
      }
    }
  } catch (err) {
    // Post-acknowledgement failures (queue down, SMS gateway down) must
    // never surface as a failed webhook response - we've already told
    // Eganow we're done. Log loudly for ops instead.
    console.error(`[webhook:eganow] post-processing failed for transaction ${transaction.id}`, err)
  }
}

async function findMerchantByAccountId(tenantId, eganowAccountId) {
  const { rows } = await query(
    `SELECT m.id, m.tenant_id, m.payout_mode, m.mobile_money_number, m.network_provider,
            ms.notify_email, ms.notify_sms, ms.contact_email
       FROM merchants m
       LEFT JOIN merchant_settings ms ON ms.tenant_id = m.tenant_id AND ms.merchant_id = m.id
      WHERE m.tenant_id = $1
        AND (m.eganow_collection_account_id = $2 OR m.eganow_payout_account_id = $2)
        AND m.is_active = TRUE`,
    [tenantId, eganowAccountId]
  )
  return rows[0] || null
}

async function findMerchantByAccountIdAnyTenant(eganowAccountId) {
  const { rows } = await query(
    `SELECT m.id, m.tenant_id, m.payout_mode, m.mobile_money_number, m.network_provider,
            ms.notify_email, ms.notify_sms, ms.contact_email
       FROM merchants m
       LEFT JOIN merchant_settings ms ON ms.tenant_id = m.tenant_id AND ms.merchant_id = m.id
      WHERE (m.eganow_collection_account_id = $1 OR m.eganow_payout_account_id = $1)
        AND m.is_active = TRUE`,
    [eganowAccountId]
  )
  return rows[0] || null
}

function mapStatus(eganowStatus) {
  switch (String(eganowStatus).toLowerCase()) {
    case 'success':
    case 'successful':
    case 'completed':
      return 'RECEIVED'
    case 'failed':
    case 'failure':
    case 'declined':
      return 'FAILED'
    default:
      return 'PENDING'
  }
}

async function recordCollectionTransaction({ tenantId, merchantId, eganowReference, eganowTransactionId, status, amount, currency, rawPayload }) {
  return withTransaction(async (client) => {
    const mappedStatus = mapStatus(status)

    // First, try to find and update an EXISTING collection transaction that was
    // initiated by the frontend/backend and is waiting for a webhook confirmation.
    // This matches on eganow_reference (set by the collection endpoint) and type.
    const existingByRef = await client.query(
      `SELECT id, status FROM transactions 
       WHERE tenant_id = $1 AND eganow_reference = $2 AND type = 'COLLECTION'`,
      [tenantId, eganowReference]
    )

    if (existingByRef.rows.length > 0) {
      const existing = existingByRef.rows[0]
      
      // If we already processed this webhook, it's a duplicate.
      if (existing.status !== 'PENDING') {
        return { id: existing.id, alreadyProcessed: true }
      }

      // Update the existing transaction with webhook confirmation
      await client.query(
        `UPDATE transactions
         SET status = $2, eganow_transaction_id = COALESCE($3, eganow_transaction_id),
             payment_gateway_status = $5,
             raw_webhook_payload = $4,
             completed_at = CASE WHEN $2 IN ('RECEIVED', 'FAILED') THEN now() ELSE completed_at END,
             updated_at = now()
         WHERE id = $1`,
        [existing.id, mappedStatus, eganowTransactionId, JSON.stringify(rawPayload), status]
      )

      return { id: existing.id, alreadyProcessed: false }
    }

    // If no existing collection transaction by reference, check if there's one by
    // internal reference (field set initially). This handles cases where
    // the webhook comes with only transactionId or other identifiers.
    const existingByTxnId = await client.query(
      `SELECT id, status FROM transactions 
       WHERE tenant_id = $1 AND eganow_transaction_id = $2 AND type = 'COLLECTION'`,
      [tenantId, eganowTransactionId]
    )

    if (existingByTxnId.rows.length > 0) {
      const existing = existingByTxnId.rows[0]
      
      if (existing.status !== 'PENDING') {
        return { id: existing.id, alreadyProcessed: true }
      }

      await client.query(
        `UPDATE transactions
         SET status = $2, eganow_reference = COALESCE($3, eganow_reference),
             payment_gateway_status = $5,
             raw_webhook_payload = $4,
             completed_at = CASE WHEN $2 IN ('RECEIVED', 'FAILED') THEN now() ELSE completed_at END,
             updated_at = now()
         WHERE id = $1`,
        [existing.id, mappedStatus, eganowReference, JSON.stringify(rawPayload), status]
      )

      return { id: existing.id, alreadyProcessed: false }
    }

    // Fallback: if no existing transaction found by reference or transactionId,
    // create a new one (webhook came without enough info to correlate, or
    // collection was initiated externally / directly via Eganow API).
    const internalReference = `COL-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`

    const inserted = await client.query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, type, status, amount, currency,
          internal_reference, eganow_reference, eganow_transaction_id,
          payment_gateway_status, raw_webhook_payload, completed_at)
       VALUES ($1, $2, 'COLLECTION', $3, $4, $5, $6, $7, $8, $9, $10,
               CASE WHEN $3 IN ('RECEIVED', 'FAILED') THEN now() ELSE NULL END)
       RETURNING id`,
      [
        tenantId,
        merchantId,
        mappedStatus,
        amount,
        currency,
        internalReference,
        eganowReference,
        eganowTransactionId,
        status,
        JSON.stringify(rawPayload)
      ]
    )

    return { id: inserted.rows[0].id, alreadyProcessed: false }
  })
}
