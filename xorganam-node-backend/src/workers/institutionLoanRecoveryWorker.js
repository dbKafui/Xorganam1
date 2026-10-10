import { Queue, Worker } from 'bullmq'
import { getRedisConnection, INSTITUTION_LOAN_RECOVERY_QUEUE } from '../queue/queue.js'
import { query, withTransaction } from '../db/pool.js'
import {
  disburseToMobileMoney,
  getPayoutWalletBalance,
  isGatewayFailure,
  isGatewaySuccess,
  queryTransactionStatus
} from '../services/eganowClient.js'
import { createVendorReference } from '../services/referenceIds.js'
import { updateTransactionStatus } from '../services/transactionStateService.js'
import { updateInstitutionTransactionStatus } from '../services/institutionStateService.js'
import { recordOperationalFailure } from '../services/operationalFailureService.js'
import { normalizeAmountMinorUnits, formatMinorUnits } from '../services/providerResultValidation.js'

const connection = getRedisConnection()
const scheduler = new Queue(INSTITUTION_LOAN_RECOVERY_QUEUE, { connection })

async function postRecovery(payoutTransactionId, gatewayResult) {
  await withTransaction(async (tx) => {
    const { rows: recoveries } = await tx.query(
      `SELECT r.id, r.institution_id, r.account_id, r.installment_id, r.amount_cents,
              i.amount_due_cents, i.amount_paid_cents
         FROM institution_default_payout_recoveries r
         JOIN institution_loan_installments i ON i.id = r.installment_id
        WHERE r.payout_transaction_id = $1 AND r.status = 'PENDING'
        FOR UPDATE OF r, i`, [payoutTransactionId]
    )
    await updateTransactionStatus(tx, {
      id: payoutTransactionId,
      type: 'PAYOUT',
      currentStatus: 'PENDING',
      nextStatus: 'PAID_OUT',
      fields: {
        payment_gateway_status: gatewayResult.status,
        eganow_reference: gatewayResult.reference || null,
        eganow_transaction_id: gatewayResult.transactionId || null,
        completed_at: new Date()
      }
    })
    const { rows: institutionTransactions } = await tx.query(
      `SELECT id, institution_id, status FROM institution_transactions
        WHERE counterparty_transaction_id = $1`, [payoutTransactionId]
    )
    for (const row of institutionTransactions) {
      await updateInstitutionTransactionStatus(tx, {
        id: row.id,
        institutionId: row.institution_id,
        currentStatus: row.status,
        nextStatus: 'RECEIVED',
        fields: { eganow_reference: gatewayResult.reference || null }
      })
    }
    for (const recovery of recoveries) {
      const paidCents = BigInt(recovery.amount_cents)
      const installmentPaid = BigInt(recovery.amount_paid_cents) + paidCents
      if (installmentPaid > BigInt(recovery.amount_due_cents)) throw new Error('Default recovery exceeds the unpaid installment amount.')
      await tx.query(
        `UPDATE institution_loan_installments SET amount_paid_cents = $2,
                status = CASE WHEN $2 = amount_due_cents THEN 'PAID' ELSE 'PARTIALLY_PAID' END, updated_at = now()
          WHERE id = $1`, [recovery.installment_id, String(installmentPaid)]
      )
      await tx.query(
        `UPDATE institution_financial_accounts a
            SET outstanding_cents = GREATEST(0, a.outstanding_cents - $2),
                status = CASE WHEN a.outstanding_cents <= $2 THEN 'SETTLED'::institution_financial_account_status
                  WHEN EXISTS (SELECT 1 FROM institution_loan_installments i WHERE i.account_id = a.id
                    AND i.status = 'OVERDUE' AND i.amount_paid_cents < i.amount_due_cents)
                  THEN 'OVERDUE'::institution_financial_account_status
                  ELSE 'ACTIVE'::institution_financial_account_status END,
                updated_at = now()
          WHERE a.id = $1`, [recovery.account_id, paidCents]
      )
      await tx.query(
        `UPDATE institution_default_payout_recoveries SET status = 'POSTED', posted_at = now() WHERE id = $1`, [recovery.id]
      )
    }
    await updateTransactionStatus(tx, {
      id: (await tx.query('SELECT parent_transaction_id FROM transactions WHERE id = $1', [payoutTransactionId])).rows[0].parent_transaction_id,
      type: 'COLLECTION',
      currentStatus: 'RECEIVED',
      nextStatus: 'PAID_OUT',
      fields: {}
    })
  })
}

