import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL ??= 'postgresql://localhost/test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY ??= 'test-key'
process.env.JWT_SECRET ??= 'test-secret'

const {
  assertStorefrontOrderCancellationAllowed,
  PREVENTED_ORDER_CANCELLATION_STATUS,
  isOrderPaymentSafeToCancel,
  isOrderCancellationSafe
} = await import('../src/services/storefrontOrderService.js')

describe('storefront order policy integrity', () => {
  it('allows cancellation only for order states that have not been fulfilled or settled', () => {
    assert.equal(assertStorefrontOrderCancellationAllowed('PENDING_PAYMENT'), true)
    assert.equal(assertStorefrontOrderCancellationAllowed('PLACED'), true)
    assert.equal(assertStorefrontOrderCancellationAllowed('FULFILLED'), false)
    assert.equal(assertStorefrontOrderCancellationAllowed('CANCELLED'), false)
  })

  it('blocks cancellation when the order has an active payment or reconciliation requirement', () => {
    assert.equal(PREVENTED_ORDER_CANCELLATION_STATUS.PENDING_PAYMENT, false)
    assert.equal(PREVENTED_ORDER_CANCELLATION_STATUS.FULFILLED, true)
    assert.equal(PREVENTED_ORDER_CANCELLATION_STATUS.CANCELLED, true)
  })

  it('releases stock only when no payment exists or payment failure is confirmed', () => {
    assert.equal(isOrderPaymentSafeToCancel(null), true)
    assert.equal(isOrderPaymentSafeToCancel(undefined), true)
    assert.equal(isOrderPaymentSafeToCancel('FAILED'), true)
    for (const status of ['PENDING', 'RECEIVED', 'SWEPT_INTERNAL', 'PARTIALLY_SETTLED', 'PAID_OUT', 'UNKNOWN']) {
      assert.equal(isOrderPaymentSafeToCancel(status), false, `${status} must retain its reservation`)
    }
  })

  it('requires a clean reconciliation and unpaid cancellable credit plan before release', () => {
    assert.equal(isOrderCancellationSafe({ paymentStatus: null }), true)
    assert.equal(isOrderCancellationSafe({ paymentStatus: 'FAILED', unresolvedReconciliation: true }), false)
    assert.equal(isOrderCancellationSafe({ paymentStatus: null, creditPlanStatus: 'COMPLETED' }), false)
    assert.equal(isOrderCancellationSafe({ paymentStatus: null, creditPlanStatus: 'ACTIVE', hasPaidInstallments: true }), false)
    assert.equal(isOrderCancellationSafe({ paymentStatus: null, creditPlanStatus: 'ACTIVE', hasPaidInstallments: false }), true)
  })
})
