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
    'PENDING->FAILED'
  ])
}

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
    assignments.push(`${column} = $${values.length + 3}`)
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
