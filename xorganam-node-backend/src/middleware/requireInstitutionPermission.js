import { hasInstitutionPermission } from '../constants/institutionPermissions.js'

export function requireInstitutionPermission(permissionKey) {
  return (req, res, next) => {
    const role = req.institutionAuth?.role
    if (!role || !hasInstitutionPermission(role, permissionKey)) {
      return res.status(403).json({ message: 'You do not have permission to do this.' })
    }
    next()
  }
}