import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'

const { orderFingerprint } = await import('../src/services/storefrontOrderService.js')

const request = {
  slug: 'market-store',
  itemMap: new Map([
    ['22222222-2222-4222-8222-222222222222', 2],
    ['11111111-1111-4111-8111-111111111111', 1]
  ]),
  customerIdentifier: '233241234567',
  customerName: 'Customer',
  fulfillmentType: 'PICKUP',
  address: '',
  merchantId: '33333333-3333-4333-8333-333333333333',
  paymentMethod: 'EGANOW',
  collectionMethod: 'MOMO'
}

describe('storefront order idempotency', () => {
  it('fingerprints cart lines independent of input order', () => {
    const reordered = new Map([...request.itemMap.entries()].reverse())
    assert.equal(orderFingerprint(request), orderFingerprint({ ...request, itemMap: reordered }))
  })

  it('rejects changed cart, customer, fulfillment, or payment terms by changing the fingerprint', () => {
    assert.notEqual(orderFingerprint(request), orderFingerprint({ ...request, customerIdentifier: '233201234567' }))
    assert.notEqual(orderFingerprint(request), orderFingerprint({ ...request, fulfillmentType: 'DELIVERY', address: 'Main road 1' }))
    assert.notEqual(orderFingerprint(request), orderFingerprint({ ...request, paymentMethod: 'CREDIT' }))
    assert.notEqual(orderFingerprint(request), orderFingerprint({ ...request, itemMap: new Map([...request.itemMap, ['44444444-4444-4444-8444-444444444444', 1]]) }))
  })
})
