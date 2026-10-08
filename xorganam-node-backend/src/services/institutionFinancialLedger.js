import { query, withTransaction } from '../db/pool.js'
import { updateInstitutionFinancialTransactionStatus, updateInstitutionTransactionStatus } from './institutionStateService.js'

async function postSuccess(transactionId, gatewayResult) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT t.*, a.product_type, a.balance_cents, a.outstanding_cents, a.term_days, a.maturity_date,
              p.annual_rate_basis_points, p.loan_interest_model, p.repayment_frequency
         FROM institution_financial_transactions t
         JOIN institution_financial_accounts a ON a.id = t.account_id AND a.institution_id = t.institution_id
         JOIN institution_financial_products p ON p.id = a.product_id
        WHERE t.id = $1 AND t.status = 'PENDING_GATEWAY' FOR UPDATE OF t, a`, [transactionId]
    )
    if (!rows.length) return { alreadyProcessed: true }
    const item = rows[0]
    const amount = Number(item.amount_cents)
    const available = ['SAVINGS', 'INVESTMENT'].includes(item.product_type) ? Number(item.balance_cents) : Number(item.outstanding_cents)
    if (item.transaction_type === 'DEPOSIT') {
      await tx.query(`UPDATE institution_financial_accounts SET balance_cents = balance_cents + $2, status = 'ACTIVE', updated_at = now() WHERE id = $1`, [item.account_id, amount])
    } else if (item.transaction_type === 'WITHDRAWAL') {
      if (amount > available) throw new Error('Savings balance changed before withdrawal settlement.')
      await tx.query('UPDATE institution_financial_accounts SET balance_cents = balance_cents - $2, updated_at = now() WHERE id = $1', [item.account_id, amount])
    } else if (item.transaction_type === 'LOAN_DISBURSEMENT') {
      if (!item.loan_interest_model || !item.repayment_frequency || !item.term_days) throw new Error('Loan repayment schedule policy is incomplete.')
      const schedule = buildLoanSchedule({ principalCents: amount, annualRateBasisPoints: Number(item.annual_rate_basis_points),
        interestModel: item.loan_interest_model, frequency: item.repayment_frequency, termDays: Number(item.term_days), startDate: new Date() })
      for (const installment of schedule.installments) await tx.query(
        `INSERT INTO institution_loan_installments
          (institution_id, account_id, installment_number, due_date, amount_due_cents)
         VALUES ($1,$2,$3,$4,$5)`,
        [item.institution_id, item.account_id, installment.number, installment.dueDate, installment.amountCents]
      )
      await tx.query(
        `UPDATE institution_financial_accounts SET status = 'ACTIVE', contractual_due_cents = $2,
            outstanding_cents = $2, disbursed_at = now(), disbursement_transaction_id = $3, updated_at = now()
          WHERE id = $1`, [item.account_id, schedule.totalDueCents, transactionId]
      )
    } else if (item.transaction_type === 'LOAN_REPAYMENT') {
      if (amount > available) throw new Error('Repayment exceeds the remaining principal balance.')
      let remaining = amount
      const { rows: installments } = await tx.query(
        `SELECT id, amount_due_cents, amount_paid_cents FROM institution_loan_installments
          WHERE account_id = $1 AND status <> 'PAID' ORDER BY installment_number FOR UPDATE`, [item.account_id]
      )
      for (const installment of installments) {
        if (!remaining) break
        const due = Number(installment.amount_due_cents) - Number(installment.amount_paid_cents)
        const paid = Math.min(remaining, due)
        const next = Number(installment.amount_paid_cents) + paid
        await tx.query(
          `UPDATE institution_loan_installments SET amount_paid_cents = $2,
              status = CASE WHEN $2 = amount_due_cents THEN 'PAID' ELSE 'PARTIALLY_PAID' END, updated_at = now()
            WHERE id = $1`, [installment.id, next]
        )
        remaining -= paid
      }
      if (remaining > 0) throw new Error('Repayment amount exceeds the unpaid installment schedule.')
      await tx.query(
        `UPDATE institution_financial_accounts a SET outstanding_cents = a.outstanding_cents - $2,
            status = CASE WHEN a.outstanding_cents = $2 THEN 'SETTLED'::institution_financial_account_status
              WHEN EXISTS (SELECT 1 FROM institution_loan_installments i WHERE i.account_id = a.id AND i.status = 'OVERDUE' AND i.amount_paid_cents < i.amount_due_cents)
                THEN 'OVERDUE'::institution_financial_account_status
              ELSE 'ACTIVE'::institution_financial_account_status END,
            updated_at = now() WHERE a.id = $1`, [item.account_id, amount]
      )
    }
    const { rows: updated } = await updateInstitutionFinancialTransactionStatus(tx, {
      id: transactionId,
      institutionId: item.institution_id,
      currentStatus: 'PENDING_GATEWAY',
      nextStatus: 'POSTED',
      fields: {
        payment_gateway_status: gatewayResult.status,
        gateway_reference: gatewayResult.reference || null,
        gateway_transaction_id: gatewayResult.transactionId || null
      }
    })
    const institutionTransactionId = await tx.query(
      `SELECT id, status FROM institution_transactions
        WHERE internal_reference = $1 AND institution_id = $2`,
      [item.external_reference, item.institution_id]
    )
    if (institutionTransactionId.rows[0]) {
      await updateInstitutionTransactionStatus(tx, {
        id: institutionTransactionId.rows[0].id,
        institutionId: item.institution_id,
        currentStatus: institutionTransactionId.rows[0].status,
        nextStatus: item.transaction_type === 'LOAN_DISBURSEMENT' || item.transaction_type === 'WITHDRAWAL' ? 'PAID_OUT' : 'RECEIVED',
        fields: {
          eganow_reference: gatewayResult.reference || null
        }
      })
    }
    return { transaction: updated[0] }
  })
}

function buildLoanSchedule({ principalCents, annualRateBasisPoints, interestModel, frequency, termDays, startDate }) {
  const intervalDays = frequency === 'WEEKLY' ? 7 : 365 / 12
  const count = Math.max(1, Math.ceil(termDays / intervalDays))
  const periodicRate = annualRateBasisPoints / 10000 / (frequency === 'WEEKLY' ? 52 : 12)
  const start = new Date(startDate)
  const installments = []
  let balance = principalCents

  if (interestModel === 'FLAT') {
    const totalInterest = Math.round(principalCents * annualRateBasisPoints / 10000 * termDays / 365)
    const totalDueCents = principalCents + totalInterest
    const regularAmount = Math.floor(totalDueCents / count)
    let allocated = 0
    for (let index = 1; index <= count; index++) {
      const amountCents = index === count ? totalDueCents - allocated : regularAmount
      allocated += amountCents
      installments.push({ number: index, dueDate: scheduleDate(start, index, frequency, termDays), amountCents })
    }
    return { installments, totalDueCents }
  }

  const payment = periodicRate === 0 ? principalCents / count
    : principalCents * periodicRate / (1 - (1 + periodicRate) ** -count)
  let totalDueCents = 0
  for (let index = 1; index <= count; index++) {
    const interest = Math.round(balance * periodicRate)
    const principal = index === count ? balance : Math.min(balance, Math.max(0, Math.round(payment) - interest))
    const amountCents = principal + interest
    balance -= principal
    totalDueCents += amountCents
    installments.push({ number: index, dueDate: scheduleDate(start, index, frequency, termDays), amountCents })
  }
  return { installments, totalDueCents }
}

function scheduleDate(start, index, frequency, termDays) {
  const date = new Date(start)
  if (frequency === 'WEEKLY') date.setUTCDate(date.getUTCDate() + Math.min(index * 7, termDays))
  else date.setUTCDate(date.getUTCDate() + Math.min(Math.round(index * 365 / 12), termDays))
  return date.toISOString().slice(0, 10)
}

export async function reconcileInstitutionTransaction(institutionId, transactionId, gatewayResult) {
  const status = String(gatewayResult?.status || '').toLowerCase()
  if (['success', 'successful', 'completed'].includes(status)) return postSuccess(transactionId, gatewayResult)
  if (['failed', 'failure', 'declined', 'expired', 'cancelled', 'canceled', 'rejected'].includes(status)) {
    const { rows } = await updateInstitutionFinancialTransactionStatus(query, {
      id: transactionId,
      institutionId,
      currentStatus: 'PENDING_GATEWAY',
      nextStatus: 'FAILED',
      fields: {
        payment_gateway_status: status,
        gateway_reference: gatewayResult.reference || null,
        gateway_transaction_id: gatewayResult.transactionId || null,
        failure_reason: gatewayResult.message || 'Eganow rejected the transaction.'
      }
    })
    if (rows[0]) {
      const institutionTransaction = await query(
        `SELECT id, status FROM institution_transactions
          WHERE internal_reference = $1 AND institution_id = $2`,
        [rows[0].external_reference, institutionId]
      )
      if (institutionTransaction.rows[0]) {
        await updateInstitutionTransactionStatus(query, {
          id: institutionTransaction.rows[0].id,
          institutionId,
          currentStatus: institutionTransaction.rows[0].status,
          nextStatus: 'FAILED',
          fields: { eganow_reference: gatewayResult.reference || null }
        })
      }
    }
    return { transaction: rows[0] || null }
  }
  const { rows } = await updateInstitutionFinancialTransactionStatus(query, {
    id: transactionId,
    institutionId,
    currentStatus: 'PENDING_GATEWAY',
    nextStatus: 'PENDING_GATEWAY',
    fields: {
      payment_gateway_status: status || 'PENDING',
      gateway_reference: gatewayResult.reference || null,
      gateway_transaction_id: gatewayResult.transactionId || null
    }
  })
  return { transaction: rows[0] || null, pending: true }
}

export async function institutionTransactionByReference(institutionId, reference) {
  const { rows } = await query(
    `SELECT id, status, transaction_type, amount_cents, fee_cents, payout_amount_cents, payment_gateway_status
       FROM institution_financial_transactions WHERE institution_id = $1 AND external_reference = $2`,
    [institutionId, reference]
  )
  return rows[0] || null
}
