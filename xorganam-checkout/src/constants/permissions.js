// Standard permission types available in the system
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

// Readable labels for permissions
export const PERMISSION_LABELS = {
  [PERMISSION_TYPES.INITIATE_COLLECTION]: 'Initiate Collections',
  [PERMISSION_TYPES.VIEW_COLLECTIONS]: 'View Collections',
  [PERMISSION_TYPES.MANAGE_COLLECTION_SETTINGS]: 'Manage Collection Settings',
  [PERMISSION_TYPES.INITIATE_PAYOUT]: 'Initiate Payouts',
  [PERMISSION_TYPES.VIEW_PAYOUTS]: 'View Payouts',
  [PERMISSION_TYPES.MANAGE_PAYOUT_SETTINGS]: 'Manage Payout Settings',
  [PERMISSION_TYPES.VIEW_MERCHANTS]: 'View Merchants',
  [PERMISSION_TYPES.MANAGE_MERCHANTS]: 'Manage Merchants',
  [PERMISSION_TYPES.VIEW_REPORTS]: 'View Reports',
  [PERMISSION_TYPES.VIEW_TRANSACTIONS]: 'View Transactions',
  [PERMISSION_TYPES.VIEW_FINANCIAL_REPORTS]: 'View Financial Reports',
  [PERMISSION_TYPES.MANAGE_TEAM]: 'Manage Team Members',
  [PERMISSION_TYPES.MANAGE_PERMISSIONS]: 'Manage Permissions',
  [PERMISSION_TYPES.MANAGE_ACCOUNT_SETTINGS]: 'Manage Account Settings',
  [PERMISSION_TYPES.MANAGE_KYC]: 'Manage KYC Documents'
}

// Role-based default permissions
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
 * Get the default permissions for a given role
 */
export function getDefaultPermissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || []
}

/**
 * Get all available permissions
 */
export function getAllPermissions() {
  return Object.values(PERMISSION_TYPES)
}

/**
 * Get permission label
 */
export function getPermissionLabel(permissionType) {
  return PERMISSION_LABELS[permissionType] || permissionType
}

/**
 * Get permission description
 */
export function getPermissionDescription(permissionType) {
  const descriptions = {
    [PERMISSION_TYPES.INITIATE_COLLECTION]: 'Ability to start new collection requests for assigned merchant(s)',
    [PERMISSION_TYPES.VIEW_COLLECTIONS]: 'Ability to view collection history and status',
    [PERMISSION_TYPES.MANAGE_COLLECTION_SETTINGS]: 'Ability to configure collection settings and fees',
    [PERMISSION_TYPES.INITIATE_PAYOUT]: 'Ability to initiate payout transactions for assigned merchant(s)',
    [PERMISSION_TYPES.VIEW_PAYOUTS]: 'Ability to view payout history and status',
    [PERMISSION_TYPES.MANAGE_PAYOUT_SETTINGS]: 'Ability to configure payout settings and accounts',
    [PERMISSION_TYPES.VIEW_MERCHANTS]: 'Ability to view merchant information',
    [PERMISSION_TYPES.MANAGE_MERCHANTS]: 'Ability to add, edit, and manage merchants',
    [PERMISSION_TYPES.VIEW_REPORTS]: 'Ability to access reporting and analytics',
    [PERMISSION_TYPES.VIEW_TRANSACTIONS]: 'Ability to view transaction details',
    [PERMISSION_TYPES.VIEW_FINANCIAL_REPORTS]: 'Ability to view financial reports and statements',
    [PERMISSION_TYPES.MANAGE_TEAM]: 'Ability to add and edit team members',
    [PERMISSION_TYPES.MANAGE_PERMISSIONS]: 'Ability to grant and revoke permissions',
    [PERMISSION_TYPES.MANAGE_ACCOUNT_SETTINGS]: 'Ability to manage account configuration',
    [PERMISSION_TYPES.MANAGE_KYC]: 'Ability to manage KYC documents and verification'
  }
  return descriptions[permissionType] || ''
}

/**
 * Check if a permission is granted (or can be inferred from role)
 */
export function hasPermission(userRole, grantedPermissions, permissionType) {
  // Check if it's a default role permission
  const roleDefaults = getDefaultPermissionsForRole(userRole)
  if (roleDefaults.includes(permissionType)) return true
  
  // Check if it's in the explicitly granted permissions
  return grantedPermissions.some(p => p.permissionType === permissionType)
}
