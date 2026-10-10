import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createSenderVerificationToken, senderVerificationRecord, verifySenderDnsRecord } from '../src/email/senderVerification.js'

describe('tenant email sender verification', () => {
  it('creates a domain TXT challenge and verifies split DNS chunks', async () => {
    const { token, hash } = createSenderVerificationToken()
    const record = senderVerificationRecord('billing@example.test', token)
    assert.equal(record.recordType, 'TXT')
    assert.equal(record.recordName, '_xorganam-email-verification.example.test')
    assert.equal(await verifySenderDnsRecord('billing@example.test', hash, async () => [[record.recordValue.slice(0, 24), record.recordValue.slice(24)]]), true)
  })

  it('does not accept an unmatched or absent TXT record', async () => {
    const { hash } = createSenderVerificationToken()
    assert.equal(await verifySenderDnsRecord('billing@example.test', hash, async () => [['xorganam-email-verification=wrong']]), false)
    assert.equal(await verifySenderDnsRecord('billing@example.test', hash, async () => { const error = new Error(); error.code = 'ENODATA'; throw error }), false)
  })
})