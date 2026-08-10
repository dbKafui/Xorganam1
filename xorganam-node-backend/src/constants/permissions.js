/**
 * Standard permission types available in the system
 * These should match the frontend permissions.js
 */
export const PERMISSION_TYPES = {
  // Collection permissions
  INITIATE_COLLECTION: 'INITIATE_COLLECTION',
  VIEW_COLLECTIONS: 'VIEW_COLLECTIONS',
  MANAGE_COLLECTION_SETTINGS: 'MANAGE_COLLECTION_SETTINGS',
  
  // Payout permissions
  INITIATE_PAYOUT: 'INITIATE_PAYOUT',
  VIEW_PAYOUTS: 'VIEW_PAYOUTS',
  MANAGE_PAYOUT_SETTINGS: 'MANAGE_PAYOUT_SETTINGS',
  
  // Merchant permissions
  VIEW_MERCHANTS: 'VIEW_MERCHANTS',
  MANAGE_MERCHANTS: 'MANAGE_MERCHANTS',
  
  // Reporting and analytics
  VIEW_REPORTS: 'VIEW_REPORTS',
  VIEW_TRANSACTIONS: 'VIEW_TRANSACTIONS',
  VIEW_FINANCIAL_REPORTS: 'VIEW_FINANCIAL_REPORTS',
  
  // Team management
  MANAGE_TEAM: 'MANAGE_TEAM',
  MANAGE_PERMISSIONS: 'MANAGE_PERMISSIONS',
  
  // Account settings
  MANAGE_ACCOUNT_SETTINGS: 'MANAGE_ACCOUNT_SETTINGS',
  MANAGE_KYC: 'MANAGE_KYC'
}

/**
 * Role-based default permissions
 * These permissions are automatically granted based on role
 * Additional permissions can be granted via the permissions system
 */
export const ROLE_PERMISSIONS = {
  TENANT_VIEWER: [
    PERMISSION_TYPES.VIEW_COLLECTIONS,
    PERMISSION_TYPES.VIEW_PAYOUTS,
    PERMISSION_TYPES.VIEW_MERCHANTS,
    PERMISSION_TYPES.VIEW_REPORTS,
    PERMISSION_TYPES.VIEW_TRANSACTIONS
  ],
  TENANT_OPERATOR: [
    PERMISSION_TYPES.INITIATE_COLLECTION,
    PERMISSION_TYPES.VIEW_COLLECTIONS,
    PERMISSION_TYPES.INITIATE_PAYOUT,
    PERMISSION_TYPES.VIEW_PAYOUTS,
    PERMISSION_TYPES.VIEW_MERCHANTS,
    PERMISSION_TYPES.VIEW_REPORTS,
    PERMISSION_TYPES.VIEW_TRANSACTIONS
  ],
  TENANT_MANAGER: [
    PERMISSION_TYPES.INITIATE_COLLECTION,
    PERMISSION_TYPES.VIEW_COLLECTIONS,
    PERMISSION_TYPES.MANAGE_COLLECTION_SETTINGS,
    PERMISSION_TYPES.INITIATE_PAYOUT,
    PERMISSION_TYPES.VIEW_PAYOUTS,
    PERMISSION_TYPES.MANAGE_PAYOUT_SETTINGS,
    PERMISSION_TYPES.VIEW_MERCHANTS,
    PERMISSION_TYPES.MANAGE_MERCHANTS,
    PERMISSION_TYPES.VIEW_REPORTS,
    PERMISSION_TYPES.VIEW_TRANSACTIONS,
    PERMISSION_TYPES.VIEW_FINANCIAL_REPORTS,
    PERMISSION_TYPES.MANAGE_TEAM,
    PERMISSION_TYPES.MANAGE_ACCOUNT_SETTINGS
  ],
  TENANT_ADMIN: [
    // Admins get all permissions
    ...Object.values(PERMISSION_TYPES)
  ]
}

/**
 * Get default permissions for a role
 * @param {string} role - The user role
 * @returns {string[]} Array of permission types
 */
export function getDefaultPermissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || []
}

/**
 * Check if a user has a specific permission
 * Checks both role-based defaults and explicitly granted permissions
 * @param {string} userRole - The user's role
 * @param {Array} grantedPermissions - Array of permission objects with permissionType
 * @param {string} permissionType - The permission to check
 * @param {string} resourceId - Optional resource ID (merchant) for scoped permissions
 * @returns {boolean}
 */
export function hasPermission(userRole, grantedPermissions = [], permissionType, resourceId = null) {
  // Admins always have all permissions
  if (userRole === 'TENANT_ADMIN') return true
  
  // Check role-based default permissions
  const roleDefaults = getDefaultPermissionsForRole(userRole)
  if (roleDefaults.includes(permissionType)) {
    // For scoped permissions, also check if they have it for the specific resource
    if (!resourceId) return true
    // If resourceId is specified, check if they have scoped permission
    return grantedPermissions.some(
      p => p.permissionType === permissionType && p.resourceId === resourceId
    )
  }
  
  // Check explicitly granted permissions
  return grantedPermissions.some(
    p => p.permissionType === permissionType && 
         (!resourceId || !p.resourceId || p.resourceId === resourceId)
  )
}

/**
 * Validate permission type
 * @param {string} permissionType - The permission to validate
 * @returns {boolean}
 */
export function isValidPermissionType(permissionType) {
  return Object.values(PERMISSION_TYPES).includes(permissionType)
}
