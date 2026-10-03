import { Queue, Worker } from 'bullmq'
import { getRedisConnection, CREDIT_CASH_SWEEP_QUEUE } from '../queue/queue.js'
import { runDueCreditCashSweeps } from '../services/creditCashSweepService.js'

const connection = getRedisConnection()
const queue = new Queue(CREDIT_CASH_SWEEP_QUEUE, { connection })

queue.add('run-credit-cash-sweeps', {}, {
  repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'credit-cash-sweep-daily'
}).catch((error) => console.error('[credit-cash-sweep] schedule failed:', error.message))
queue.add('run-credit-cash-sweeps', {}, {
  jobId: `credit-cash-sweep-initial-${Date.now()}`
}).catch((error) => console.error('[credit-cash-sweep] initial schedule failed:', error.message))

export const creditCashSweepWorker = new Worker(CREDIT_CASH_SWEEP_QUEUE, async () => runDueCreditCashSweeps(), {
  connection, concurrency: 1
})

creditCashSweepWorker.on('failed', (job, error) => console.error(`[credit-cash-sweep] job ${job?.id || 'unknown'} failed:`, error.message))
creditCashSweepWorker.on('error', (error) => console.error('[credit-cash-sweep] worker error:', error.message))
