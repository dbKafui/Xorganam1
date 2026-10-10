import { query, withTransaction } from '../db/pool.js'
import { disburseToMobileMoney, getPayoutWalletBalance, isGatewayFailure, isGatewaySuccess, queryTransactionStatus } from './eganowClient.js'
import { createVendorReference } from './referenceIds.js'
import { updateTransactionStatus } from './transactionStateService.js'
import { updateInstitutionSweepStatus } from './institutionSweepStateService.js'
import { normalizeAmountMinorUnits, formatMinorUnits } from './providerResultValidation.js'

async function createCashSweepGroups() {
  return withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('xorganam-credit-cash-sweep'))`)
    const { rows: scopes } = await tx.query(
      `SELECT a.tenant_id, a.merchant_id, a.institution_id, m.display_name
         FROM periodic_accrual_ledger a
         JOIN merchants m ON m.id = a.merchant_id AND m.tenant_id = a.tenant_id
        WHERE a.status = 'PENDING' AND a.source_credit_installment_id IS NOT NULL
          AND a.swept_transaction_id IS NULL
        GROUP BY a.tenant_id, a.merchant_id, a.institution_id, m.display_name ORDER BY a.tenant_id, a.merchant_id, a.institution_id LIMIT 100`
    )
    const created = []
    for (const scope of scopes) {
      const { rows: accruals } = await tx.query(
        `SELECT id, accrued_amount FROM periodic_accrual_ledger
          WHERE tenant_id = $1 AND merchant_id = $2 AND institution_id = $3
            AND status = 'PENDING' AND source_credit_installment_id IS NOT NULL
            AND swept_transaction_id IS NULL
          FOR UPDATE`, [scope.tenant_id, scope.merchant_id, scope.institution_id]
      )
      if (!accruals.length) continue
      const total = accruals.reduce((sum, item) => {
        const cents = normalizeAmountMinorUnits(item.accrued_amount)
        if (cents === null) throw new Error('Credit cash accrual has unsupported precision.')
        return sum + cents
      }, 0n)
      const { rows: parentRows } = await tx.query(
        `INSERT INTO transactions (tenant_id, merchant_id, institution_id, type, status, amount, currency, internal_reference)
         VALUES ($1, $2, $3, 'SWEEP_PAYOUT', 'PENDING', $4, 'GHS', $5)
         RETURNING id`, [scope.tenant_id, scope.merchant_id, scope.institution_id, formatMinorUnits(total), createVendorReference(scope.display_name, 'CASH')]
      )
      const parentId = parentRows[0].id
      await tx.query(
        `INSERT INTO institution_sweep_ledger
           (institution_id, tenant_id, merchant_id, sweep_transaction_id, vendor_amount,
            institution_amount, status, period_key)
         VALUES ($1, $2, $3, $4, 0, $5, 'PENDING', CURRENT_DATE)`,
        [scope.institution_id, scope.tenant_id, scope.merchant_id, parentId, formatMinorUnits(total)]
      )
      await tx.query(
        `UPDATE periodic_accrual_ledger SET swept_transaction_id = $4, period_key = CURRENT_DATE
          WHERE id = ANY($1::uuid[]) AND tenant_id = $2 AND merchant_id = $3`,
        [accruals.map((item) => item.id), scope.tenant_id, scope.merchant_id, parentId]
      )
      created.push(parentId)
    }
    return created
  })
}

async function processCashSweep(parentId) {
  const { rows } = await query(
    `SELECT l.tenant_id, l.merchant_id, l.institution_id, l.institution_amount,
            l.status AS sweep_status, i.settlement_msisdn, m.network_provider, m.display_name,
            COALESCE((SELECT id FROM transactions leg WHERE leg.parent_transaction_id = t.id
                      AND leg.type = 'PAYOUT' AND leg.payout_leg = 'INSTITUTION' LIMIT 1), NULL) AS leg_id
       FROM institution_sweep_ledger l
       JOIN transactions t ON t.id = l.sweep_transaction_id
       JOIN institutions i ON i.id = l.institution_id
       JOIN merchants m ON m.id = l.merchant_id AND m.tenant_id = l.tenant_id
      WHERE l.sweep_transaction_id = $1 AND EXISTS (
        SELECT 1 FROM periodic_accrual_ledger a
         WHERE a.swept_transaction_id = l.sweep_transaction_id
           AND a.source_credit_installment_id IS NOT NULL AND a.status = 'PENDING'
      )`, [parentId]
  )
  const sweep = rows[0]
  if (!sweep) return { skipped: true }
  let leg
  if (sweep.leg_id) {
    const found = await query(`SELECT id, status, internal_reference, eganow_reference, amount FROM transactions WHERE id = $1`, [sweep.leg_id])
    leg = found.rows[0]
  }
  if (leg?.status === 'PAID_OUT') return completeCashSweep(parentId, leg.id)
  if (leg?.status === 'FAILED') {
    await updateInstitutionSweepStatus(query, {
      id: sweep.id,
      currentStatus: sweep.sweep_status,
      nextStatus: 'PARTIALLY_SETTLED',
      fields: {
        institution_leg_status: 'FAILED',
        failure_reason: 'The institution leg failed and requires manual review.'
      }
    })
    return { failed: true, manualReviewRequired: true }
  }

  const balance = await getPayoutWalletBalance(sweep.tenant_id, null, sweep.merchant_id)
  const balanceCents = normalizeAmountMinorUnits(balance)
  const sweepCents = normalizeAmountMinorUnits(sweep.institution_amount)
  if (balanceCents === null || sweepCents === null || balanceCents < sweepCents) {
    await updateInstitutionSweepStatus(query, {
      id: sweep.id,
      currentStatus: sweep.sweep_status,
      nextStatus: 'ACCRUED_UNSWEPT',
      fields: { failure_reason: 'Insufficient payout-wallet balance.' }
    })
    return { accruedUnswept: true }
  }

  if (!leg) {
    const { rows: inserted } = await query(
      `INSERT INTO transactions
         (tenant_id, merchant_id, institution_id, parent_transaction_id, type, payout_leg,
          status, amount, currency, internal_reference, payout_msisdn)
       VALUES ($1, $2, $3, $4, 'PAYOUT', 'INSTITUTION', 'PENDING', $5, 'GHS', $6, $7)
       ON CONFLICT ON CONSTRAINT uq_transactions_parent_type_leg DO NOTHING
       RETURNING id, status, internal_reference, amount`,
      [sweep.tenant_id, sweep.merchant_id, sweep.institution_id, parentId, sweep.institution_amount, createVendorReference(sweep.display_name, 'INST'), sweep.settlement_msisdn]
    )
    if (inserted[0]) leg = inserted[0]
    else {
      const existing = await query(`SELECT id, status, internal_reference, eganow_reference, amount FROM transactions WHERE parent_transaction_id = $1 AND type = 'PAYOUT' AND payout_leg = 'INSTITUTION'`, [parentId])
      leg = existing.rows[0]
    }
  }

  if (leg.eganow_reference) {
    const status = await queryTransactionStatus(sweep.tenant_id, leg.internal_reference, { merchantId: sweep.merchant_id })
    if (isGatewaySuccess(status.status)) return markCashLegPaid(parentId, leg.id, status.status)
    if (isGatewayFailure(status.status)) return markCashLegFailed(parentId, leg.id, status.status)
    await updateInstitutionSweepStatus(query, {
      id: sweep.id,
      currentStatus: sweep.sweep_status,
      nextStatus: 'PENDING',
      fields: {}
    })
    return { pending: true }
  }

  const result = await disburseToMobileMoney(sweep.tenant_id, {
    merchantId: sweep.merchant_id,
    reference: leg.internal_reference, amount: leg.amount, currency: 'GHS',
    accountNoOrCardNoOrMsisdn: sweep.settlement_msisdn, network: sweep.network_provider,
    narration: `Cash installment institution split ${parentId}`
  })
  if (isGatewaySuccess(result.status)) return markCashLegPaid(parentId, leg.id, result.status, result)
  if (isGatewayFailure(result.status)) return markCashLegFailed(parentId, leg.id, result.status, result)
  await query(
    `UPDATE transactions SET eganow_reference = COALESCE($2, eganow_reference),
            eganow_transaction_id = COALESCE($3, eganow_transaction_id), payment_gateway_status = $4, updated_at = now()
      WHERE id = $1`, [leg.id, result.reference || null, result.transactionId || null, result.status || 'PENDING']
  )
  await updateInstitutionSweepStatus(query, {
    id: sweep.id,
    currentStatus: sweep.sweep_status,
    nextStatus: 'PENDING',
    fields: {}
  })
  return { pending: true }
}

async function markCashLegPaid(parentId, legId, status, result = {}) {
  await updateTransactionStatus(query, {
    id: legId,
    type: 'PAYOUT',
    currentStatus: 'PENDING',
    nextStatus: 'PAID_OUT',
    fields: {
      payment_gateway_status: status,
      eganow_reference: result.reference || null,
      eganow_transaction_id: result.transactionId || null,
      completed_at: new Date()
    }
  })
  return completeCashSweep(parentId, legId)
}

async function markCashLegFailed(parentId, legId, status, result = {}) {
  await updateTransactionStatus(query, {
    id: legId,
    type: 'PAYOUT',
    currentStatus: 'PENDING',
    nextStatus: 'FAILED',
    fields: {
      payment_gateway_status: status,
      eganow_reference: result.reference || null,
      eganow_transaction_id: result.transactionId || null,
      failure_reason: 'Eganow rejected the institution cash split payout.',
      completed_at: new Date()
    }
  })
  await updateTransactionStatus(query, {
    id: parentId,
    type: 'COLLECTION',
    currentStatus: 'SWEPT_INTERNAL',
    nextStatus: 'PARTIALLY_SETTLED',
    fields: {}
  })
  await updateInstitutionSweepStatus(query, {
    id: parentId,
    currentStatus: 'PENDING',
    nextStatus: 'PARTIALLY_SETTLED',
    fields: {
      institution_leg_status: 'FAILED',
      failure_reason: 'Eganow rejected the institution cash split payout.'
    }
  })
  return { failed: true, manualReviewRequired: true }
}

async function completeCashSweep(parentId, legId) {
  return withTransaction(async (tx) => {
    await tx.query('SELECT id FROM transactions WHERE id = $1 FOR UPDATE', [parentId])
    await updateTransactionStatus(tx, {
      id: parentId,
      type: 'COLLECTION',
      currentStatus: 'SWEPT_INTERNAL',
      nextStatus: 'PAID_OUT',
      fields: { completed_at: new Date() }
    })
    await updateInstitutionSweepStatus(tx, {
      id: parentId,
      currentStatus: 'PENDING',
      nextStatus: 'SETTLED',
      fields: { institution_leg_status: 'PAID_OUT' }
    })
    await applyInstitutionSplitRepayments(tx, parentId)
    await tx.query(
      `UPDATE periodic_accrual_ledger SET status = 'SWEPT', swept_at = now()
        WHERE swept_transaction_id = $1 AND source_credit_installment_id IS NOT NULL AND status = 'PENDING'`, [parentId]
    )
    return { settled: true, legId }
  })
}

export async function applyInstitutionSplitRepayments(tx, sweepTransactionId) {
  const { rows: sources } = await tx.query(
    `SELECT a.institution_id, a.source_transaction_id, a.source_credit_installment_id,
            round(a.accrued_amount * 100)::bigint AS amount_cents,
            COALESCE(cp.tenant_id, source.tenant_id) AS tenant_id,
            COALESCE(cp.customer_identifier, source.collection_msisdn) AS customer_identifier
       FROM periodic_accrual_ledger a
       LEFT JOIN transactions source ON source.id = a.source_transaction_id
       LEFT JOIN credit_plan_installments cpi ON cpi.id = a.source_credit_installment_id
       LEFT JOIN credit_plans cp ON cp.id = cpi.credit_plan_id
      WHERE a.swept_transaction_id = $1 AND a.status = 'PENDING'
        AND COALESCE(cp.customer_identifier, source.collection_msisdn) IS NOT NULL
      ORDER BY a.accrued_at, a.id`, [sweepTransactionId]
  )
  for (const source of sources) {
    const { rows: prior } = await tx.query(
      `SELECT 1 FROM institution_split_financial_allocations WHERE sweep_transaction_id = $1
        AND ((source_transaction_id = $2 AND $2::uuid IS NOT NULL) OR (source_credit_installment_id = $3 AND $3::uuid IS NOT NULL))`,
      [sweepTransactionId, source.source_transaction_id, source.source_credit_installment_id]
    )
    if (prior.length) continue
    let remaining = BigInt(source.amount_cents)
    const { rows: accounts } = await tx.query(
      `SELECT a.id, a.outstanding_cents,
              (SELECT min(i.due_date) FROM institution_loan_installments i
                WHERE i.account_id = a.id AND i.status <> 'PAID') AS next_due_date
         FROM institution_financial_accounts a
         JOIN institution_customers c ON c.id = a.customer_id AND c.institution_id = a.institution_id
         JOIN institution_financial_products p ON p.id = a.product_id AND p.product_type = 'LOAN'
         JOIN tenant_institution_links l ON l.institution_id = a.institution_id AND l.tenant_id = c.tenant_id
        WHERE a.institution_id = $1 AND c.tenant_id = $2 AND c.phone_number = $3
          AND c.is_active AND c.kyc_status = 'VERIFIED' AND a.status IN ('ACTIVE','OVERDUE')
          AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
          AND (SELECT count(*) FROM institution_customers cx WHERE cx.institution_id = $1 AND cx.tenant_id = $2 AND cx.phone_number = $3 AND cx.is_active AND cx.kyc_status = 'VERIFIED') = 1
        ORDER BY next_due_date NULLS LAST, a.created_at, a.id FOR UPDATE OF a`,
      [source.institution_id, source.tenant_id, source.customer_identifier]
    )
    for (const account of accounts) {
      if (remaining <= 0n) break
      const accountOutstanding = BigInt(account.outstanding_cents)
      const accountCapacity = remaining < accountOutstanding ? remaining : accountOutstanding
      if (accountCapacity <= 0n) continue
      const { rows: installments } = await tx.query(
        `SELECT id, amount_due_cents, amount_paid_cents FROM institution_loan_installments
          WHERE account_id = $1 AND status <> 'PAID' ORDER BY due_date, installment_number FOR UPDATE`, [account.id]
      )
      let accountPaid = 0n
      for (const installment of installments) {
        if (accountPaid >= accountCapacity) break
        const due = BigInt(installment.amount_due_cents) - BigInt(installment.amount_paid_cents)
        const available = accountCapacity - accountPaid
        const paid = available < due ? available : due
        if (paid <= 0n) continue
        const totalPaid = BigInt(installment.amount_paid_cents) + paid
        await tx.query(
          `UPDATE institution_loan_installments SET amount_paid_cents = $2,
              status = CASE WHEN $2 = amount_due_cents THEN 'PAID' ELSE 'PARTIALLY_PAID' END, updated_at = now()
            WHERE id = $1`, [installment.id, String(totalPaid)]
        )
        accountPaid += paid
      }
      if (!accountPaid) continue
      await tx.query(
        `UPDATE institution_financial_accounts a SET outstanding_cents = a.outstanding_cents - $2,
            status = CASE WHEN a.outstanding_cents = $2 THEN 'SETTLED'::institution_financial_account_status
              WHEN EXISTS (SELECT 1 FROM institution_loan_installments i WHERE i.account_id = a.id AND i.status = 'OVERDUE' AND i.amount_paid_cents < i.amount_due_cents)
                THEN 'OVERDUE'::institution_financial_account_status ELSE 'ACTIVE'::institution_financial_account_status END,
            updated_at = now() WHERE a.id = $1`, [account.id, String(accountPaid)]
      )
      await tx.query(
        `INSERT INTO institution_split_financial_allocations
          (institution_id, sweep_transaction_id, source_transaction_id, source_credit_installment_id, account_id, allocation_type, amount_cents)
         VALUES ($1,$2,$3,$4,$5,'LOAN_REPAYMENT',$6) ON CONFLICT DO NOTHING`,
        [source.institution_id, sweepTransactionId, source.source_transaction_id, source.source_credit_installment_id, account.id, String(accountPaid)]
      )
      remaining -= accountPaid
    }
    if (remaining > 0n) {
      const { rows: savingsAccounts } = await tx.query(
        `SELECT a.id FROM institution_financial_accounts a
         JOIN institution_customers c ON c.id = a.customer_id AND c.institution_id = a.institution_id
         JOIN institution_financial_products p ON p.id = a.product_id AND p.product_type = 'SAVINGS'
         JOIN tenant_institution_links l ON l.institution_id = a.institution_id AND l.tenant_id = c.tenant_id
        WHERE a.institution_id = $1 AND c.tenant_id = $2 AND c.phone_number = $3
          AND c.is_active AND c.kyc_status = 'VERIFIED' AND a.status IN ('APPROVED','ACTIVE')
          AND l.status = 'ACTIVE' AND l.verification_status = 'APPROVED'
          AND (SELECT count(*) FROM institution_customers cx WHERE cx.institution_id = $1 AND cx.tenant_id = $2 AND cx.phone_number = $3 AND cx.is_active AND cx.kyc_status = 'VERIFIED') = 1
        ORDER BY a.created_at, a.id FOR UPDATE OF a`,
        [source.institution_id, source.tenant_id, source.customer_identifier]
      )
      for (const account of savingsAccounts) {
        const allocation = remaining
        await tx.query(
          `UPDATE institution_financial_accounts SET balance_cents = balance_cents + $2, status = 'ACTIVE', updated_at = now()
            WHERE id = $1`, [account.id, allocation]
        )
        await tx.query(
          `INSERT INTO institution_split_financial_allocations
            (institution_id, sweep_transaction_id, source_transaction_id, source_credit_installment_id, account_id, allocation_type, amount_cents)
           VALUES ($1,$2,$3,$4,$5,'SAVINGS_CONTRIBUTION',$6) ON CONFLICT DO NOTHING`,
          [source.institution_id, sweepTransactionId, source.source_transaction_id, source.source_credit_installment_id, account.id, allocation]
        )
        remaining = 0
        break
      }
    }
  }
}

export async function runDueCreditCashSweeps() {
  await createCashSweepGroups()
  const { rows } = await query(
    `SELECT DISTINCT l.sweep_transaction_id
       FROM institution_sweep_ledger l
      WHERE l.sweep_transaction_id IS NOT NULL
        AND l.status IN ('PENDING', 'ACCRUED_UNSWEPT')
        AND EXISTS (SELECT 1 FROM periodic_accrual_ledger a
                     WHERE a.swept_transaction_id = l.sweep_transaction_id
                       AND a.source_credit_installment_id IS NOT NULL AND a.status = 'PENDING')
      ORDER BY l.sweep_transaction_id LIMIT 500`
  )
  const results = []
  for (const row of rows) results.push({ sweepId: row.sweep_transaction_id, ...(await processCashSweep(row.sweep_transaction_id)) })
  return results
}
