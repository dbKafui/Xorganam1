export function isFinalWorkerAttempt(job) {
  if (!job) return false
  const attempts = Math.max(1, Number(job.opts?.attempts || 1))
  return Number(job.attemptsMade || 0) >= attempts
}