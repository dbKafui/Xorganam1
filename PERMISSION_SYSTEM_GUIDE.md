# Permission System Implementation Guide

## Overview

The permission system has been updated to support:
1. **Role-based default permissions** - Each role has predefined permissions
2. **Custom permissions** - Admins can grant additional permissions beyond role defaults
3. **Merchant-scoped permissions** - Permissions can be limited to specific merchants
4. **Permission management UI** - Visual interface to grant, revoke, and manage permissions

## Permission Types

### Collection Permissions
- `INITIATE_COLLECTION` - Can start new collection requests
- `VIEW_COLLECTIONS` - Can view collection history and status
- `MANAGE_COLLECTION_SETTINGS` - Can configure collection settings

### Payout Permissions
- `INITIATE_PAYOUT` - Can initiate payout transactions
- `VIEW_PAYOUTS` - Can view payout history and status
- `MANAGE_PAYOUT_SETTINGS` - Can configure payout settings

### Merchant Permissions
- `VIEW_MERCHANTS` - Can view merchant information
- `MANAGE_MERCHANTS` - Can add/edit merchants

### Reporting Permissions
- `VIEW_REPORTS` - Can access reporting and analytics
- `VIEW_TRANSACTIONS` - Can view transaction details
- `VIEW_FINANCIAL_REPORTS` - Can view financial reports

### Team Management
- `MANAGE_TEAM` - Can add/edit team members
- `MANAGE_PERMISSIONS` - Can grant/revoke permissions

### Account Settings
- `MANAGE_ACCOUNT_SETTINGS` - Can manage account configuration
- `MANAGE_KYC` - Can manage KYC documents

## Role-Based Default Permissions

### TENANT_VIEWER (Read-Only)
- VIEW_COLLECTIONS
- VIEW_PAYOUTS
- VIEW_MERCHANTS
- VIEW_REPORTS
- VIEW_TRANSACTIONS

### TENANT_OPERATOR (Operational)
- INITIATE_COLLECTION
- VIEW_COLLECTIONS
- INITIATE_PAYOUT
- VIEW_PAYOUTS
- VIEW_MERCHANTS
- VIEW_REPORTS
- VIEW_TRANSACTIONS

### TENANT_MANAGER (Management)
- All TENANT_OPERATOR permissions, plus:
- MANAGE_COLLECTION_SETTINGS
- MANAGE_PAYOUT_SETTINGS
- MANAGE_MERCHANTS
- VIEW_FINANCIAL_REPORTS
- MANAGE_TEAM
- MANAGE_ACCOUNT_SETTINGS

### TENANT_ADMIN (Full Control)
- ALL permissions

## Using the Permission System

### Viewing Permissions

1. Navigate to Team page (Operator checkout)
2. Click **"Permissions"** button in Actions column for any team member
3. Permissions panel shows:
   - **Role-Based Default Permissions** (blue background) - Cannot be removed
   - **Custom Permissions** (white background) - Can be removed
   - **Grant Additional Permission** section - To add new permissions

### Granting Custom Permissions

1. In the permissions panel, find "Grant Additional Permission" section
2. Select permission type from dropdown (shows all available permissions)
3. (Optional) Select merchant scope from dropdown
   - Leave as "Tenant-wide" for tenant-level permissions
   - Select specific merchant for merchant-scoped permissions
4. Click **Grant** button
5. Permission appears in "Additional Custom Permissions" section

**Example:**
- Grant `INITIATE_COLLECTION` at tenant level → User can initiate collections for all merchants
- Grant `INITIATE_COLLECTION` for "Market Woman 1" → User can initiate collections only for that merchant

### Revoking Permissions

1. In "Additional Custom Permissions" section
2. Find the permission to remove
3. Click **Remove** button
4. Permission is immediately revoked

**Note:** Role-based default permissions cannot be removed; to limit permissions, change the user's role.

### Merchant-Scoped Permissions

Permissions can be scoped to specific merchants:

**Tenant-wide Permission (🌐):**
- User has the permission for all merchants in the tenant
- Example: INITIATE_COLLECTION (tenant-wide) = can collect from any merchant

**Merchant-Scoped Permission (📍):**
- User has the permission for that specific merchant only
- Example: MANAGE_MERCHANTS for "Market Woman 1" = can only edit that merchant

### Role Changes

When changing a user's role:
1. Their default permissions change automatically
2. Custom permissions remain (unless they conflict with new role)
3. Admin can add/remove custom permissions as needed

## Permission Flow Example

### Scenario: New Operator Team Member

**Initial Setup:**
1. Create user with role `TENANT_OPERATOR`
2. User automatically gets TENANT_OPERATOR default permissions:
   - INITIATE_COLLECTION
   - VIEW_COLLECTIONS
   - INITIATE_PAYOUT
   - VIEW_PAYOUTS
   - VIEW_MERCHANTS
   - VIEW_REPORTS
   - VIEW_TRANSACTIONS

**Customization:**
1. If user should only work with specific merchant:
   - Grant `INITIATE_COLLECTION` for "Market Woman 1"
   - Grant `INITIATE_PAYOUT` for "Market Woman 1"
2. User can now only collect/payout for that merchant
3. They retain tenant-wide view permissions

### Scenario: Promote Operator to Limited Manager

**Current State:** TENANT_OPERATOR role with custom restrictions

**Desired State:** User should manage one merchant

**Steps:**
1. Change role from TENANT_OPERATOR to TENANT_MANAGER
2. Revoke `MANAGE_MERCHANTS` (custom permission)
3. Grant `MANAGE_MERCHANTS` for "Market Woman 1"
4. User now has manager capabilities but limited to one merchant

