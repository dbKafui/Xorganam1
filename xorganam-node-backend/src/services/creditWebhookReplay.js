import { randomUUID } from 'node:crypto'

const ACTIVE_JOB_STATES = new Set(['active', 'delayed', 'waiting', 'waiting-children', 'prioritized'])

function replayJobOptions(eventId) {
  return {
    jobId: `credit-webhook-${String(eventId).replace(/:/g, '-')}`,
    attempts: 10,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60 },
    removeOnFail: { age: 30 * 24 * 60 * 60 }
  }
}

export async function replayCreditWebhookJob(queue, eventId) {
  const options = replayJobOptions(eventId)
  const jobId = options.jobId
  const existingJob = await queue.getJob(jobId)

  if (!existingJob) {
    return queue.add('deliver-credit-webhook', { eventId }, options)
  }

  const state = await existingJob.getState()
  if (ACTIVE_JOB_STATES.has(state)) return existingJob
  if (state === 'failed') {
    await existingJob.retry('failed')
    return existingJob
  }
  if (state === 'completed') {
    return queue.add('deliver-credit-webhook', { eventId }, {
      ...options,
      jobId: `${jobId}-replay-${randomUUID()}`
    })
  }

  return null
}