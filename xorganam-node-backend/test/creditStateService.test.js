import assert from 'node:assert/strict'
import test from 'node:test'

const { assertCreditPlanStatusTransition, assertCreditInstallmentStatusTransition } = await import('../src/services/creditStateService.js')

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
