import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  classifyProviderFailure,
  deserializeEmailMessageFromQueue,
  prepareEmailMessage,
  serializeEmailMessageForQueue,
  resolveEmailJobFailure
} from '../src/email/emailMessagePolicy.js'

const policy = { maxRecipients: 2, maxAttachmentBytes: 4 }
const config = { fromAddress: 'sender@example.test', fromName: null, replyTo: null }

describe('tenant email message policy', () => {
  it('preserves binary attachments across queue JSON serialization', () => {
    const message = { to: 'one@example.test', subject: 'Receipt', text: 'Paid', attachments: [{ filename: 'receipt.bin', content: Buffer.from([0, 255]) }] }
    const queued = JSON.parse(JSON.stringify(serializeEmailMessageForQueue(message)))
    const restored = deserializeEmailMessageFromQueue(queued)

    assert.deepEqual(restored.attachments[0].content, Buffer.from([0, 255]))
  })

  it('enforces configured recipient and attachment bounds', () => {
    assert.match(prepareEmailMessage({ to: ['one@example.test', 'two@example.test', 'three@example.test'], subject: 'x', text: 'y' }, config, policy).error, /recipient count/)
    assert.match(prepareEmailMessage({ to: 'one@example.test', subject: 'x', text: 'y', attachments: [{ filename: 'large', content: Buffer.alloc(5) }] }, config, policy).error, /attachment size/)
    assert.equal(prepareEmailMessage({ cc: 'one@example.test', subject: 'x', text: 'y' }, config, policy).error, undefined)
  })

  it('retries only transient transport and provider failures', () => {
    assert.equal(classifyProviderFailure({ responseCode: 451 }).transient, true)
    assert.equal(classifyProviderFailure({ responseCode: 550 }).transient, false)
    assert.equal(classifyProviderFailure({ status: 503 }).transient, true)
    assert.equal(classifyProviderFailure({ cause: { code: 'ECONNRESET' } }).transient, true)
  })

  it('keeps transient delivery records retryable until attempts are exhausted', () => {
    assert.deepEqual(resolveEmailJobFailure(2, 5), { status: 'RETRYING', completed: false })
    assert.deepEqual(resolveEmailJobFailure(5, 5), { status: 'FAILED', completed: true })
  })
})