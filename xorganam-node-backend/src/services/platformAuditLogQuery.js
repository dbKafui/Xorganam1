const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function normalizeDate(value, name) {
  if (value === undefined || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must be a YYYY-MM-DD date.`)
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a valid calendar date.`)
  }
  return value
}

export function normalizePlatformAuditFilters(input = {}) {
  const page = Number(input.page ?? 1)
  const pageSize = Number(input.pageSize ?? 50)
  if (!Number.isInteger(page) || page < 1) throw new Error('page must be a positive integer.')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('pageSize must be between 1 and 100.')

  for (const key of ['tenantId', 'actorUserId', 'actorInstitutionStaffId']) {
    if (input[key] && (typeof input[key] !== 'string' || !UUID_PATTERN.test(input[key]))) {
      throw new Error(`${key} must be a valid UUID.`)
    }
  }

  const fromDate = normalizeDate(input.fromDate, 'fromDate')
  const toDate = normalizeDate(input.toDate, 'toDate')
  if (fromDate && toDate && fromDate > toDate) throw new Error('fromDate must not be after toDate.')

  const normalizeText = (value, name) => {
    if (value === undefined || value === '') return null
    if (typeof value !== 'string' || value.trim().length > 100) throw new Error(`${name} must be at most 100 characters.`)
    return value.trim() || null
  }

  return {
    page,
    pageSize,
    tenantId: input.tenantId || null,
    actorUserId: input.actorUserId || null,
    actorInstitutionStaffId: input.actorInstitutionStaffId || null,
    action: normalizeText(input.action, 'action'),
    resourceType: normalizeText(input.resourceType, 'resourceType'),
    resourceId: normalizeText(input.resourceId, 'resourceId'),
    fromDate,
    toDate
  }
}

export function buildPlatformAuditWhere(filters) {
  const conditions = []
  const params = []
  const add = (condition, value) => {
    params.push(value)
    conditions.push(condition.replace('?', `$${params.length}`))
  }

  if (filters.tenantId) add('a.tenant_id = ?::uuid', filters.tenantId)
  if (filters.actorUserId) add('a.actor_user_id = ?::uuid', filters.actorUserId)
  if (filters.actorInstitutionStaffId) add('a.actor_institution_staff_id = ?::uuid', filters.actorInstitutionStaffId)
  if (filters.action) add('a.action = ?', filters.action)
  if (filters.resourceType) add('a.resource_type = ?', filters.resourceType)
  if (filters.resourceId) add('a.resource_id = ?', filters.resourceId)
  if (filters.fromDate) add('a.created_at >= ?::date', filters.fromDate)
  if (filters.toDate) add("a.created_at < (?::date + interval '1 day')", filters.toDate)

  return { whereClause: conditions.length ? conditions.join(' AND ') : 'TRUE', params }
}