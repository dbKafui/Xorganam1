import { recordCreditWebhookEvent } from './creditWebhookOutbox.js'
import { updateCreditInstallmentStatus, updateCreditPlanStatus } from './creditStateService.js'
import { updateTransactionStatus } from './transactionStateService.js'
import { createVendorReference } from './referenceIds.js'

export async function createManualCreditCollectionTransaction(tx, {
  tenantId,
  merchantId,
  amount,
  planId,
  installmentId,
  initiatedByUserId,
  internalReference = createVendorReference('MANUAL', 'COL')
}) {
  const { rows } = await tx.query(
    `INSERT INTO transactions
       (tenant_id, merchant_id, type, status, amount, currency, internal_reference,
        payment_gateway_status, credit_plan_id, credit_installment_id,
        initiated_by_user_id, manually_triggered)
     VALUES ($1, $2, 'COLLECTION', 'PENDING', $3, 'GHS', $4, 'MANUAL', $5, $6, $7, TRUE)
     RETURNING id, internal_reference, status, payment_gateway_status`,
    [tenantId, merchantId, amount, internalReference, planId, installmentId, initiatedByUserId]
  )
  const transaction = rows[0]
  const finalized = await updateTransactionStatus(tx, {
    id: transaction.id,
    type: 'COLLECTION',
    currentStatus: transaction.status,
    nextStatus: 'RECEIVED'
  })
  return { ...transaction, status: finalized.status }
}

export async function markCreditInstallmentCollected(tx, collectionTransactionId) {
  const { rows } = await tx.query(
    `SELECT t.id AS transaction_id, t.tenant_id, t.merchant_id, t.credit_plan_id, t.credit_installment_id,
            p.status AS plan_status, i.installment_number, i.amount_due, i.status AS installment_status
       FROM transactions t
       JOIN credit_plans p ON p.id = t.credit_plan_id AND p.tenant_id = t.tenant_id AND p.merchant_id = t.merchant_id
       JOIN credit_plan_installments i ON i.id = t.credit_installment_id AND i.credit_plan_id = p.id
      WHERE t.id = $1 AND t.type = 'COLLECTION' AND t.credit_installment_id IS NOT NULL
      FOR UPDATE OF p, i`, [collectionTransactionId]
  )
  const context = rows[0]
  if (!context || context.installment_status === 'PAID') return { tagged: Boolean(context), completed: false }

  const paid = await updateCreditInstallmentStatus(tx, {
    id: context.credit_installment_id,
    currentStatus: context.installment_status,
    nextStatus: 'PAID',
    fields: {
      paid_transaction_id: context.transaction_id,
      paid_at: new Date(),
      manually_recorded: false,
      manually_recorded_by_user_id: null
    }
  })
  if (!paid) return { tagged: true, completed: false }
  const { rows: remaining } = await tx.query(
    `SELECT COUNT(*)::int AS count FROM credit_plan_installments
      WHERE credit_plan_id = $1 AND status <> 'PAID'`, [context.credit_plan_id]
  )
  const completed = remaining[0].count === 0
  if (completed) await updateCreditPlanStatus(tx, {
    id: context.credit_plan_id,
    currentStatus: context.plan_status,
    nextStatus: 'COMPLETED'
  })
  else if (context.plan_status !== 'DEFAULTED') {
    const overdue = await tx.query(`SELECT 1 FROM credit_plan_installments WHERE credit_plan_id = $1 AND status = 'OVERDUE' LIMIT 1`, [context.credit_plan_id])
    await updateCreditPlanStatus(tx, {
      id: context.credit_plan_id,
      currentStatus: context.plan_status,
      nextStatus: overdue.rows.length ? 'OVERDUE' : 'ACTIVE'
    })
  }

  const payload = {
    planId: context.credit_plan_id,
    installmentId: context.credit_installment_id,
    installmentNumber: context.installment_number,
    merchantId: context.merchant_id,
    amount: Number(context.amount_due),
    transactionId: context.transaction_id,
    status: 'PAID',
    manuallyRecorded: false
  }
  await recordCreditWebhookEvent(tx, {
    tenantId: context.tenant_id, merchantId: context.merchant_id,
    eventType: 'installment.paid', eventKey: `installment.paid:${context.credit_installment_id}`, payload
  })
  if (completed) await recordCreditWebhookEvent(tx, {
    tenantId: context.tenant_id, merchantId: context.merchant_id,
    eventType: 'plan.completed', eventKey: `plan.completed:${context.credit_plan_id}`,
    payload: { planId: context.credit_plan_id, merchantId: context.merchant_id, status: 'COMPLETED' }
  })
  return { tagged: true, completed }
}
