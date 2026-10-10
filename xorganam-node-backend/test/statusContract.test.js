import assert from 'node:assert/strict'
import test from 'node:test'

const { TRANSACTION_STATUS_DEFINITIONS, normalizeTransactionStatus, isTerminalTransactionStatus, isSuccessfulTransactionStatus, isFailedTransactionStatus, isPendingTransactionStatus } = await import('../src/lib/statusContract.js')
const { assertTransactionStatusTransition } = await import('../src/services/transactionStateService.js')
const sharedStatusContract = await import('../../shared/paymentStatus.js')
const checkoutStatusContract = await import('../../xorganam-checkout/src/lib/statusContract.js')
const institutionStatusContract = await import('../../institution-portal/src/lib/statusContract.js')
const backofficeStatusContract = await import('../../backoffice-dashboard/src/lib/statusContract.js')

test('all frontends consume the shared payment status contract', () => {
  assert.equal(checkoutStatusContract.PAYMENT_STATUS_CONTRACT, sharedStatusContract.PAYMENT_STATUS_CONTRACT)
  assert.equal(institutionStatusContract.PAYMENT_STATUS_CONTRACT, sharedStatusContract.PAYMENT_STATUS_CONTRACT)
  assert.equal(backofficeStatusContract.PAYMENT_STATUS_CONTRACT, sharedStatusContract.PAYMENT_STATUS_CONTRACT)
  assert.equal(sharedStatusContract.normalizePaymentStatus('manual reconciliation required'), 'MANUAL_RECONCILIATION_REQUIRED')
})

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
