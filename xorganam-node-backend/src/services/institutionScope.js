function safeAlias(alias) {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) {
    throw new Error('Invalid SQL alias.')
  }
  return alias
}

export function institutionLinkScope(alias, auth, firstParameter = 1) {
  const table = safeAlias(alias)
  const institutionParameter = `$${firstParameter}`
  const staffParameter = `$${firstParameter + 1}`
  const institutionClause = `${table}.institution_id = ${institutionParameter}`

  if (auth.role === 'INSTITUTION_ADMIN') {
    return { clause: institutionClause, params: [auth.institutionId] }
  }

  if (auth.role === 'FIELD_OFFICER') {
    return {
      clause: `${institutionClause}
        AND EXISTS (
          SELECT 1 FROM institution_member_assignment scope_assignment
           WHERE scope_assignment.tenant_institution_link_id = ${table}.id
             AND scope_assignment.institution_id = ${institutionParameter}
             AND scope_assignment.field_officer_staff_id = ${staffParameter}
             AND scope_assignment.escalated_to_supervisor_id IS NULL
             AND scope_assignment.effective_to IS NULL
        )`,
      params: [auth.institutionId, auth.id]
    }
  }

  if (auth.role === 'SUPERVISOR') {
    return {
      clause: `${institutionClause}
        AND (
          EXISTS (
            SELECT 1
              FROM institution_member_assignment scope_assignment
              JOIN institution_staff_hierarchy scope_hierarchy
                ON scope_hierarchy.institution_id = scope_assignment.institution_id
               AND scope_hierarchy.field_officer_staff_id = scope_assignment.field_officer_staff_id
               AND scope_hierarchy.effective_to IS NULL
             WHERE scope_assignment.tenant_institution_link_id = ${table}.id
               AND scope_assignment.institution_id = ${institutionParameter}
               AND (
                 scope_hierarchy.supervisor_staff_id = ${staffParameter}
                 OR scope_assignment.escalated_to_supervisor_id = ${staffParameter}
               )
               AND scope_assignment.effective_to IS NULL
          )
          OR NOT EXISTS (
            SELECT 1 FROM institution_member_assignment unassigned_scope
             WHERE unassigned_scope.tenant_institution_link_id = ${table}.id
               AND unassigned_scope.institution_id = ${institutionParameter}
               AND unassigned_scope.effective_to IS NULL
          )
        )`,
      params: [auth.institutionId, auth.id]
    }
  }

  return { clause: 'FALSE', params: [] }
}

export function institutionDisputeScope(alias, auth, firstParameter = 1) {
  const table = safeAlias(alias)
  const institutionParameter = `$${firstParameter}`
  const staffParameter = `$${firstParameter + 1}`
  const institutionClause = `${table}.institution_id = ${institutionParameter}`
  if (auth.role === 'INSTITUTION_ADMIN') {
    return { clause: institutionClause, params: [auth.institutionId] }
  }

  let linkCondition
  if (auth.role === 'FIELD_OFFICER') {
    linkCondition = `EXISTS (
      SELECT 1 FROM institution_member_assignment a
       WHERE a.tenant_institution_link_id = l.id
         AND a.institution_id = l.institution_id
         AND a.field_officer_staff_id = ${staffParameter}
         AND a.escalated_to_supervisor_id IS NULL
         AND a.effective_to IS NULL
    )`
  } else if (auth.role === 'SUPERVISOR') {
    linkCondition = `(NOT EXISTS (
      SELECT 1 FROM institution_member_assignment a
       WHERE a.tenant_institution_link_id = l.id AND a.effective_to IS NULL
    ) OR EXISTS (
      SELECT 1 FROM institution_member_assignment a
      JOIN institution_staff_hierarchy h
        ON h.institution_id = a.institution_id
       AND h.field_officer_staff_id = a.field_officer_staff_id
       AND h.effective_to IS NULL
       WHERE a.tenant_institution_link_id = l.id
         AND a.institution_id = l.institution_id
         AND (h.supervisor_staff_id = ${staffParameter}
              OR a.escalated_to_supervisor_id = ${staffParameter})
         AND a.effective_to IS NULL
    ) OR EXISTS (
      SELECT 1 FROM institution_member_assignment escalated_assignment
       WHERE escalated_assignment.tenant_institution_link_id = l.id
         AND escalated_assignment.institution_id = l.institution_id
         AND escalated_assignment.escalated_to_supervisor_id = ${staffParameter}
         AND escalated_assignment.effective_to IS NULL
    ))`
  } else {
    return { clause: 'FALSE', params: [] }
  }

  return {
    clause: `${institutionClause}
      AND EXISTS (
        SELECT 1
          FROM tenant_institution_links l
         WHERE l.institution_id = ${table}.institution_id
           AND l.tenant_id = ${table}.tenant_id
           AND ${linkCondition}
      )`,
    params: [auth.institutionId, auth.id]
  }
}

export const institutionScopeInternals = { safeAlias }