async function markPayoutFailed(payoutTransactionId, gatewayResult) {
  await withTransaction(async (tx) => {
    await updateTransactionStatus(tx, {
      id: payoutTransactionId,
      type: 'PAYOUT',
      currentStatus: 'PENDING',
      nextStatus: 'FAILED',
      fields: {
        payment_gateway_status: gatewayResult.status,
        eganow_reference: gatewayResult.reference || null,
        eganow_transaction_id: gatewayResult.transactionId || null,
        failure_reason: 'Eganow rejected the institution default recovery payout.',
        completed_at: new Date()
      }
    })
    const { rows: institutionTransactions } = await tx.query(
      `SELECT id, institution_id, status FROM institution_transactions
        WHERE counterparty_transaction_id = $1`, [payoutTransactionId]
    )
    for (const row of institutionTransactions) {
      await updateInstitutionTransactionStatus(tx, {
        id: row.id,
        institutionId: row.institution_id,
        currentStatus: row.status,
        nextStatus: 'FAILED',
        fields: { eganow_reference: gatewayResult.reference || null }
      })
    }
    await tx.query(`UPDATE institution_default_payout_recoveries SET status = 'FAILED'
      WHERE payout_transaction_id = $1 AND status = 'PENDING'`, [payoutTransactionId])
    await updateTransactionStatus(tx, {
      id: (await tx.query('SELECT parent_transaction_id FROM transactions WHERE id = $1', [payoutTransactionId])).rows[0].parent_transaction_id,
      type: 'COLLECTION',
      currentStatus: 'RECEIVED',
      nextStatus: 'FAILED',
      fields: {}
    })
  })
}

async function submitPayout(row) {
  let statusResult
  if (row.payment_gateway_status && row.payment_gateway_status !== 'READY') {
    statusResult = await queryTransactionStatus(row.tenant_id, row.internal_reference, { merchantId: row.merchant_id })
    if (isGatewaySuccess(statusResult.status)) return postRecovery(row.id, statusResult)
    if (isGatewayFailure(statusResult.status)) return markPayoutFailed(row.id, statusResult)
    return { pending: true, payoutTransactionId: row.id }
  }

  try {
    await query(`UPDATE transactions SET payment_gateway_status = 'SUBMISSION_STARTED', updated_at = now() WHERE id = $1`, [row.id])
    const result = await disburseToMobileMoney(row.tenant_id, {
      merchantId: row.merchant_id,
      reference: row.internal_reference,
      amount: row.amount,
      currency: row.currency,
      accountNoOrCardNoOrMsisdn: row.settlement_msisdn,
      network: row.network_provider,
      narration: `Defaulted loan recovery ${row.internal_reference}`,
      accountName: row.settlement_account_name || row.institution_name
    })
    if (isGatewaySuccess(result.status)) return postRecovery(row.id, result)
    if (isGatewayFailure(result.status)) return markPayoutFailed(row.id, result)
    await query(`UPDATE transactions SET payment_gateway_status = $2,
        eganow_reference = COALESCE($3, eganow_reference),
        eganow_transaction_id = COALESCE($4, eganow_transaction_id), updated_at = now() WHERE id = $1`,
      [row.id, result.status || 'PENDING', result.reference || null, result.transactionId || null])
    return { pending: true, payoutTransactionId: row.id }
  } catch (error) {
    await query(`UPDATE transactions SET payment_gateway_status = 'UNKNOWN',
        failure_reason = 'Provider response is uncertain; reconcile before retrying.', updated_at = now() WHERE id = $1 AND status = 'PENDING'`, [row.id])
    console.error('[institution-loan-recovery] payout submission uncertain', { code: error?.code || 'GATEWAY_ERROR' })
    return { pending: true, payoutTransactionId: row.id }
  }
}

