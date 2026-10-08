import assert from 'node:assert/strict'
import test from 'node:test'

const { TRANSACTION_STATUS_DEFINITIONS, normalizeTransactionStatus, isTerminalTransactionStatus, isSuccessfulTransactionStatus, isFailedTransactionStatus, isPendingTransactionStatus } = await import('../src/lib/statusContract.js')
const { assertTransactionStatusTransition } = await import('../src/services/transactionStateService.js')

test('defines the canonical transaction status contract', () => {
  assert.deepEqual(TRANSACTION_STATUS_DEFINITIONS.PENDING, {
    value: 'PENDING',
    category: 'pending',
    terminal: false,
    supportsFailure: true
  })
  assert.equal(normalizeTransactionStatus('pending'), 'PENDING')
  assert.equal(normalizeTransactionStatus('partially_settled'), 'PARTIALLY_SETTLED')
  assert.equal(isTerminalTransactionStatus('PAID_OUT'), true)
  assert.equal(isTerminalTransactionStatus('UNKNOWN'), false)
})

test('classifies transaction outcomes using canonical contract buckets', () => {
  assert.equal(isSuccessfulTransactionStatus('RECEIVED'), true)
  assert.equal(isSuccessfulTransactionStatus('PARTIALLY_SETTLED'), true)
  assert.equal(isSuccessfulTransactionStatus('VERIFICATION_BLOCKED'), false)
  assert.equal(isFailedTransactionStatus('FAILED'), true)
  assert.equal(isFailedTransactionStatus('REJECTED'), true)
  assert.equal(isFailedTransactionStatus('PENDING'), false)
  assert.equal(isPendingTransactionStatus('UNKNOWN'), true)
  assert.equal(isPendingTransactionStatus('VERIFICATION_BLOCKED'), true)
  assert.equal(isPendingTransactionStatus('PAID_OUT'), false)
})

test('accepts the shared state graph used by the frontends', () => {
  assert.doesNotThrow(() => assertTransactionStatusTransition({
    type: 'COLLECTION',
    currentStatus: 'PENDING',
    nextStatus: 'RECEIVED'
  }))
  assert.doesNotThrow(() => assertTransactionStatusTransition({
    type: 'COLLECTION',
    currentStatus: 'SWEPT_INTERNAL',
    nextStatus: 'PARTIALLY_SETTLED'
  }))
  assert.doesNotThrow(() => assertTransactionStatusTransition({
    type: 'COLLECTION',
    currentStatus: 'PARTIALLY_SETTLED',
    nextStatus: 'PAID_OUT'
  }))
  assert.doesNotThrow(() => assertTransactionStatusTransition({
    type: 'PAYOUT',
    currentStatus: 'PENDING',
    nextStatus: 'FAILED'
  }))
})
