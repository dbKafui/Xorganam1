import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyPaymentStatus } from '../src/lib/statusOutcome.js'

test('classifies completed and partially settled outcomes', () => {
  assert.equal(classifyPaymentStatus({ status: 'RECEIVED' }).state, 'success')
  assert.equal(classifyPaymentStatus({ status: 'PARTIALLY_SETTLED' }).state, 'partial')
  assert.equal(classifyPaymentStatus({ status: 'PAID_OUT' }).state, 'success')
})

test('classifies blocked, failed, and manual reconciliation outcomes', () => {
  assert.equal(classifyPaymentStatus({ status: 'FAILED', failureReason: 'declined' }).state, 'failed')
  assert.equal(classifyPaymentStatus({ status: 'PENDING', failureReason: 'verification blocked' }).state, 'blocked')
  assert.equal(classifyPaymentStatus({ status: 'PENDING', failureReason: 'Provider result mismatch for amount. Reconcile manually before retrying.' }).state, 'manual-reconciliation')
})

test('treats stale pending and unknown results as pending with a recovery message', () => {
  assert.equal(classifyPaymentStatus({ status: 'PENDING' }).state, 'pending')
  assert.equal(classifyPaymentStatus({ status: 'UNKNOWN' }).state, 'pending')
})
