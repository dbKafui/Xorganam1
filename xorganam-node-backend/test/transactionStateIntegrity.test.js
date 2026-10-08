import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { assertTransactionStatusTransition } = await import('../src/services/transactionStateService.js')
const { validateProviderResult } = await import('../src/services/providerResultValidation.js')

describe('transaction status integrity', () => {
  it('allows each financial workflow transition', () => {
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'COLLECTION', currentStatus: 'PENDING', nextStatus: 'RECEIVED' }))
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'COLLECTION', currentStatus: 'PENDING', nextStatus: 'FAILED' }))
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'COLLECTION', currentStatus: 'RECEIVED', nextStatus: 'SWEPT_INTERNAL' }))
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'PAYOUT', currentStatus: 'PENDING', nextStatus: 'PAID_OUT' }))
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'PAYOUT', currentStatus: 'PENDING', nextStatus: 'FAILED' }))
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'INTERNAL_TRANSFER', currentStatus: 'PENDING', nextStatus: 'SWEPT_INTERNAL' }))
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'COLLECTION', currentStatus: 'SWEPT_INTERNAL', nextStatus: 'PARTIALLY_SETTLED' }))
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'COLLECTION', currentStatus: 'PARTIALLY_SETTLED', nextStatus: 'PAID_OUT' }))
  })

  it('validates the provider result against the expected transaction', () => {
    assert.deepEqual(validateProviderResult({
      expectedAmount: '12.34',
      expectedCurrency: 'GHS',
      expectedReference: 'TX-123',
      actualAmount: '12.34',
      actualCurrency: 'GHS',
      actualReference: 'TX-123'
    }), { valid: true, mismatches: [] })

    assert.deepEqual(validateProviderResult({
      expectedAmount: '12.34',
      expectedCurrency: 'GHS',
      expectedReference: 'TX-123',
      actualAmount: '13.00',
      actualCurrency: 'GHS',
      actualReference: 'TX-123'
    }), { valid: false, mismatches: ['amount'] })

    assert.deepEqual(validateProviderResult({
      expectedAmount: '12.34',
      expectedCurrency: 'GHS',
      expectedReference: 'TX-123',
      actualAmount: '12.34',
      actualCurrency: 'USD',
      actualReference: 'TX-123'
    }), { valid: false, mismatches: ['currency'] })

    assert.deepEqual(validateProviderResult({
      expectedAmount: '12.34',
      expectedCurrency: 'GHS',
      expectedReference: 'TX-123',
      actualAmount: '12.34',
      actualCurrency: 'GHS',
      actualReference: 'TX-456'
    }), { valid: false, mismatches: ['reference'] })
  })

  it('rejects illegal state transitions and duplicate terminal writes', () => {
    assert.throws(() => assertTransactionStatusTransition({ type: 'COLLECTION', currentStatus: 'FAILED', nextStatus: 'RECEIVED' }), /Illegal transaction status transition/)
    assert.throws(() => assertTransactionStatusTransition({ type: 'PAYOUT', currentStatus: 'PAID_OUT', nextStatus: 'FAILED' }), /Illegal transaction status transition/)
    assert.throws(() => assertTransactionStatusTransition({ type: 'PAYOUT', currentStatus: 'PENDING', nextStatus: 'RECEIVED' }), /Illegal transaction status transition/)
    assert.throws(() => assertTransactionStatusTransition({ type: 'COLLECTION', currentStatus: 'PAID_OUT', nextStatus: 'PARTIALLY_SETTLED' }), /Illegal transaction status transition/)
  })

  it('rejects unknown transaction types or statuses', () => {
    assert.throws(() => assertTransactionStatusTransition({ type: 'UNKNOWN', currentStatus: 'PENDING', nextStatus: 'RECEIVED' }), /Unknown transaction type/)
    assert.throws(() => assertTransactionStatusTransition({ type: 'COLLECTION', currentStatus: 'UNKNOWN', nextStatus: 'RECEIVED' }), /Unknown transaction status/)
  })
})
