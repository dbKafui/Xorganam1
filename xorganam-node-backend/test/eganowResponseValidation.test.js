import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DATABASE_URL = 'postgresql://localhost/test'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.ENCRYPTION_MASTER_KEY = 'test-key'
process.env.JWT_SECRET = 'test-secret'

const { normalizeEganowResponse } = await import('../src/services/eganowClient.js')

describe('Eganow status result normalization', () => {
  it('retains amount and currency evidence required by reconciliation', () => {
    assert.deepEqual(normalizeEganowResponse({
      TransactionStatus: 'SUCCESS',
      TransactionAmount: '12.34',
      transCurrencyIso: 'GHS',
      TransactionId: 'TX-123',
      EganowReferenceNo: 'TX-123'
    }), {
      raw: {
        TransactionStatus: 'SUCCESS',
        TransactionAmount: '12.34',
        transCurrencyIso: 'GHS',
        TransactionId: 'TX-123',
        EganowReferenceNo: 'TX-123'
      },
      status: 'success',
      reference: 'TX-123',
      transactionId: 'TX-123',
      amount: '12.34',
      currency: 'GHS',
      message: null,
      redirectHtml: null,
      eganowReference: 'TX-123'
    })
  })
})