## API Endpoints

### Get User Permissions
```
GET /api/v1/users/:userId/permissions
Authorization: Bearer {token}
Response:
[
  {
    "id": "uuid",
    "permissionType": "INITIATE_COLLECTION",
    "resourceId": null,  // null = tenant-wide
    "grantedAt": "2024-12-19T10:30:00Z",
    "grantedByUserId": "uuid"
  }
]
```

### Grant Permission
```
POST /api/v1/users/:userId/permissions
Authorization: Bearer {token}
Body:
{
  "permissionType": "INITIATE_COLLECTION",
  "resourceId": "merchant-uuid"  // optional
}
Response: Created permission object
```

### Revoke Permission
```
DELETE /api/v1/users/:userId/permissions/:permissionId
Authorization: Bearer {token}
Response: { "message": "Permission revoked" }
```

## Backend Implementation

### Permission Validation

The backend validates all permission types against defined constants:
```javascript
import { isValidPermissionType, hasPermission } from '../constants/permissions.js'

// Validate
if (!isValidPermissionType(permissionType)) {
  return res.status(400).json({ message: 'Invalid permission type' })
}

// Check permission
if (hasPermission(userRole, grantedPermissions, PERMISSION_TYPES.INITIATE_COLLECTION, merchantId)) {
  // User has permission
}
```

### Adding New Permission Type

1. Add to `PERMISSION_TYPES` in `/constants/permissions.js`
2. Add to relevant `ROLE_PERMISSIONS`
3. Update frontend permission labels and descriptions
4. Update backend permission descriptions if needed

## Frontend Implementation

### Permission Constants

File: `xorganam-checkout/src/constants/permissions.js`

Contains:
- `PERMISSION_TYPES` - All available permission types
- `PERMISSION_LABELS` - Human-readable labels
- `ROLE_PERMISSIONS` - Default permissions by role
- Helper functions: `getPermissionLabel()`, `getPermissionDescription()`, etc.

### Permission UI Component

File: `xorganam-checkout/src/pages/operator/OperatorTeam.jsx`

Shows:
1. Role-based default permissions (read-only, informational)
2. Custom granted permissions (with remove button)
3. Form to grant additional permissions (with dropdown and description)

## Testing the System

### Test 1: Create User and View Default Permissions

1. Create new TENANT_VIEWER user
2. Click Permissions button
3. Should see 5 role-based default permissions
4. "Additional Custom Permissions" should be empty

### Test 2: Grant Custom Permission

1. Select a user
2. In permission form, select `INITIATE_COLLECTION`
3. Click Grant
4. Should appear in "Additional Custom Permissions"

### Test 3: Grant Merchant-Scoped Permission

1. Select a user
2. Select `MANAGE_MERCHANTS` permission type
3. Select a specific merchant from dropdown
4. Click Grant
5. Permission should show with merchant name and 📍 icon

### Test 4: Revoke Permission

1. In "Additional Custom Permissions"
2. Click "Remove" button
3. Permission should disappear
4. Reload page to confirm persistence

### Test 5: Invalid Permission Type (Backend)

1. Use API directly to attempt granting invalid permission type
2. Backend should return 400 error with validation message

### Test 6: Role Change

1. Change user's role
2. Check permissions panel
3. Default permissions should update
4. Custom permissions should remain

## Troubleshooting

### Permissions Not Loading

Check browser console for errors:
1. Open DevTools (F12)
2. Check Console tab for error messages
3. Check Network tab for failed API calls
4. Verify `GET /users/:userId/permissions` returns 200 OK

### Permission Panel Not Showing

1. Verify you are logged in as TENANT_ADMIN
2. Verify you're viewing another user (not your own account)
3. Check if "Permissions" button appears in Actions column
4. Click the button to open panel

### Invalid Permission Type Error

1. Use the dropdown to select permission type (prevents invalid types)
2. Do not enter permission types manually
3. Check backend logs for validation details

### Backend Errors

Check backend logs:
```bash
docker compose logs backend --tail=50
```

## Database Schema

### user_permissions Table

```sql
CREATE TABLE user_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    
    permission_type VARCHAR(100) NOT NULL,
    resource_id UUID,  -- merchant_id for scoped permissions
    
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    CONSTRAINT uq_user_permission UNIQUE (user_id, permission_type, resource_id)
);
```

## Security Considerations

1. **Role-Based Enforcement:** Backend enforces role minimums (TENANT_MANAGER for user ops, TENANT_ADMIN for permissions)
2. **Tenant Scoping:** Users can only grant permissions within their tenant
3. **Merchant Validation:** Merchant resources must belong to the user's tenant
4. **Permission Uniqueness:** Cannot grant same permission twice to same user/resource combo
5. **Audit Trail:** `granted_at` and `granted_by_user_id` track who granted permissions and when

## Future Enhancements

1. **Permission Templates** - Pre-defined permission sets for quick assignment
2. **Bulk Operations** - Grant/revoke permissions to multiple users at once
3. **Permission Inheritance** - Permissions inherited from team/department groups
4. **Time-Limited Permissions** - Permissions that expire after set period
5. **Permission Audit UI** - View history of permission changes
6. **Permission Delegation** - Allow non-admins to delegate some permissions
7. **Permission Conflicts** - Detect and warn about conflicting permissions
8. **Role-Permission Alignment** - Enforce certain permissions for certain roles

---

**Last Updated:** December 19, 2024
**Status:** Complete and ready for testing
