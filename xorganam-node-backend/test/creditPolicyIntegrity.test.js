import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  assertCreditPlanStatusTransition,
  assertCreditInstallmentStatusTransition,
  PREVENTED_CREDIT_PLAN_CANCELLATION
} = await import('../src/services/creditStateService.js')

describe('credit plan policy integrity', () => {
  it('allows cancellation only for active plans without settled obligations', () => {
    assert.doesNotThrow(() => assertCreditPlanStatusTransition({
      currentStatus: 'ACTIVE', nextStatus: 'CANCELLED'
    }))
    assert.throws(() => assertCreditPlanStatusTransition({
      currentStatus: 'COMPLETED', nextStatus: 'CANCELLED'
    }), /Illegal credit plan status transition/)
  })

  it('rejects a manual payment for a completed payment or terminal installment', () => {
    assert.doesNotThrow(() => assertCreditInstallmentStatusTransition({
      currentStatus: 'OVERDUE', nextStatus: 'PAID'
    }))
    assert.throws(() => assertCreditInstallmentStatusTransition({
      currentStatus: 'PAID', nextStatus: 'OVERDUE'
    }), /Illegal credit installment status transition/)
  })

  it('identifies cancellation policies that block invalid plan changes', () => {
    assert.equal(PREVENTED_CREDIT_PLAN_CANCELLATION.ACTIVE, false)
    assert.equal(PREVENTED_CREDIT_PLAN_CANCELLATION.COMPLETED, true)
    assert.equal(PREVENTED_CREDIT_PLAN_CANCELLATION.DEFAULTED, true)
  })
})