async function createRecoveryPayout(tenantId, merchantId, institutionId) {
  const { rows: merchantRows } = await query(
    `SELECT m.id AS merchant_id, m.tenant_id, m.display_name,
            m.eganow_payout_account_id, i.id AS institution_id, i.name AS institution_name,
            i.settlement_msisdn, i.settlement_account_name,
            i.eganow_network_provider AS institution_network_provider
       FROM merchants m
       JOIN institutions i ON i.id = $3 AND i.status = 'ACTIVE'
       JOIN institution_member_merchant vm ON vm.tenant_id = m.tenant_id AND vm.merchant_id = m.id
          AND vm.institution_id = i.id
       JOIN institution_member im ON im.id = vm.member_id AND im.status = 'APPROVED'
       JOIN tenant_institution_links l ON l.tenant_id = m.tenant_id AND l.institution_id = i.id
          AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
      WHERE m.tenant_id = $1 AND m.id = $2 AND m.is_active AND m.account_setup_status = 'ACTIVE'`,
    [tenantId, merchantId, institutionId]
  )
  const merchant = merchantRows[0]
  if (!merchant) return { skipped: true, reason: 'vendor-institution-link-inactive' }

  const { rows: pendingRows } = await query(
    `SELECT t.id, t.internal_reference, t.status, t.amount, t.currency,
            t.payment_gateway_status, t.merchant_id, t.tenant_id, i.settlement_msisdn,
            i.settlement_account_name, i.name AS institution_name,
            i.eganow_network_provider AS network_provider
       FROM institution_default_payout_recoveries r
       JOIN transactions t ON t.id = r.payout_transaction_id
       JOIN institutions i ON i.id = r.institution_id
      WHERE r.merchant_id = $1 AND r.institution_id = $2 AND r.status = 'PENDING'
        AND t.status = 'PENDING'
      ORDER BY t.created_at LIMIT 1`, [merchantId, institutionId]
  )
  if (pendingRows[0]) return submitPayout(pendingRows[0])

  const balance = await getPayoutWalletBalance(tenantId, merchant.eganow_payout_account_id, merchantId)
  const availableCents = normalizeAmountMinorUnits(balance)
  if (availableCents === null || availableCents <= 0n) return { skipped: true, reason: 'no-payout-wallet-balance' }

  const prepared = await withTransaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`institution-default-payout:${merchantId}:${institutionId}`])
    const { rows: pending } = await tx.query(
      `SELECT t.id, t.internal_reference, t.status, t.amount, t.currency,
              t.payment_gateway_status, t.merchant_id, t.tenant_id, i.settlement_msisdn,
              i.settlement_account_name, i.name AS institution_name,
              i.eganow_network_provider AS network_provider
         FROM institution_default_payout_recoveries r
         JOIN transactions t ON t.id = r.payout_transaction_id
         JOIN institutions i ON i.id = r.institution_id
         JOIN merchants m ON m.id = r.merchant_id AND m.tenant_id = r.tenant_id
        WHERE r.merchant_id = $1 AND r.institution_id = $2 AND r.status = 'PENDING'
          AND t.status = 'PENDING'
        ORDER BY t.created_at LIMIT 1 FOR UPDATE OF t`, [merchantId, institutionId]
    )
    if (pending[0]) return { existing: pending[0] }

    const { rows: installments } = await tx.query(
      `SELECT a.id AS account_id, a.outstanding_cents, i.id AS installment_id,
              i.amount_due_cents - i.amount_paid_cents AS due_cents
         FROM institution_financial_accounts a
         JOIN institution_financial_products p ON p.id = a.product_id AND p.institution_id = a.institution_id
         JOIN institution_customers c ON c.id = a.customer_id AND c.institution_id = a.institution_id
         JOIN institution_member_merchant vm ON vm.id = a.vendor_link_id AND vm.member_id IS NOT NULL
          AND vm.tenant_id = $1 AND vm.merchant_id = $2 AND vm.institution_id = $3
         JOIN institution_member im ON im.id = vm.member_id AND im.institution_id = a.institution_id AND im.status = 'APPROVED'
         JOIN institution_loan_installments i ON i.account_id = a.id AND i.institution_id = a.institution_id
        WHERE a.institution_id = $3 AND a.status = 'OVERDUE' AND p.product_type = 'LOAN' AND p.status = 'ACTIVE'
          AND c.tenant_id = $1 AND c.is_active AND c.kyc_status = 'VERIFIED'
          AND i.status = 'OVERDUE' AND i.amount_paid_cents < i.amount_due_cents
          AND NOT EXISTS (SELECT 1 FROM institution_default_payout_recoveries r
            WHERE r.installment_id = i.id AND r.status = 'PENDING')
        ORDER BY i.due_date, i.installment_number, a.created_at, a.id
        FOR UPDATE OF a, i`, [tenantId, merchantId, institutionId]
    )
    if (!installments.length) return { skipped: true, reason: 'no-defaulted-loan-due' }
    let remaining = availableCents
    const allocations = []
    const accountCapacity = new Map()
    for (const installment of installments) {
      if (remaining <= 0) break
      const capacity = accountCapacity.has(installment.account_id)
        ? accountCapacity.get(installment.account_id)
        : BigInt(installment.outstanding_cents)
      const due = BigInt(installment.due_cents)
      const amount = [remaining, due, capacity].reduce((smallest, value) => value < smallest ? value : smallest)
      if (amount <= 0n) continue
      allocations.push({ ...installment, amount_cents: amount })
      remaining -= amount
      accountCapacity.set(installment.account_id, capacity - amount)
    }
    if (!allocations.length) return { skipped: true, reason: 'no-recoverable-balance' }
    const totalCents = allocations.reduce((sum, item) => sum + item.amount_cents, 0n)
    const { rows: parents } = await tx.query(
      `INSERT INTO transactions (tenant_id, merchant_id, institution_id, type, status, amount, currency, internal_reference)
       VALUES ($1, $2, $3, 'SWEEP_PAYOUT', 'PENDING', $4, 'GHS', $5) RETURNING id`,
      [tenantId, merchantId, institutionId, formatMinorUnits(totalCents), createVendorReference(merchant.display_name, 'DEF')]
    )
    const parentId = parents[0].id
    const { rows: payouts } = await tx.query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, institution_id, parent_transaction_id, type, payout_leg,
          status, amount, currency, internal_reference, payout_msisdn, payment_gateway_status)
       VALUES ($1, $2, $3, $4, 'PAYOUT', 'INSTITUTION', 'PENDING', $5, 'GHS', $6, $7, 'READY')
       RETURNING id, internal_reference, status, amount, currency, merchant_id, tenant_id,
                 payment_gateway_status`,
      [tenantId, merchantId, institutionId, parentId, formatMinorUnits(totalCents),
        createVendorReference(merchant.display_name, 'INST'), merchant.settlement_msisdn]
    )
    const payout = payouts[0]
    for (const allocation of allocations) {
      await tx.query(
        `INSERT INTO institution_default_payout_recoveries
           (institution_id, tenant_id, merchant_id, account_id, installment_id,
            sweep_transaction_id, payout_transaction_id, amount_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [institutionId, tenantId, merchantId, allocation.account_id, allocation.installment_id,
          parentId, payout.id, String(allocation.amount_cents)]
      )
    }
    await tx.query(
      `INSERT INTO institution_transactions
         (institution_id, type, status, amount, internal_reference, counterparty_transaction_id)
       VALUES ($1, 'COLLECTION', 'PENDING', $2, $3, $4)
       ON CONFLICT (internal_reference) DO NOTHING`,
      [institutionId, formatMinorUnits(totalCents), `IDEF-${payout.id}`, payout.id]
    )
    return { payout: { ...payout, settlement_msisdn: merchant.settlement_msisdn,
      settlement_account_name: merchant.settlement_account_name, institution_name: merchant.institution_name,
      network_provider: merchant.institution_network_provider } }
  })
  if (prepared.existing) return submitPayout(prepared.existing)
  if (prepared.skipped) return prepared
  return submitPayout(prepared.payout)
}

