import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'

const { collectionFingerprint, isUncertainProviderOutcome } = await import('../src/services/collectionService.js')

const baseRequest = {
  merchantId: '11111111-1111-4111-8111-111111111111',
  amount: 10.25,
  collectionMethod: 'MOMO',
  msisdn: '233241234567',
  payoutMsisdn: null,
  creditPlanId: null,
  creditInstallmentId: null,
  orderId: null
}

describe('collection idempotency and uncertain outcomes', () => {
  it('fingerprints equivalent payment terms deterministically', () => {
    assert.equal(collectionFingerprint(baseRequest), collectionFingerprint({ ...baseRequest }))
    assert.notEqual(collectionFingerprint(baseRequest), collectionFingerprint({ ...baseRequest, amount: 10.5 }))
    assert.notEqual(collectionFingerprint(baseRequest), collectionFingerprint({ ...baseRequest, msisdn: '233201234567' }))
  })

  it('fingerprints card identity without retaining CVV or cardholder name', () => {
    const cardRequest = { ...baseRequest, collectionMethod: 'CARD', msisdn: null, cardNumber: '4111 1111 1111 1111', expiryDateMonth: 1, expiryDateYear: '30', cvv: '123' }
    assert.notEqual(collectionFingerprint(cardRequest), collectionFingerprint({ ...cardRequest, cardNumber: '5555 5555 5555 4444' }))
    assert.equal(collectionFingerprint(cardRequest), collectionFingerprint({ ...cardRequest, cvv: '987', cardholderName: 'Different Name' }))
  })

  it('treats transport errors, throttling, and provider 5xx as uncertain', () => {
    assert.equal(isUncertainProviderOutcome({ code: 'ETIMEDOUT' }), true)
    assert.equal(isUncertainProviderOutcome({ response: { status: 429 } }), true)
    assert.equal(isUncertainProviderOutcome({ response: { status: 503 } }), true)
    assert.equal(isUncertainProviderOutcome({ response: { status: 400 } }), false)
  })
})
