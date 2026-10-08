import assert from 'node:assert/strict'
import test from 'node:test'

const { createObservability, defaultObservability } = await import('../src/lib/observability.js')

test('observability assigns correlation IDs and records request metrics', () => {
  const observability = createObservability({ serviceName: 'erp-tests' })
  const requestId = observability.generateRequestId()

  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89abAB][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(defaultObservability.serviceName, 'xorganam-node-backend')

  const request = { id: requestId, method: 'GET', route: '/api/v1/reports/tenant' }
  observability.recordRequest({ ...request, statusCode: 200, durationMs: 42 })
  observability.recordRequest({ ...request, statusCode: 500, durationMs: 90 })

  assert.equal(observability.metrics.requests.total, 2)
  assert.equal(observability.metrics.requests.byStatus[200], 1)
  assert.equal(observability.metrics.requests.byStatus[500], 1)
  assert.equal(observability.metrics.requests.byRoute['/api/v1/reports/tenant'], 2)
})

test('readiness reports dependency availability without treating a degraded dependency as healthy', () => {
  const observability = createObservability({ serviceName: 'erp-tests' })
  const ready = observability.getReadiness({ database: true, redis: false, worker: true })

  assert.equal(ready.ready, false)
  assert.deepEqual(ready.dependencies, {
    database: { ready: true },
    redis: { ready: false },
    worker: { ready: true }
  })
})
