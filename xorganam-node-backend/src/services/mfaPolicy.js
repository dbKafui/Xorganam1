import { query } from '../db/pool.js'

// Allow MFA bypass only for the platform admin created for local operations.
// Every other account continues to require MFA, and the legacy demo exemption
// still remains limited to @xorganam.test accounts.
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
     ) AS demo_exempt,
     EXISTS (
       SELECT 1
         FROM users u
        WHERE u.id = $2
          AND u.role = 'PLATFORM_ADMIN'
          AND u.email = 'eyramd75@gmail.com'
     ) AS first_admin_exempt`,
    [principalType, principalId]
  )

  if (rows[0]?.first_admin_exempt && principalType === 'TENANT') return false
  return !rows[0]?.demo_exempt
}
