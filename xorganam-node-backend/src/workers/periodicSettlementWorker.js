import { Worker } from 'bullmq'
import { getRedisConnection, PERIODIC_SETTLEMENT_QUEUE } from '../queue/queue.js'
import { runDuePeriodicSettlements, SweepPendingError } from '../services/periodicSettlementService.js'
import { recordOperationalFailure } from '../services/operationalFailureService.js'

export const periodicSettlementWorker = new Worker(
  PERIODIC_SETTLEMENT_QUEUE,
  async (job) => {
    try {
      return await runDuePeriodicSettlements(job.data || {})
    } catch (error) {
      if (error instanceof SweepPendingError) throw error
      // Provider and database errors can include transaction context; keep shared logs non-sensitive.
      console.error('[periodic-settlement] job failed', { code: error?.code || 'WORKER_ERROR' })
      throw error
    }
  },
  { connection: getRedisConnection(), concurrency: 1 }
)

periodicSettlementWorker.on('error', (error) => {
  console.error('[periodic-settlement] worker error', { code: error?.code || 'WORKER_ERROR' })
})

periodicSettlementWorker.on('failed', (job, error) => {
  recordOperationalFailure({ queueName: PERIODIC_SETTLEMENT_QUEUE, job, error })
    .catch((persistError) => console.error('[periodic-settlement] failure alert persistence failed', { code: persistError?.code || 'DB_ERROR' }))
})
