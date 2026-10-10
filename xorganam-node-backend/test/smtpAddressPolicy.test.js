import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPinnedDnsLookup, isSmtpAddressBlocked, resolveSmtpDestination } from '../src/email/smtpAddressPolicy.js'

const blockedCidrs = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'
]

describe('SMTP SSRF address policy', () => {
  it('blocks configured IPv4, metadata, IPv6, and IPv4-mapped IPv6 ranges', () => {
    for (const address of [
      '0.1.2.3', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
      '172.20.1.1', '192.168.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:10.1.2.3'
    ]) assert.equal(isSmtpAddressBlocked(address, blockedCidrs), true, address)
    assert.equal(isSmtpAddressBlocked('8.8.8.8', blockedCidrs), false)
    assert.equal(isSmtpAddressBlocked('2606:4700:4700::1111', blockedCidrs), false)
  })

  it('rejects a hostname when any DNS answer is blocked', async () => {
    const lookup = async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 }
    ]
    await assert.rejects(resolveSmtpDestination('mail.example.test', { blockedSmtpCidrs: blockedCidrs }, lookup), /blocked network/)
  })

  it('returns and pins only the validated public DNS answer', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }]
    const destination = await resolveSmtpDestination('mail.example.test', { blockedSmtpCidrs: blockedCidrs }, lookup)
    assert.deepEqual(destination, { hostname: 'mail.example.test', address: '8.8.8.8', family: 4 })
    const pinnedLookup = createPinnedDnsLookup(destination)
    const result = await new Promise((resolve, reject) => pinnedLookup('mail.example.test', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })))
    assert.deepEqual(result, { address: '8.8.8.8', family: 4 })
  })
})