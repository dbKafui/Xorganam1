import { randomUUID } from 'node:crypto'

const requestMetrics = () => ({
  total: 0,
  byStatus: Object.create(null),
  byRoute: Object.create(null),
  byMethod: Object.create(null),
  durations: {
    totalMs: 0,
    count: 0
  }
})

export function createObservability({ serviceName = 'xorganam-node-backend' } = {}) {
  const metrics = requestMetrics()

  function generateRequestId() {
    return randomUUID()
  }

  function recordRequest({ method, route, statusCode, durationMs }) {
    metrics.total += 1
    metrics.byStatus[statusCode] = (metrics.byStatus[statusCode] || 0) + 1
    metrics.byRoute[route] = (metrics.byRoute[route] || 0) + 1
    metrics.byMethod[method] = (metrics.byMethod[method] || 0) + 1
    metrics.durations.totalMs += durationMs
    metrics.durations.count += 1
  }

  function getReadiness(dependencies = {}) {
    const dependencyEntries = Object.entries(dependencies)
    const statuses = Object.fromEntries(dependencyEntries.map(([name, ready]) => [
      name,
      { ready: Boolean(ready) }
    ]))
    return {
      ready: dependencyEntries.every(([, ready]) => Boolean(ready)),
      service: serviceName,
      dependencies: statuses
    }
  }

  return {
    serviceName,
    generateRequestId,
    recordRequest,
    getReadiness,
    metrics: {
      requests: metrics
    }
  }
}

export const defaultObservability = createObservability()
