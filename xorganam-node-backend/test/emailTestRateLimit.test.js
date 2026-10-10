import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { consumeTenantQuota } from '../src/email/emailTestRateLimitPolicy.js'

describe('tenant email test rate limit', () => {
  it('uses atomic counters and isolates tenants in Redis keys', async () => {
    const keys = []
    const counts = new Map()
    const redis = {
      async eval(script, keyCount, key, windowMs) {
        assert.match(script, /INCR/)
        assert.match(script, /PEXPIRE/)
        assert.equal(keyCount, 1)
        assert.equal(windowMs, 3600000)
        keys.push(key)
        const next = (counts.get(key) || 0) + 1
        counts.set(key, next)
        return next
      }
    }
    const first = await consumeTenantQuota(redis, 'tenant-a', 2, 3600000)
    const second = await consumeTenantQuota(redis, 'tenant-a', 2, 3600000)
    const limited = await consumeTenantQuota(redis, 'tenant-a', 2, 3600000)
    const otherTenant = await consumeTenantQuota(redis, 'tenant-b', 2, 3600000)
    assert.deepEqual(first, { allowed: true, remaining: 1 })
    assert.deepEqual(second, { allowed: true, remaining: 0 })
    assert.deepEqual(limited, { allowed: false, remaining: 0 })
    assert.deepEqual(otherTenant, { allowed: true, remaining: 1 })
    assert.equal(keys[0], 'tenant-email-test:tenant-a')
    assert.equal(keys[3], 'tenant-email-test:tenant-b')
  })
})