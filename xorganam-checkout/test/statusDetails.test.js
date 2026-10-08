import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyPaymentStatus } from '../src/lib/statusOutcome.js'

test('status details distinguish unknown, failed, partial, and manual reconciliation outcomes', () => {
  assert.equal(classifyPaymentStatus({ status: 'UNKNOWN' }).state, 'pending')
  assert.equal(classifyPaymentStatus({ status: 'FAILED' }).state, 'failed')
  assert.equal(classifyPaymentStatus({ status: 'PARTIALLY_SETTLED' }).state, 'partial')
  assert.equal(classifyPaymentStatus({ status: 'MANUAL_RECONCILIATION_REQUIRED' }).state, 'manual-reconciliation')
})

test('provider mismatches and blocked verification contain actionable guidance', () => {
  const mismatch = classifyPaymentStatus({ status: 'MANUAL_RECONCILIATION_REQUIRED', failureReason: 'Provider result mismatch.' })
  const blocked = classifyPaymentStatus({ status: 'VERIFICATION_BLOCKED', failureReason: 'Phone number does not match the customer.' })

  assert.match(mismatch.message, /manual reconciliation/i)
  assert.match(blocked.message, /Contact support/i)
})

test('status details give explicit retry timing for pending outcomes', () => {
  const pending = classifyPaymentStatus({ status: 'UNKNOWN' })
  assert.match(pending.message, /few minutes/i)
})
