const LEGAL_SWEEP_STATUS_TRANSITIONS = new Set([
  'PENDING->PARTIALLY_SETTLED',
  'PENDING->SETTLED',
  'PENDING->ACCRUED_UNSWEPT',
  'PARTIALLY_SETTLED->SETTLED',
  'PARTIALLY_SETTLED->PARTIALLY_SETTLED',
  'ACCRUED_UNSWEPT->PENDING',
  'ACCRUED_UNSWEPT->PARTIALLY_SETTLED'
])

const SWEEP_STATUSES = new Set([
  'PENDING', 'ACCRUED_UNSWEPT', 'PARTIALLY_SETTLED', 'SETTLED'
])

export function assertInstitutionSweepStatusTransition({ currentStatus, nextStatus }) {
  if (!SWEEP_STATUSES.has(currentStatus)) {
    throw new Error(`Unknown institution sweep status: ${currentStatus}`)
  }
  if (!SWEEP_STATUSES.has(nextStatus)) {
    throw new Error(`Unknown institution sweep status: ${nextStatus}`)
  }
  const transition = `${currentStatus}->${nextStatus}`
  if (!LEGAL_SWEEP_STATUS_TRANSITIONS.has(transition)) {
    throw new Error(`Illegal institution sweep status transition: ${currentStatus} -> ${nextStatus}`)
  }
}

export async function updateInstitutionSweepStatus(client, {
  id,
  currentStatus,
  nextStatus,
  fields = {}
}) {
  assertInstitutionSweepStatusTransition({ currentStatus, nextStatus })
  const assignments = []
  const values = []
  for (const [column, value] of Object.entries(fields)) {
    assignments.push(`${column} = $${values.length + 3}`)
    values.push(value)
  }
  const setClause = assignments.length ? `, ${assignments.join(', ')}` : ''
  const { rows } = await client.query(
    `UPDATE institution_sweep_ledger
        SET status = $2${setClause}, updated_at = now()
      WHERE id = $1 AND status = $3
      RETURNING *`,
    [id, nextStatus, currentStatus, ...values]
  )
  if (!rows.length) {
    throw new Error(`Illegal institution sweep status transition: ${currentStatus} -> ${nextStatus}`)
  }
  return rows[0]
}
