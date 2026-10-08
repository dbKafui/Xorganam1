import { Queue, Worker } from 'bullmq'
import { getRedisConnection } from '../queue/queue.js'
import { withTransaction } from '../db/pool.js'
import { cancelAndRestockOrder, markStorefrontOrderPaid } from '../services/storefrontOrderService.js'
import { reconcileTransaction } from '../services/reconciliationService.js'
import { recordOperationalFailure } from '../services/operationalFailureService.js'

const QUEUE_NAME = 'storefront-order-expiry'
const connection = getRedisConnection()
const queue = new Queue(QUEUE_NAME, { connection })

queue.add('release-expired-orders', {}, {
  repeat: { every: 60_000 }, jobId: 'storefront-order-expiry-scan'
}).catch((error) => console.error('[order-expiry] schedule failed', { code: error?.code || 'WORKER_ERROR' }))
queue.add('release-expired-orders', {}, {
  jobId: `storefront-order-expiry-initial-${Date.now()}`
}).catch((error) => console.error('[order-expiry] initial scan failed', { code: error?.code || 'WORKER_ERROR' }))

async function processExpiredOrder() {
  const decision = await withTransaction(async (tx) => {
    const { rows: candidateRows } = await tx.query(
      `SELECT o.id, t.id AS collection_id
         FROM orders o
         LEFT JOIN LATERAL (
           SELECT id FROM transactions WHERE order_id = o.id AND type = 'COLLECTION'
           ORDER BY created_at DESC LIMIT 1
         ) t ON TRUE
        WHERE o.status = 'PENDING_PAYMENT' AND o.payment_expires_at < now()
        ORDER BY o.payment_expires_at LIMIT 1`
    )
    const candidate = candidateRows[0]
    if (!candidate) return { empty: true }

    // Use the same lock order as the Eganow callback: collection row, then
    // order row. This prevents a callback/expiry deadlock at the CAS boundary.
    let collection = null
    if (candidate.collection_id) {
      const { rows } = await tx.query(
        `SELECT id, status, eganow_reference, internal_reference
           FROM transactions WHERE id = $1 FOR UPDATE SKIP LOCKED`, [candidate.collection_id]
      )
      collection = rows[0]
      if (!collection) return { skipped: true }
    }
    const { rows: orderRows } = await tx.query(
      `SELECT id, tenant_id, merchant_id, status, credit_plan_id
         FROM orders WHERE id = $1 AND status = 'PENDING_PAYMENT'
           AND payment_expires_at < now() FOR UPDATE SKIP LOCKED`, [candidate.id]
    )
    const order = orderRows[0]
    if (!order) return { skipped: true }
    if (!collection || collection.status === 'FAILED') {
      const cancelled = await cancelAndRestockOrder(tx, order.id, { onlyPending: true, reason: 'Payment was not completed before the reservation expired.' })
      return { orderId: order.id, cancelled }
    }
    if (['RECEIVED', 'SWEPT_INTERNAL', 'PAID_OUT', 'PARTIALLY_SETTLED'].includes(collection.status)) {
      await markStorefrontOrderPaid(tx, collection.id)
      return { orderId: order.id, placed: true }
    }
    if (collection.status !== 'PENDING' || !collection.internal_reference) {
      return { orderId: order.id, pendingReconciliation: true }
    }
    return {
      orderId: order.id,
      collectionId: collection.id,
      tenantId: order.tenant_id,
      merchantId: order.merchant_id,
      reconcile: true
    }
  })

  if (!decision.reconcile) return decision

  try {
    const reconciled = await reconcileTransaction(decision.collectionId, decision.tenantId)
    if (reconciled?.status === 'FAILED') {
      const cancelled = await cancelAndRestockOrder(decision.orderId, {
        onlyPending: true,
        reason: 'Eganow confirmed the order payment failed.'
      })
      return { orderId: decision.orderId, cancelled }
    }
    if (['RECEIVED', 'SWEPT_INTERNAL', 'PAID_OUT', 'PARTIALLY_SETTLED'].includes(reconciled?.status)) {
      return { orderId: decision.orderId, placed: true }
    }
    return { orderId: decision.orderId, pendingReconciliation: true }
  } catch (error) {
    console.error('[order-expiry] payment outcome remains unconfirmed', { code: error?.code || 'RECONCILIATION_ERROR' })
    return { orderId: decision.orderId, pendingReconciliation: true }
  }
}

async function releaseExpiredOrders() {
  const results = []
  for (let i = 0; i < 100; i += 1) {
    const result = await processExpiredOrder()
    if (result.empty) break
    results.push(result)
    if (result.pendingReconciliation || result.skipped) break
  }
  return { processed: results.length, results }
}

export const orderExpiryWorker = new Worker(QUEUE_NAME, async (job) => {
  if (job.name !== 'release-expired-orders') throw new Error(`Unknown order-expiry job: ${job.name}`)
  return releaseExpiredOrders()
}, { connection, concurrency: 1 })

orderExpiryWorker.on('failed', (job, error) => {
  console.error('[order-expiry] job failed', { code: error?.code || 'WORKER_ERROR' })
  recordOperationalFailure({ queueName: QUEUE_NAME, job, error })
    .catch((persistError) => console.error('[order-expiry] failure alert persistence failed', { code: persistError?.code || 'DB_ERROR' }))
})
orderExpiryWorker.on('error', (error) => console.error('[order-expiry] worker error', { code: error?.code || 'WORKER_ERROR' }))
