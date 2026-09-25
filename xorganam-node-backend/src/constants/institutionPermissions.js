export const INSTITUTION_ROLES = Object.freeze({
  FIELD_OFFICER: 'FIELD_OFFICER',
  SUPERVISOR: 'SUPERVISOR',
  INSTITUTION_ADMIN: 'INSTITUTION_ADMIN'
})

export const ROLE_RANK = Object.freeze({
  FIELD_OFFICER: 1,
  SUPERVISOR: 2,
  INSTITUTION_ADMIN: 3
})

export const INSTITUTION_PERMISSIONS = Object.freeze({
  'dashboard:view': ROLE_RANK.FIELD_OFFICER,
  'rule_config:view': ROLE_RANK.FIELD_OFFICER,
  'rule_config:write': ROLE_RANK.INSTITUTION_ADMIN,
  'verification:view_queue': ROLE_RANK.FIELD_OFFICER,
  'verification:action': ROLE_RANK.FIELD_OFFICER,
  'staff:view': ROLE_RANK.SUPERVISOR,
  'staff:manage': ROLE_RANK.INSTITUTION_ADMIN,
  'assignment:manage': ROLE_RANK.SUPERVISOR,
  'dispute:view': ROLE_RANK.FIELD_OFFICER,
  'dispute:raise': ROLE_RANK.FIELD_OFFICER,
  'dispute:resolve': ROLE_RANK.SUPERVISOR,
  'reconciliation:view': ROLE_RANK.FIELD_OFFICER,
  'institution_profile:view': ROLE_RANK.FIELD_OFFICER,
  'institution_profile:write': ROLE_RANK.INSTITUTION_ADMIN
})

export function hasInstitutionPermission(role, permissionKey) {
  const requiredRank = INSTITUTION_PERMISSIONS[permissionKey]
  if (requiredRank === undefined) {
    throw new Error(`Unknown institution permission key: ${permissionKey}`)
  }

  return (ROLE_RANK[role] || 0) >= requiredRank
}