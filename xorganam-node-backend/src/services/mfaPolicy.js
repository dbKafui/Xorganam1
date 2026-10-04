import { query } from '../db/pool.js'

// Only explicitly listed @xorganam.test demo accounts can bypass MFA. The
// domain check here keeps an exemption from becoming a general user bypass.
export async function isMfaRequired(principalType, principalId) {
  const { rows } = await query(
    `SELECT EXISTS (
       SELECT 1
         FROM platform_demo_mfa_exemptions e
        WHERE e.principal_type = $1 AND e.principal_id = $2 AND e.enabled
          AND (
            ($1 = 'TENANT' AND EXISTS (
              SELECT 1 FROM users u WHERE u.id = e.principal_id AND u.email LIKE '%@xorganam.test'
            )) OR
            ($1 = 'INSTITUTION' AND EXISTS (
              SELECT 1 FROM institution_staff s WHERE s.id = e.principal_id AND s.email LIKE '%@xorganam.test'
            ))
          )
     ) AS exempt`,
    [principalType, principalId]
  )
  return !rows[0]?.exempt
}
