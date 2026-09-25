import { Worker } from 'bullmq'
import { getRedisConnection, PERIODIC_SETTLEMENT_QUEUE } from '../queue/queue.js'
import { runDuePeriodicSettlements, SweepPendingError } from '../services/periodicSettlementService.js'

export const periodicSettlementWorker = new Worker(
  PERIODIC_SETTLEMENT_QUEUE,
  async (job) => {
    try {
      return await runDuePeriodicSettlements(job.data || {})
    } catch (error) {
      if (error instanceof SweepPendingError) throw error
      console.error(`[periodic-settlement] job ${job.id} failed:`, error)
      throw error
    }
  },
  { connection: getRedisConnection(), concurrency: 1 }
)

periodicSettlementWorker.on('error', (error) => {
  console.error('[periodic-settlement] worker error:', error)
})
