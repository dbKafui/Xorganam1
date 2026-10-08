function normalizeQueueCounts(rawCounts = {}) {
  return {
    waiting: Number(rawCounts.waiting || 0),
    delayed: Number(rawCounts.delayed || 0),
    active: Number(rawCounts.active || 0),
    failed: Number(rawCounts.failed || 0),
    completed: Number(rawCounts.completed || 0)
  }
}

function summarizeProvider(name, config) {
  const configured = Boolean(config?.configured)
  return {
    name,
    configured,
    status: configured ? (config?.status || 'healthy') : 'unconfigured'
  }
}

export function sanitizeQueueFailure(job) {
  const payload = job?.data || {}
  return {
    id: String(job?.id ?? ''),
    name: String(job?.name ?? ''),
    failedReason: String(job?.failedReason || 'Unknown failure'),
    attemptsMade: Number(job?.attemptsMade || 0),
    finishedAt: job?.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    tenantId: payload.tenantId || null,
    merchantId: payload.merchantId || null,
    transactionId: payload.transactionId || null
  }
}

export function filterQueueFailuresByTenant(failures, tenantId = null) {
  return tenantId ? failures.filter((failure) => String(failure.tenantId) === String(tenantId)) : failures
}

export function buildOperationalHealthSummary({ database, redis, queues = {}, providers = {} }) {
  const queueEntries = Object.fromEntries(
    Object.entries(queues).map(([name, counts]) => [name, normalizeQueueCounts(counts)])
  )

  const issues = []
  if (!database?.available) issues.push(`Database unavailable: ${database?.error || 'database check failed'}.`)
  if (!redis?.available) issues.push(`Redis unavailable: ${redis?.error || 'redis check failed'}.`)

  const providerStatuses = Object.fromEntries(
    Object.entries(providers).map(([name, config]) => [name, summarizeProvider(name, config)])
  )
  for (const provider of Object.values(providerStatuses)) {
    if (provider.status === 'degraded') issues.push(`${provider.name} provider is degraded.`)
    if (provider.status === 'unconfigured') issues.push(`${provider.name} provider is not configured.`)
  }

  const failedJobs = Object.values(queueEntries).reduce((total, queue) => total + queue.failed, 0)
  const queuedJobs = Object.values(queueEntries).reduce((total, queue) => total + queue.waiting + queue.delayed, 0)
  const activeJobs = Object.values(queueEntries).reduce((total, queue) => total + queue.active, 0)

  if (failedJobs > 0) issues.push(`Queue has ${failedJobs} failed job${failedJobs === 1 ? '' : 's'} requiring review.`)
  if (activeJobs > 0) issues.push(`${activeJobs} job${activeJobs === 1 ? '' : 's'} are currently active.`)

  const status = issues.length === 0 ? 'healthy' : database?.available === false || redis?.available === false ? 'degraded' : 'degraded'

  return {
    status,
    checkedAt: new Date().toISOString(),
    database: { available: Boolean(database?.available), error: database?.error || null },
    redis: { available: Boolean(redis?.available), error: redis?.error || null },
    queues: queueEntries,
    providers: providerStatuses,
    queuedJobs,
    activeJobs,
    failedJobs,
    criticalIssues: issues,
    notice: issues.length === 0 ? 'All monitored dependencies are available.' : 'Some monitored dependencies require attention.'
  }
}
