import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  assertInstitutionFinancialTransactionStatusTransition,
  assertInstitutionTransactionStatusTransition
} = await import('../src/services/institutionStateService.js')

describe('institution status boundary enforcement', () => {
  it('rejects illegal financial transitions before any SQL update', () => {
    assert.throws(
      () => assertInstitutionFinancialTransactionStatusTransition({
        currentStatus: 'POSTED',
        nextStatus: 'FAILED'
      }),
      /Illegal institution financial transaction status transition/
    )
  })

  it('rejects illegal institution transaction transitions before any SQL update', () => {
    assert.throws(
      () => assertInstitutionTransactionStatusTransition({
        currentStatus: 'PAID_OUT',
        nextStatus: 'FAILED'
      }),
      /Illegal institution transaction status transition/
    )
  })
})
