import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  assertInstitutionFinancialTransactionStatusTransition,
  assertInstitutionTransactionStatusTransition
} = await import('../src/services/institutionStateService.js')

describe('institution status integrity', () => {
  it('allows each defined institution financial workflow transition', () => {
    assert.doesNotThrow(() => assertInstitutionFinancialTransactionStatusTransition({
      currentStatus: 'PENDING_APPROVAL',
      nextStatus: 'PENDING_GATEWAY'
    }))
    assert.doesNotThrow(() => assertInstitutionFinancialTransactionStatusTransition({
      currentStatus: 'PENDING_APPROVAL',
      nextStatus: 'REJECTED'
    }))
    assert.doesNotThrow(() => assertInstitutionFinancialTransactionStatusTransition({
      currentStatus: 'PENDING_GATEWAY',
      nextStatus: 'POSTED'
    }))
    assert.doesNotThrow(() => assertInstitutionFinancialTransactionStatusTransition({
      currentStatus: 'PENDING_GATEWAY',
      nextStatus: 'FAILED'
    }))
  })

  it('rejects illegal institution financial transitions', () => {
    assert.throws(() => assertInstitutionFinancialTransactionStatusTransition({
      currentStatus: 'POSTED',
      nextStatus: 'FAILED'
    }), /Illegal institution financial transaction status transition/)
    assert.throws(() => assertInstitutionFinancialTransactionStatusTransition({
      currentStatus: 'REJECTED',
      nextStatus: 'POSTED'
    }), /Illegal institution financial transaction status transition/)
  })

  it('allows each institution transaction workflow transition', () => {
    assert.doesNotThrow(() => assertInstitutionTransactionStatusTransition({
      currentStatus: 'PENDING',
      nextStatus: 'RECEIVED'
    }))
    assert.doesNotThrow(() => assertInstitutionTransactionStatusTransition({
      currentStatus: 'PENDING',
      nextStatus: 'PAID_OUT'
    }))
    assert.doesNotThrow(() => assertInstitutionTransactionStatusTransition({
      currentStatus: 'PENDING',
      nextStatus: 'FAILED'
    }))
  })

  it('rejects illegal institution transaction transitions', () => {
    assert.throws(() => assertInstitutionTransactionStatusTransition({
      currentStatus: 'PAID_OUT',
      nextStatus: 'FAILED'
    }), /Illegal institution transaction status transition/)
    assert.throws(() => assertInstitutionTransactionStatusTransition({
      currentStatus: 'RECEIVED',
      nextStatus: 'PENDING'
    }), /Illegal institution transaction status transition/)
  })
})
