const INSTITUTION_FINANCIAL_TRANSACTION_STATUS_TRANSITIONS = new Set([
  'PENDING_APPROVAL->PENDING_GATEWAY',
  'PENDING_APPROVAL->REJECTED',
  'PENDING_GATEWAY->PENDING_GATEWAY',
  'PENDING_GATEWAY->POSTED',
  'PENDING_GATEWAY->FAILED'
])

const INSTITUTION_FINANCIAL_TRANSACTION_STATUSES = new Set([
  'PENDING_APPROVAL',
  'PENDING_GATEWAY',
  'POSTED',
  'REJECTED',
  'FAILED'
])

const INSTITUTION_TRANSACTION_STATUS_TRANSITIONS = new Set([
  'PENDING->RECEIVED',
  'PENDING->PAID_OUT',
  'PENDING->FAILED',
  'FAILED->PENDING'
])

const INSTITUTION_TRANSACTION_STATUSES = new Set([
  'PENDING',
  'RECEIVED',
  'PAID_OUT',
  'FAILED'
])

export function assertInstitutionFinancialTransactionStatusTransition({ currentStatus, nextStatus }) {
  if (!INSTITUTION_FINANCIAL_TRANSACTION_STATUSES.has(currentStatus)) {
    throw new Error(`Unknown institution financial transaction status: ${currentStatus}`)
  }
  if (!INSTITUTION_FINANCIAL_TRANSACTION_STATUSES.has(nextStatus)) {
    throw new Error(`Unknown institution financial transaction status: ${nextStatus}`)
  }
  const transition = `${currentStatus}->${nextStatus}`
  if (!INSTITUTION_FINANCIAL_TRANSACTION_STATUS_TRANSITIONS.has(transition)) {
    throw new Error(`Illegal institution financial transaction status transition: ${currentStatus} -> ${nextStatus}`)
  }
}

export function assertInstitutionTransactionStatusTransition({ currentStatus, nextStatus }) {
  if (!INSTITUTION_TRANSACTION_STATUSES.has(currentStatus)) {
    throw new Error(`Unknown institution transaction status: ${currentStatus}`)
  }
  if (!INSTITUTION_TRANSACTION_STATUSES.has(nextStatus)) {
    throw new Error(`Unknown institution transaction status: ${nextStatus}`)
  }
  const transition = `${currentStatus}->${nextStatus}`
  if (!INSTITUTION_TRANSACTION_STATUS_TRANSITIONS.has(transition)) {
    throw new Error(`Illegal institution transaction status transition: ${currentStatus} -> ${nextStatus}`)
  }
}

export async function updateInstitutionFinancialTransactionStatus(client, {
  id,
  institutionId,
  currentStatus,
  nextStatus,
  fields = {}
}) {
  assertInstitutionFinancialTransactionStatusTransition({ currentStatus, nextStatus })
  const assignments = []
  const values = []
  for (const [column, value] of Object.entries(fields)) {
    assignments.push(`${column} = $${values.length + 5}`)
    values.push(value)
  }
  const setClause = assignments.length ? `, ${assignments.join(', ')}` : ''
  const { rows } = await client.query(
    `UPDATE institution_financial_transactions
        SET status = $2${setClause}, updated_at = now()
      WHERE id = $1 AND institution_id = $3 AND status = $4
      RETURNING *`,
    [id, nextStatus, institutionId, currentStatus, ...values]
  )
  if (!rows.length) {
    throw new Error(`Illegal institution financial transaction status transition: ${currentStatus} -> ${nextStatus}`)
  }
  return rows[0]
}

export async function updateInstitutionTransactionStatus(client, {
  id,
  institutionId,
  currentStatus,
  nextStatus,
  fields = {}
}) {
  assertInstitutionTransactionStatusTransition({ currentStatus, nextStatus })
  const assignments = []
  const values = []
  for (const [column, value] of Object.entries(fields)) {
    assignments.push(`${column} = $${values.length + 5}`)
    values.push(value)
  }
  const setClause = assignments.length ? `, ${assignments.join(', ')}` : ''
  const { rows } = await client.query(
    `UPDATE institution_transactions
        SET status = $2${setClause}, updated_at = now()
      WHERE id = $1 AND institution_id = $3 AND status = $4
      RETURNING *`,
    [id, nextStatus, institutionId, currentStatus, ...values]
  )
  if (!rows.length) {
    throw new Error(`Illegal institution transaction status transition: ${currentStatus} -> ${nextStatus}`)
  }
  return rows[0]
}
