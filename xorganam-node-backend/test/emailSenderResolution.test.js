import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EmailSenderCache } from '../src/email/EmailSenderCache.js'
import { shouldUsePlatformEmailFallback } from '../src/email/senderResolutionPolicy.js'
import { getRegisteredMailSender } from '../src/email/senderRegistry.js'
import { SmtpSender } from '../src/email/senders/SmtpSender.js'
import { SendGridSender } from '../src/email/senders/SendGridSender.js'
import { SesSender } from '../src/email/senders/SesSender.js'
import { MailgunSender } from '../src/email/senders/MailgunSender.js'

describe('tenant email sender resolution', () => {
  it('uses the platform fallback only when tenant config is absent or disabled', () => {
    assert.equal(shouldUsePlatformEmailFallback(null), true)
    assert.equal(shouldUsePlatformEmailFallback({ enabled: false }), true)
    assert.equal(shouldUsePlatformEmailFallback({ enabled: true }), false)
  })

  it('registers all supported provider sender implementations', () => {
    const policy = {}
    assert.ok(getRegisteredMailSender('smtp', {}, policy) instanceof SmtpSender)
    assert.ok(getRegisteredMailSender('sendgrid', {}, policy) instanceof SendGridSender)
    assert.ok(getRegisteredMailSender('ses', {}, policy) instanceof SesSender)
    assert.ok(getRegisteredMailSender('mailgun', {}, policy) instanceof MailgunSender)
    assert.throws(() => getRegisteredMailSender('unknown', {}, policy), /not registered/)
  })

  it('expires, refreshes LRU entries, and invalidates individual or all senders', () => {
    let now = 100
    const cache = new EmailSenderCache(2, () => now)
    cache.set('tenant-a', 'sender-a', 10)
    cache.set('tenant-b', 'sender-b', 10)
    assert.equal(cache.get('tenant-a'), 'sender-a')
    cache.set('tenant-c', 'sender-c', 10)
    assert.equal(cache.get('tenant-b'), undefined)
    assert.equal(cache.get('tenant-c'), 'sender-c')
    cache.invalidate('tenant-a')
    assert.equal(cache.get('tenant-a'), undefined)
    now += 11
    assert.equal(cache.get('tenant-c'), undefined)
    cache.set('tenant-d', 'sender-d', 10)
    cache.invalidate()
    assert.equal(cache.entries.size, 0)
  })
})