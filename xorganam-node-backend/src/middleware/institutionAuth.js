import { verifyToken } from '../security/jwt.js'
import { query } from '../db/pool.js'

export const INSTITUTION_ROLE_RANK = Object.freeze({
  FIELD_OFFICER: 1,
  SUPERVISOR: 2,
  INSTITUTION_ADMIN: 3
})

export async function institutionAuthenticate(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' })
  }

  let payload
  try {
    payload = verifyToken(header.slice('Bearer '.length))
  } catch {
    return res.status(401).json({ message: 'Invalid or expired session.' })
  }

  if (!payload.institutionId || !payload.institutionStaffId) {
    return res.status(401).json({ message: 'Institution session is missing required claims.' })
  }

  try {
    const { rows } = await query(
      `SELECT s.id, s.institution_id, s.branch_id, s.first_name, s.last_name,
              s.email, s.role, s.is_active, i.status AS institution_status
         FROM institution_staff s
         JOIN institutions i ON i.id = s.institution_id
        WHERE s.id = $1 AND s.institution_id = $2`,
      [payload.institutionStaffId, payload.institutionId]
    )

    if (rows.length === 0 || !rows[0].is_active || rows[0].institution_status !== 'ACTIVE') {
      return res.status(401).json({ message: 'Invalid or expired session.' })
    }

    const staff = rows[0]
    req.institutionAuth = {
      id: staff.id,
      institutionId: staff.institution_id,
      branchId: staff.branch_id,
      role: staff.role,
      firstName: staff.first_name,
      lastName: staff.last_name,
      email: staff.email
    }
    req.institution = { id: staff.institution_id }
    next()
  } catch (error) {
    console.error('[institutionAuth] failed to load staff for token', error)
    res.status(500).json({ message: 'Authentication failed.' })
  }
}

export function requireInstitutionRole(minimumRole) {
  const minimumRank = INSTITUTION_ROLE_RANK[minimumRole]
  if (minimumRank === undefined) {
    throw new Error(`Unknown institution role in requireInstitutionRole(): ${minimumRole}`)
  }

  return (req, res, next) => {
    if (!req.institutionAuth) return res.status(401).json({ message: 'Authentication required.' })

    const userRank = INSTITUTION_ROLE_RANK[req.institutionAuth.role] ?? 0
    if (userRank < minimumRank) {
      return res.status(403).json({ message: 'You do not have permission to do this.' })
    }

    next()
  }
}
