const ACTIVE_JOB_STATES = new Set(['active', 'delayed', 'waiting', 'waiting-children', 'prioritized'])

export async function replayCreditWebhookJob(queue, eventId) {
  const jobId = `credit-webhook-${String(eventId).replace(/:/g, '-')}`
  const existingJob = await queue.getJob(jobId)

  if (!existingJob) {
    return queue.add('deliver-credit-webhook', { eventId }, {
      jobId,
      attempts: 10,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60 },
      removeOnFail: { age: 30 * 24 * 60 * 60 }
    })
  }

  const state = await existingJob.getState()
  if (ACTIVE_JOB_STATES.has(state)) return existingJob
  if (state === 'failed') {
    await existingJob.retry('failed')
    return existingJob
  }

  return null
}