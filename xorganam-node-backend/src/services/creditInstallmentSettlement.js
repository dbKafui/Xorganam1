import { recordCreditWebhookEvent } from './creditWebhookOutbox.js'

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

  const paid = await tx.query(
    `UPDATE credit_plan_installments
        SET status = 'PAID', paid_transaction_id = $2, paid_at = now(),
            manually_recorded = FALSE, manually_recorded_by_user_id = NULL
      WHERE id = $1 AND status IN ('PENDING', 'OVERDUE')
      RETURNING id`, [context.credit_installment_id, context.transaction_id]
  )
  if (!paid.rows.length) return { tagged: true, completed: false }
  const { rows: remaining } = await tx.query(
    `SELECT COUNT(*)::int AS count FROM credit_plan_installments
      WHERE credit_plan_id = $1 AND status <> 'PAID'`, [context.credit_plan_id]
  )
  const completed = remaining[0].count === 0
  if (completed) await tx.query(`UPDATE credit_plans SET status = 'COMPLETED' WHERE id = $1`, [context.credit_plan_id])
  else if (context.plan_status !== 'DEFAULTED') {
    const overdue = await tx.query(`SELECT 1 FROM credit_plan_installments WHERE credit_plan_id = $1 AND status = 'OVERDUE' LIMIT 1`, [context.credit_plan_id])
    await tx.query(`UPDATE credit_plans SET status = $2 WHERE id = $1`, [context.credit_plan_id, overdue.rows.length ? 'OVERDUE' : 'ACTIVE'])
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
