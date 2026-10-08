import assert from 'node:assert/strict'
import test from 'node:test'

const {
  assertCreditPlanStatusTransition,
  assertCreditInstallmentStatusTransition,
  updateCreditPlanStatus,
  updateCreditInstallmentStatus
} = await import('../src/services/creditStateService.js')
const { createManualCreditCollectionTransaction } = await import('../src/services/creditInstallmentSettlement.js')

test('allows the credit plan lifecycle transitions used by the application', () => {
  assert.doesNotThrow(() => assertCreditPlanStatusTransition({ currentStatus: 'ACTIVE', nextStatus: 'OVERDUE' }))
  assert.doesNotThrow(() => assertCreditPlanStatusTransition({ currentStatus: 'OVERDUE', nextStatus: 'ACTIVE' }))
  assert.doesNotThrow(() => assertCreditPlanStatusTransition({ currentStatus: 'ACTIVE', nextStatus: 'COMPLETED' }))
  assert.doesNotThrow(() => assertCreditPlanStatusTransition({ currentStatus: 'ACTIVE', nextStatus: 'DEFAULTED' }))
  assert.doesNotThrow(() => assertCreditPlanStatusTransition({ currentStatus: 'ACTIVE', nextStatus: 'CANCELLED' }))
})

test('rejects illegal credit plan and installment transitions', () => {
  assert.throws(() => assertCreditPlanStatusTransition({ currentStatus: 'COMPLETED', nextStatus: 'ACTIVE' }), /Illegal credit plan status transition/)
  assert.throws(() => assertCreditPlanStatusTransition({ currentStatus: 'PENDING', nextStatus: 'OVERDUE' }), /Unknown credit plan status/)
  assert.throws(() => assertCreditInstallmentStatusTransition({ currentStatus: 'PAID', nextStatus: 'OVERDUE' }), /Illegal credit installment status transition/)
})

test('creates a traceable manual collection transaction for an installment payment', async () => {
  const calls = []
  const tx = {
    async query(text, params = []) {
      calls.push({ text, params })
      if (text.includes('INSERT INTO transactions')) {
        return {
          rows: [{ id: 'c-transaction', internal_reference: 'MANUAL-COL-123', status: 'PENDING', payment_gateway_status: 'MANUAL' }]
        }
      }
      return {
        rows: [{ id: 'c-transaction', type: 'COLLECTION', status: 'RECEIVED' }]
      }
    }
  }

  const result = await createManualCreditCollectionTransaction(tx, {
    tenantId: 'tenant-1',
    merchantId: 'merchant-1',
    amount: 75.5,
    planId: 'plan-1',
    installmentId: 'installment-1',
    initiatedByUserId: 'user-1',
    internalReference: 'MANUAL-COL-123'
  })

  assert.deepEqual(result, { id: 'c-transaction', internal_reference: 'MANUAL-COL-123', status: 'RECEIVED', payment_gateway_status: 'MANUAL' })
  assert.equal(calls.length, 2)
  assert.match(calls[0].text, /INSERT INTO transactions/)
  assert.match(calls[0].text, /'PENDING'/)
  assert.deepEqual(calls[0].params, ['tenant-1', 'merchant-1', 75.5, 'MANUAL-COL-123', 'plan-1', 'installment-1', 'user-1'])
  assert.match(calls[1].text, /UPDATE transactions/)
  assert.deepEqual(calls[1].params, ['c-transaction', 'RECEIVED', 'PENDING'])
})

test('binds credit plan status fields after the expected current status', async () => {
  let call
  const client = {
    async query(sql, params) {
      call = { sql, params }
      return { rows: [{ id: 'plan-1', status: 'OVERDUE' }] }
    }
  }

  await updateCreditPlanStatus(client, {
    id: 'plan-1', currentStatus: 'ACTIVE', nextStatus: 'OVERDUE', fields: { late_fee_amount: 5 }
  })

  assert.match(call.sql, /WHERE id = \$1 AND status = \$3/)
  assert.match(call.sql, /late_fee_amount = \$4/)
  assert.deepEqual(call.params, ['plan-1', 'OVERDUE', 'ACTIVE', 5])
})

test('binds installment status fields after the expected current status', async () => {
  let call
  const client = {
    async query(sql, params) {
      call = { sql, params }
      return { rows: [{ id: 'installment-1', status: 'PAID' }] }
    }
  }

  await updateCreditInstallmentStatus(client, {
    id: 'installment-1', currentStatus: 'PENDING', nextStatus: 'PAID', fields: { paid_at: 'now' }
  })

  assert.match(call.sql, /WHERE id = \$1 AND status = \$3/)
  assert.match(call.sql, /paid_at = \$4/)
  assert.deepEqual(call.params, ['installment-1', 'PAID', 'PENDING', 'now'])
})
