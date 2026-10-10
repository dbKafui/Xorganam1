import { Router } from 'express'
import { query } from '../db/pool.js'
import { reconcileInstitutionTransaction, institutionTransactionByReference } from '../services/institutionFinancialLedger.js'
import { queryInstitutionEganowStatus } from '../services/institutionEganowService.js'
import { reconcileTransaction } from '../services/reconciliationService.js'
import { normalizeAmountMinorUnits } from '../services/providerResultValidation.js'

export const webhooksRouter = Router()

// Eganow's callback is treated only as a hint; handleEganowWebhook performs
// authenticated status reconciliation before any transaction state changes.
webhooksRouter.post('/eganow/:tenant_id?', async (req, res) => {
  try {
    await handleEganowWebhook(req, res)
  } catch (err) {
    // Absolute last resort - anything that slipped past the inner
    // try/catches still gets a response instead of hanging the request
    // (and, for Eganow, timing out and triggering an unwanted retry storm).
    console.error('[webhook:eganow] unhandled callback failure', { code: err?.code || 'WEBHOOK_ERROR' })
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal server error.' })
    }
  }
})

webhooksRouter.post('/eganow-institution/:institution_id', async (req, res) => {
  try { await handleInstitutionEganowWebhook(req, res) }
  catch (error) {
    console.error('[webhook:eganow:institution] processing failed', { code: error?.code || 'WEBHOOK_ERROR' })
    if (!res.headersSent) res.status(500).json({ message: 'Unable to process institution payment callback.' })
  }
})

async function handleInstitutionEganowWebhook(req, res) {
  const rawBody = req.rawBody
  const payload = req.body
  const institutionId = req.params.institution_id
  const value = (...keys) => keys.map((key) => payload?.[key]).find((item) => item !== undefined && item !== null && item !== '')
  const accountId = value('accountId', 'AccountId', 'collectionAccountId', 'CollectionAccountId', 'destinationAccountId', 'DestinationAccountId')
  const reference = value('transactionId', 'TransactionId')
  const status = value('status', 'Status', 'transactionStatus', 'TransactionStatus')
  if (!rawBody || !payload || typeof payload !== 'object' || !reference || !status) return res.status(400).json({ message: 'Malformed Eganow callback.' })
  const { rows: institutions } = await query(
    `SELECT i.id, i.eganow_collection_account_id, i.eganow_payout_account_id
       FROM institutions i JOIN institution_eganow_credentials c ON c.institution_id = i.id
      WHERE i.id = $1 AND c.is_enabled AND ($2::text IS NULL OR i.eganow_collection_account_id = $2 OR i.eganow_payout_account_id = $2)`,
    [institutionId, accountId]
  )
  if (!institutions.length) return res.status(401).json({ message: 'Unable to verify institution callback.' })
  const transaction = await institutionTransactionByReference(institutionId, reference)
  if (!transaction) return res.status(404).json({ message: 'Institution transaction not found.' })
  if (transaction.status !== 'PENDING_GATEWAY') return res.status(200).json({ message: 'Institution payment was already reconciled.', transactionId: transaction.id, status: transaction.status })
  const expectedCents = BigInt(['LOAN_DISBURSEMENT', 'WITHDRAWAL'].includes(transaction.transaction_type)
    ? transaction.payout_amount_cents
    : transaction.amount_cents)
  const callbackAmount = value('amount', 'Amount')
  if (callbackAmount !== undefined && normalizeAmountMinorUnits(callbackAmount) !== expectedCents) {
    return res.status(409).json({ message: 'Callback amount does not match the institution transaction.' })
  }
  // Eganow's documented callback has no signature header. Treat it only as a
  // reconciliation hint and confirm the status through the institution's
  // authenticated Eganow API before changing the financial ledger.
  let result
  try {
    const gateway = await queryInstitutionEganowStatus(institutionId, reference)
    result = await reconcileInstitutionTransaction(institutionId, transaction.id, gateway)
  } catch (error) {
    console.error('[webhook:institution-eganow] authenticated reconciliation failed', { code: error?.code || 'RECONCILIATION_ERROR' })
    return res.status(503).json({ message: 'Unable to confirm payment status with Eganow; retry this callback later.' })
  }
  res.status(200).json({ message: 'Institution payment callback recorded.', transactionId: transaction.id, status: result.transaction?.status || 'PENDING_GATEWAY' })
}

async function handleEganowWebhook(req, res) {
  const payload = req.body
  const transactionId = payload?.TransactionId
  const transactionStatus = payload?.TransactionStatus
  const reference = payload?.EganowReferenceNo
  if (!payload || typeof payload !== 'object' || !transactionId || !transactionStatus || !reference) {
    return res.status(400).json({ message: 'Malformed Eganow callback.' })
  }
  const tenantId = req.params.tenant_id || null
  if (tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
    return res.status(400).json({ message: 'Invalid tenant identifier.' })
  }
  const { rows } = await query(
    `SELECT id, tenant_id FROM transactions WHERE internal_reference = $1 AND ($2::uuid IS NULL OR tenant_id = $2) LIMIT 2`,
    [String(transactionId), tenantId]
  )
  if (rows.length !== 1) return res.status(rows.length ? 409 : 404).json({ message: 'Transaction reference is not uniquely recognized.' })
  try {
    // The documented callback is an untrusted notification. Reconciliation
    // queries Eganow's authenticated status endpoint before changing ledger state.
    const result = await reconcileTransaction(rows[0].id, rows[0].tenant_id)
    return res.status(200).json({ message: 'Callback checked against Eganow.', transactionId: result?.id || rows[0].id, status: result?.status || 'PENDING' })
  } catch (error) {
    console.error('[webhook:eganow] authenticated reconciliation failed', { code: error?.code || 'RECONCILIATION_ERROR' })
    return res.status(503).json({ message: 'Unable to confirm transaction status with Eganow; retry the callback later.' })
  }
}