async function scanDefaultedLoans() {
  const { rows } = await query(
    `SELECT DISTINCT a.tenant_id, vm.merchant_id, a.institution_id
       FROM institution_financial_accounts a
       JOIN institution_financial_products p ON p.id = a.product_id AND p.institution_id = a.institution_id
       JOIN institution_customers c ON c.id = a.customer_id AND c.institution_id = a.institution_id
       JOIN institution_member_merchant vm ON vm.id = a.vendor_link_id AND vm.institution_id = a.institution_id
       JOIN institution_member im ON im.id = vm.member_id AND im.status = 'APPROVED'
       JOIN tenant_institution_links l ON l.tenant_id = vm.tenant_id AND l.institution_id = a.institution_id
        AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
       JOIN institution_loan_installments i ON i.account_id = a.id AND i.institution_id = a.institution_id
      WHERE a.status = 'OVERDUE' AND p.product_type = 'LOAN' AND p.status = 'ACTIVE'
        AND c.tenant_id = vm.tenant_id AND c.is_active AND c.kyc_status = 'VERIFIED'
        AND i.status = 'OVERDUE' AND i.amount_paid_cents < i.amount_due_cents
      ORDER BY a.tenant_id, vm.merchant_id, a.institution_id LIMIT 500`
  )
  const results = []
  for (const scope of rows) {
    try {
      results.push({ merchantId: scope.merchant_id, institutionId: scope.institution_id,
        ...(await createRecoveryPayout(scope.tenant_id, scope.merchant_id, scope.institution_id)) })
    } catch (error) {
      console.error('[institution-loan-recovery] payout failed', { code: error?.code || 'RECOVERY_ERROR' })
    }
  }
  return results
}

scheduler.add('scan-overdue-institution-loans', {}, {
  repeat: { every: 15 * 60 * 1000 }, jobId: 'institution-loan-recovery-payout-quarter-hourly'
}).catch((error) => console.error('[institution-loan-recovery] schedule failed', { code: error?.code || 'WORKER_ERROR' }))

export const institutionLoanRecoveryWorker = new Worker(INSTITUTION_LOAN_RECOVERY_QUEUE, async (job) => {
  if (job.name === 'scan-overdue-institution-loans') return scanDefaultedLoans()
  return { skipped: true }
}, { connection, concurrency: 1 })

institutionLoanRecoveryWorker.on('error', (error) => console.error('[institution-loan-recovery] worker error', { code: error?.code || 'WORKER_ERROR' }))
institutionLoanRecoveryWorker.on('failed', (job, error) => {
  recordOperationalFailure({ queueName: INSTITUTION_LOAN_RECOVERY_QUEUE, job, error })
    .catch((persistError) => console.error('[institution-loan-recovery] failure alert persistence failed', { code: persistError?.code || 'DB_ERROR' }))
})
