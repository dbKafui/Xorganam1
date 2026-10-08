const LEGAL_STATUS_TRANSITIONS = {
  COLLECTION: new Set([
    'PENDING->RECEIVED',
    'PENDING->FAILED',
    'RECEIVED->SWEPT_INTERNAL',
    'SWEPT_INTERNAL->PARTIALLY_SETTLED',
    'SWEPT_INTERNAL->PAID_OUT',
    'PARTIALLY_SETTLED->PAID_OUT'
  ]),
  INTERNAL_TRANSFER: new Set([
    'PENDING->SWEPT_INTERNAL',
    'PENDING->FAILED'
  ]),
  PAYOUT: new Set([
    'PENDING->PAID_OUT',
    'PENDING->FAILED',
    'FAILED->PENDING'
  ])
}

export const MAX_SPLIT_PAYOUT_RETRIES = 5

const TRANSACTION_STATUSES = new Set([
  'PENDING', 'RECEIVED', 'SWEPT_INTERNAL', 'PARTIALLY_SETTLED', 'PAID_OUT', 'FAILED'
])

export function assertTransactionStatusTransition({ type, currentStatus, nextStatus }) {
  if (!LEGAL_STATUS_TRANSITIONS[type]) {
    throw new Error(`Unknown transaction type: ${type}`)
  }
  if (!TRANSACTION_STATUSES.has(currentStatus)) {
    throw new Error(`Unknown transaction status: ${currentStatus}`)
  }
  if (!TRANSACTION_STATUSES.has(nextStatus)) {
    throw new Error(`Unknown transaction status: ${nextStatus}`)
  }
  const transition = `${currentStatus}->${nextStatus}`
  if (!LEGAL_STATUS_TRANSITIONS[type].has(transition)) {
    throw new Error(`Illegal transaction status transition: ${type} ${currentStatus} -> ${nextStatus}`)
  }
}

export async function updateTransactionStatus(client, { id, type, currentStatus, nextStatus, fields = {} }) {
  assertTransactionStatusTransition({ type, currentStatus, nextStatus })
  const assignments = []
  const values = []
  for (const [column, value] of Object.entries(fields)) {
    assignments.push(`${column} = $${values.length + 4}`)
    values.push(value)
  }
  const setClause = assignments.length ? `, ${assignments.join(', ')}` : ''
  const { rows } = await client.query(
    `UPDATE transactions
        SET status = $2${setClause}, updated_at = now()
      WHERE id = $1 AND status = $3
      RETURNING id, type, status`,
    [id, nextStatus, currentStatus, ...values]
  )
  if (rows.length === 0) {
    throw new Error(`Illegal transaction status transition: ${type} ${currentStatus} -> ${nextStatus}`)
  }
  return rows[0]
}

export async function retryFailedSplitPayout(client, { id, internalReference }) {
  if (!internalReference) throw new Error('A new provider reference is required for a split payout retry.')

  const { rows } = await client.query(
    `SELECT status, payout_leg, payout_retry_count, internal_reference
       FROM transactions
      WHERE id = $1 AND type = 'PAYOUT'
      FOR UPDATE`,
    [id]
  )
  const payout = rows[0]
  if (!payout || !['VENDOR', 'INSTITUTION'].includes(payout.payout_leg) || payout.status !== 'FAILED') {
    throw new Error('Only a failed split payout leg can be retried.')
  }
  if (Number(payout.payout_retry_count) >= MAX_SPLIT_PAYOUT_RETRIES) {
    return { exhausted: true, retryCount: Number(payout.payout_retry_count) }
  }
  if (payout.internal_reference === internalReference) {
    throw new Error('A split payout retry must use a new provider reference.')
  }

  const retryCount = Number(payout.payout_retry_count) + 1
  const transaction = await updateTransactionStatus(client, {
    id,
    type: 'PAYOUT',
    currentStatus: 'FAILED',
    nextStatus: 'PENDING',
    fields: {
      payout_retry_count: retryCount,
      internal_reference: internalReference,
      payment_gateway_status: 'READY',
      eganow_reference: null,
      eganow_transaction_id: null,
      failure_reason: null,
      completed_at: null
    }
  })

  return { ...transaction, exhausted: false, retryCount, internalReference }
}
