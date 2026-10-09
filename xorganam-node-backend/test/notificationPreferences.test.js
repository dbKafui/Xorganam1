import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveMerchantNotificationPreferences } from '../src/services/notificationPolicy.js'

describe('merchant notification preferences', () => {
  it('uses schema-compatible defaults when settings are absent', () => {
    assert.deepEqual(resolveMerchantNotificationPreferences(null), {
      notifySms: true,
      notifyEmail: false,
      contactEmail: ''
    })
  })

  it('honors opt-outs and normalizes the configured contact email', () => {
    assert.deepEqual(resolveMerchantNotificationPreferences({
      notify_sms: false,
      notify_email: true,
      contact_email: '  finance@example.com  '
    }), {
      notifySms: false,
      notifyEmail: true,
      contactEmail: 'finance@example.com'
    })
  })
})