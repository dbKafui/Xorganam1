import { normalizePaymentStatus } from './statusContract.js'

const SUCCESS_STATUS = new Set(['RECEIVED', 'PAID_OUT', 'SWEPT_INTERNAL'])
const PARTIAL_STATUS = new Set(['PARTIALLY_SETTLED'])
const FAILURE_STATUS = new Set(['FAILED', 'REJECTED'])
const BLOCKED_STATUS = new Set(['VERIFICATION_BLOCKED'])
const MANUAL_RECONCILIATION_STATUS = new Set(['MANUAL_RECONCILIATION_REQUIRED'])

function hasManualReconciliationReason(failureReason = '') {
  return /provider result mismatch|reconcile manually before retrying/i.test(failureReason)
}

export function classifyPaymentStatus({ status, failureReason = '' } = {}) {
  const normalizedStatus = normalizePaymentStatus(status)

  if (SUCCESS_STATUS.has(normalizedStatus)) return {
    state: 'success',
    title: 'Payment completed',
    message: failureReason || 'Your payment was completed successfully.'
  }

  if (PARTIAL_STATUS.has(normalizedStatus)) return {
    state: 'partial',
    title: 'Payment partially completed',
    message: 'Part of this payment completed. Contact support or use the reconciliation details before retrying.'
  }

  if (FAILURE_STATUS.has(normalizedStatus)) return {
    state: 'failed',
    title: 'Payment could not continue',
    message: failureReason || 'Payment was declined or cancelled.'
  }

  if (BLOCKED_STATUS.has(normalizedStatus)) {
    const message = failureReason
      ? `${failureReason} Contact support with your payment reference for assistance.`
      : 'Payment verification is blocked. Contact support with your payment reference.'

    return {
      state: 'blocked',
      title: 'Payment verification blocked',
      message
    }
  }

  if (MANUAL_RECONCILIATION_STATUS.has(normalizedStatus) || hasManualReconciliationReason(failureReason)) {
    const message = failureReason
      ? `${failureReason} Manual reconciliation is required before this payment can be retried.`
      : 'The provider result needs manual reconciliation before this payment can be retried.'

    return {
      state: 'manual-reconciliation',
      title: 'Manual reconciliation required',
      message
    }
  }

  if (failureReason) return {
    state: 'blocked',
    title: 'Payment verification blocked',
    message: failureReason
  }

  if (normalizedStatus === 'UNKNOWN') return {
    state: 'pending',
    title: 'Payment status is unknown',
    message: 'Your payment is still being verified. Check back in a few minutes.'
  }

  return {
    state: 'pending',
    title: 'Payment pending',
    message: 'Payment is still processing. Check back in a few minutes.'
  }
}
