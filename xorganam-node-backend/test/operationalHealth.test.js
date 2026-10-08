import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { buildOperationalHealthSummary, sanitizeQueueFailure, filterQueueFailuresByTenant } = await import('../src/services/operationalHealthService.js')
const { isFinalWorkerAttempt } = await import('../src/services/operationalFailurePolicy.js')

describe('operational health summary', () => {
  it('marks dependencies unhealthy when connectivity checks fail and exposes queue counts', () => {
    const summary = buildOperationalHealthSummary({
      database: { available: false, error: 'connection refused' },
      redis: { available: true, error: null },
      queues: {
        'collect-for-me': { waiting: 2, delayed: 1, active: 0, failed: 3 },
        'credit-webhook-delivery': { waiting: 0, delayed: 0, active: 1, failed: 0 }
      },
      providers: {
        email: { configured: false, status: 'unconfigured' },
        sms: { configured: true, status: 'healthy' }
      }
    })

    assert.equal(summary.status, 'degraded')
    assert.equal(summary.database.available, false)
    assert.equal(summary.redis.available, true)
    assert.equal(summary.queues['collect-for-me'].failed, 3)
    assert.equal(summary.providers.email.status, 'unconfigured')
    assert.equal(summary.criticalIssues.length, 4)
    assert.match(summary.criticalIssues[0], /Database/)
    assert.match(summary.criticalIssues.at(-1), /active/) // The active queue job requires operator attention.
  })

  it('sanitizes failed queue jobs before returning them to operators', () => {
    const failure = sanitizeQueueFailure({
      id: 'job-1',
      name: 'process-collection',
      failedReason: 'Provider timeout',
      attemptsMade: 3,
      finishedOn: new Date('2026-10-08T12:00:00.000Z').getTime(),
      data: { tenantId: 'tenant-1', merchantId: 'merchant-1', transactionId: 'txn-1', secret: 'redact-me' },
      opts: { jobId: 'job-1' }
    })

    assert.deepEqual(failure, {
      id: 'job-1',
      name: 'process-collection',
      failedReason: 'Provider timeout',
      attemptsMade: 3,
      finishedAt: '2026-10-08T12:00:00.000Z',
      tenantId: 'tenant-1',
      merchantId: 'merchant-1',
      transactionId: 'txn-1'
    })
  })

  it('keeps failed queue jobs isolated to the requested tenant', () => {
    const failures = [
      { tenantId: 'tenant-a', id: 'job-a' },
      { tenantId: 'tenant-b', id: 'job-b' },
      { tenantId: null, id: 'system-job' }
    ]
    assert.deepEqual(filterQueueFailuresByTenant(failures, 'tenant-a'), [failures[0]])
    assert.deepEqual(filterQueueFailuresByTenant(failures), failures)
  })

  it('persists worker failures only after the configured retry budget is exhausted', () => {
    assert.equal(isFinalWorkerAttempt({ attemptsMade: 2, opts: { attempts: 3 } }), false)
    assert.equal(isFinalWorkerAttempt({ attemptsMade: 3, opts: { attempts: 3 } }), true)
    assert.equal(isFinalWorkerAttempt({ attemptsMade: 1, opts: {} }), true)
  })

  it('marks the system healthy only when every dependency is available', () => {
    const summary = buildOperationalHealthSummary({
      database: { available: true, error: null },
      redis: { available: true, error: null },
      queues: {
        'collect-for-me': { waiting: 0, delayed: 0, active: 0, failed: 0 }
      },
      providers: {
        email: { configured: true, status: 'healthy' },
        sms: { configured: true, status: 'healthy' }
      }
    })

    assert.equal(summary.status, 'healthy')
    assert.deepEqual(summary.criticalIssues, [])
    assert.equal(summary.notice, 'All monitored dependencies are available.')
  })
})
