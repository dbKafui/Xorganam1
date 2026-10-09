import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { replayCreditWebhookJob } from '../src/services/creditWebhookReplay.js'

describe('credit webhook replay', () => {
  it('enqueues a new job when the retained job is missing', async () => {
    const calls = []
    const queue = {
      getJob: async () => null,
      add: async (...args) => { calls.push(args); return { id: args[2].jobId } }
    }

    const job = await replayCreditWebhookJob(queue, 'event:1')

    assert.equal(job.id, 'credit-webhook-event-1')
    assert.equal(calls[0][0], 'deliver-credit-webhook')
    assert.deepEqual(calls[0][1], { eventId: 'event:1' })
    assert.equal(calls[0][2].attempts, 10)
  })

  it('retries failed jobs without creating duplicates', async () => {
    let retries = 0
    const failedJob = { getState: async () => 'failed', retry: async (state) => { assert.equal(state, 'failed'); retries++ } }
    const queue = { getJob: async () => failedJob, add: async () => assert.fail('unexpected duplicate job') }

    assert.equal(await replayCreditWebhookJob(queue, 'event-1'), failedJob)
    assert.equal(retries, 1)
  })

  it('leaves active jobs alone and creates a new attempt after a completed job', async () => {
    const queueFor = (state) => ({
      getJob: async () => ({ getState: async () => state }),
      add: async (...args) => args
    })

    assert.ok(await replayCreditWebhookJob(queueFor('active'), 'event-1'))
    const replay = await replayCreditWebhookJob(queueFor('completed'), 'event-1')
    assert.equal(replay[0], 'deliver-credit-webhook')
    assert.deepEqual(replay[1], { eventId: 'event-1' })
    assert.match(replay[2].jobId, /^credit-webhook-event-1-replay-/)
  })
})