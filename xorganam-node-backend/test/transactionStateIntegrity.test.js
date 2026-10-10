import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { assertTransactionStatusTransition, retryFailedSplitPayout } = await import('../src/services/transactionStateService.js')
const { validateProviderResult } = await import('../src/services/providerResultValidation.js')

describe('transaction status integrity', () => {
  it('allows each financial workflow transition', () => {
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'COLLECTION', currentStatus: 'PENDING', nextStatus: 'RECEIVED' }))
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'COLLECTION', currentStatus: 'PENDING', nextStatus: 'FAILED' }))
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'COLLECTION', currentStatus: 'RECEIVED', nextStatus: 'SWEPT_INTERNAL' }))
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'PAYOUT', currentStatus: 'PENDING', nextStatus: 'PAID_OUT' }))
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'PAYOUT', currentStatus: 'PENDING', nextStatus: 'FAILED' }))
    assert.doesNotThrow(() => assertTransactionStatusTransition({ type: 'PAYOUT', currentStatus: 'FAILED', nextStatus: 'PENDING' }))
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

    assert.deepEqual(validateProviderResult({
      expectedAmount: '90071992547409.91',
      expectedCurrency: 'GHS',
      expectedReference: 'TX-LARGE',
      actualAmount: '90071992547409.91',
      actualCurrency: 'GHS',
      actualReference: 'TX-LARGE'
    }), { valid: true, mismatches: [] })

    assert.deepEqual(validateProviderResult({
      expectedAmount: '12.34',
      expectedCurrency: 'GHS',
      expectedReference: 'TX-123',
      actualAmount: '12.345',
      actualCurrency: 'GHS',
      actualReference: 'TX-123'
    }), { valid: false, mismatches: ['amount'] })
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

  it('reopens failed split payouts only with a new reference and bounded retry count', async () => {
    const calls = []
    const client = {
      async query(sql, params) {
        calls.push({ sql, params })
        if (sql.includes('SELECT status, payout_leg')) {
          return { rows: [{ status: 'FAILED', payout_leg: 'VENDOR', payout_retry_count: 2, internal_reference: 'old-ref' }] }
        }
        return { rows: [{ id: 'payout-1', type: 'PAYOUT', status: 'PENDING' }] }
      }
    }

    const retry = await retryFailedSplitPayout(client, { id: 'payout-1', internalReference: 'new-ref' })

    assert.equal(retry.status, 'PENDING')
    assert.equal(retry.retryCount, 3)
    assert.equal(retry.internalReference, 'new-ref')
    assert.match(calls[1].sql, /WHERE id = \$1 AND status = \$3/)
    assert.match(calls[1].sql, /payout_retry_count = \$4/)
    assert.deepEqual(calls[1].params, [
      'payout-1', 'PENDING', 'FAILED', 3, 'new-ref', 'READY', null, null, null, null
    ])
  })

  it('does not reopen split payouts after the retry limit', async () => {
    let updateCount = 0
    const client = {
      async query(sql) {
        if (sql.includes('SELECT status, payout_leg')) {
          return { rows: [{ status: 'FAILED', payout_leg: 'INSTITUTION', payout_retry_count: 5, internal_reference: 'old-ref' }] }
        }
        updateCount += 1
        return { rows: [] }
      }
    }

    const retry = await retryFailedSplitPayout(client, { id: 'payout-1', internalReference: 'new-ref' })
    assert.deepEqual(retry, { exhausted: true, retryCount: 5 })
    assert.equal(updateCount, 0)
  })
})
