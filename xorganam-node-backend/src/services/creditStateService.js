const CREDIT_PLAN_STATUS_TRANSITIONS = new Set([
  'ACTIVE->OVERDUE',
  'OVERDUE->ACTIVE',
  'OVERDUE->DEFAULTED',
  'ACTIVE->COMPLETED',
  'ACTIVE->DEFAULTED',
  'DEFAULTED->COMPLETED',
  'ACTIVE->CANCELLED',
  'OVERDUE->CANCELLED'
])

export const PREVENTED_CREDIT_PLAN_CANCELLATION = {
  ACTIVE: false,
  COMPLETED: true,
  OVERDUE: false,
  DEFAULTED: true,
  CANCELLED: true
}

const CREDIT_PLAN_STATUSES = new Set(['ACTIVE', 'COMPLETED', 'OVERDUE', 'DEFAULTED', 'CANCELLED'])
export const CREDIT_PLAN_PAYMENT_STATUSES = Object.freeze(['ACTIVE', 'OVERDUE', 'DEFAULTED'])
export const CREDIT_PLAN_CANCELLABLE_STATUSES = Object.freeze(['ACTIVE', 'OVERDUE'])
const CREDIT_INSTALLMENT_STATUSES = new Set(['PENDING', 'PAID', 'OVERDUE'])
const CREDIT_INSTALLMENT_TRANSITIONS = new Set([
  'PENDING->PAID',
  'PENDING->OVERDUE',
  'OVERDUE->PAID',
  'OVERDUE->OVERDUE'
])

export function assertCreditPlanStatusTransition({ currentStatus, nextStatus }) {
  if (!CREDIT_PLAN_STATUSES.has(currentStatus)) {
    throw new Error(`Unknown credit plan status: ${currentStatus}`)
  }
  if (!CREDIT_PLAN_STATUSES.has(nextStatus)) {
    throw new Error(`Unknown credit plan status: ${nextStatus}`)
  }
  const transition = `${currentStatus}->${nextStatus}`
  if (!CREDIT_PLAN_STATUS_TRANSITIONS.has(transition)) {
    throw new Error(`Illegal credit plan status transition: ${currentStatus} -> ${nextStatus}`)
  }
}

export function assertCreditPlanCancellationAllowed({ currentStatus, outstandingInstallments = 0 }) {
  if (PREVENTED_CREDIT_PLAN_CANCELLATION[currentStatus]) {
    return false
  }
  return outstandingInstallments === 0 || currentStatus === 'OVERDUE'
}

export function assertCreditInstallmentStatusTransition({ currentStatus, nextStatus }) {
  if (!CREDIT_INSTALLMENT_STATUSES.has(currentStatus)) {
    throw new Error(`Unknown credit installment status: ${currentStatus}`)
  }
  if (!CREDIT_INSTALLMENT_STATUSES.has(nextStatus)) {
    throw new Error(`Unknown credit installment status: ${nextStatus}`)
  }
  const transition = `${currentStatus}->${nextStatus}`
  if (!CREDIT_INSTALLMENT_TRANSITIONS.has(transition)) {
    throw new Error(`Illegal credit installment status transition: ${currentStatus} -> ${nextStatus}`)
  }
}

export async function updateCreditPlanStatus(client, { id, currentStatus, nextStatus, fields = {} }) {
  assertCreditPlanStatusTransition({ currentStatus, nextStatus })
  const assignments = []
  const values = []

  for (const [column, value] of Object.entries(fields)) {
    assignments.push(`${column} = $${values.length + 4}`)
    values.push(value)
  }

  const { rows } = await client.query(
    `UPDATE credit_plans
        SET status = $2${assignments.length ? `, ${assignments.join(', ')}` : ''}
      WHERE id = $1 AND status = $3
      RETURNING id, status`,
    [id, nextStatus, currentStatus, ...values]
  )

  if (!rows.length) {
    throw new Error(`Illegal credit plan status transition: ${currentStatus} -> ${nextStatus}`)
  }

  return rows[0]
}

export async function updateCreditInstallmentStatus(client, { id, currentStatus, nextStatus, fields = {} }) {
  assertCreditInstallmentStatusTransition({ currentStatus, nextStatus })
  const assignments = []
  const values = []

  for (const [column, value] of Object.entries(fields)) {
    assignments.push(`${column} = $${values.length + 4}`)
    values.push(value)
  }

  const { rows } = await client.query(
    `UPDATE credit_plan_installments
        SET status = $2${assignments.length ? `, ${assignments.join(', ')}` : ''}
      WHERE id = $1 AND status = $3
      RETURNING id, status`,
    [id, nextStatus, currentStatus, ...values]
  )

  if (!rows.length) {
    throw new Error(`Illegal credit installment status transition: ${currentStatus} -> ${nextStatus}`)
  }

  return rows[0]
}
