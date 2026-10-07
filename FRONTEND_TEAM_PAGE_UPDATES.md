# Frontend Team Page Updates - Complete Summary

## Overview
The operator checkout Team page (`xorganam-checkout/src/pages/operator/OperatorTeam.jsx`) provides:
1. Merchant assignment and merchant-scoped access for assigned staff on supported endpoints
2. Permission management UI and backend permission checks on the endpoint groups listed below
3. Improved user management UI with dedicated sections
4. Better table layout with consolidated actions

## Changes Made

### 1. Updated State Management
**File:** `xorganam-checkout/src/pages/operator/OperatorTeam.jsx`

Added new state variable to separate concerns:
```javascript
const [merchantAssignmentUser, setMerchantAssignmentUser] = useState(null)
```

- `selectedUser`: Used for permissions management panel
- `merchantAssignmentUser`: Used for merchant assignment in dedicated section
- Prevents state conflicts between different operations

### 2. Restructured Table Layout
**Previous:** Separate columns for Edit, Activate, Permissions, Assign merchant
**New:** Single "Actions" column with context-aware buttons

**Table Columns:**
- Name
- Email
- Role
- Merchant (displays merchant.displayName or "Tenant-level")
- Status (Active/Inactive pill)
- Actions (Edit, Activate/Deactivate, Permissions buttons)

**Actions Column Logic:**
- Edit button: Opens edit form for firstName, lastName, phoneNumber, role
- Activate/Deactivate button: Toggles user active status
- Permissions button: Only visible to TENANT_ADMIN role; shows permissions panel

### 3. Separated Merchant Assignment Section
**Location:** Below the team members table

**Features:**
- Dedicated dropdown to select team member
- When member selected, shows merchant assignment dropdown for that member
- Uses `changeMerchant()` function to update merchant assignment
- Styled with background color and padding for visual separation

```jsx
{canManage && (
  <div style={{ marginTop: 16, padding: 16, backgroundColor: '#f9f9f9', borderRadius: 4 }}>
    <h3>Assign Merchants to Team Members</h3>
    {/* Dropdown selects merchantAssignmentUser */}
    {/* Second dropdown updates merchantAssignmentUser.merchantId */}
  </div>
)}
```

### 4. Improved Permissions Panel
**Location:** Below merchant assignment section (only visible when permissions button clicked)
**Visibility:** Tenant administrators only, matching the backend permission-management routes

**Features:**
- Lists current permissions with merchant names displayed (not just IDs)
- Each permission shows:
  - Permission type (e.g., "MANAGE_COLLECTIONS")
  - Merchant display name if resource-specific (e.g., "• Market Woman 1")
  - Revoke button for removal
- Grant new permissions section with:
  - Permission type dropdown
  - Resource dropdown (Tenant-wide or specific merchant)
  - Grant button
- Styled in card with gray background for the grant section

### 5. API Integration
**File:** `xorganam-checkout/src/api/client.js`

The following API methods are defined in the client and have matching backend route handlers:
```javascript
listUsers: (tenantId, merchantId) => request('/users', { params: { tenantId, merchantId }, auth: true }),
updateUser: (userId, payload) => request(`/users/${userId}`, { method: 'PUT', body: payload, auth: true }),
updateUserStatus: (userId, isActive, merchantId) => request(`/users/${userId}/status`, { method: 'PUT', body: { isActive, merchantId }, auth: true }),
assignRole: (userId, role, merchantId) => request(`/users/${userId}/assign-role`, { method: 'POST', body: { role, merchantId }, auth: true }),
assignMerchant: (userId, merchantId) => request(`/users/${userId}/assign-merchant`, { method: 'POST', body: { merchantId }, auth: true }),
unassignMerchant: (userId) => request(`/users/${userId}/unassign-merchant`, { method: 'POST', auth: true }),
listUserPermissions: (userId) => request(`/users/${userId}/permissions`, { auth: true }),
grantPermission: (userId, payload) => request(`/users/${userId}/permissions`, { method: 'POST', body: payload, auth: true }),
revokePermission: (userId, permissionId) => request(`/users/${userId}/permissions/${permissionId}`, { method: 'DELETE', auth: true })
```

### Backend Permission Checks

The backend checks role defaults and explicit grants for these route groups:

- `VIEW_TRANSACTIONS`: transaction list and detail
- `INITIATE_COLLECTION`: collection initiation
- `INITIATE_PAYOUT`: internal transfer and payout
- `VIEW_MERCHANTS` / `MANAGE_MERCHANTS`: merchant list, detail, create, and update
- `VIEW_REPORTS`: merchant and tenant reports
- `MANAGE_TEAM`: user create, edit, status, role, and merchant assignment
- `MANAGE_PERMISSIONS`: permission list, grant, and revoke; these endpoints also require the tenant-admin role

Merchant and transaction handlers enforce tenant scope and assigned-merchant restrictions. The permission catalog contains additional types; this document does not claim every type is enforced on every route.

The team list returns tenant users to tenant-wide callers, filters to a requested merchant plus tenant-level users when `merchantId` is supplied, and restricts merchant-assigned callers to their assigned merchant. Branch managers are denied access to the team list.

### 6. Backend Data Structure Mapping
**Fields returned from backend** (via `mapUser` in `src/routes/users.js`):
- `id`: UUID
- `tenantId`: UUID (from `tenant_id`)
- `merchantId`: UUID or null (from `merchant_id`)
- `firstName`: string (from `first_name`)
- `lastName`: string (from `last_name`)
- `email`: string
- `phoneNumber`: string (from `phone_number`)
- `role`: string (TENANT_ADMIN, TENANT_MANAGER, TENANT_BRANCH_MANAGER, TENANT_OPERATOR, TENANT_VIEWER)
- `isActive`: boolean (from `is_active`)
- `createdAt`: timestamp (from `created_at`)
- `lastLoginAt`: timestamp (from `last_login_at`)

**Permission fields returned** (via permission query):
- `id`: UUID
- `permissionType`: string (from `permission_type`)
- `resourceId`: UUID or null (from `resource_id`)
- `grantedAt`: timestamp (from `granted_at`)
- `grantedByUserId`: UUID (from `granted_by_user_id`)

### 7. User Flow

#### Creating New Team Member
1. Fill form at bottom (First Name, Last Name, Email, Phone, Password, Role, Optional Merchant)
2. Click "Add team member"
3. Member appears in table with selected merchant if assigned
4. For TENANT_ADMIN, can immediately grant permissions

#### Editing Team Member
1. Click "Edit" button in Actions column
2. Form appears above table showing current details
3. Edit firstName, lastName, phoneNumber, or role
4. Click "Save changes" or "Cancel"
5. Table refreshes with updated information

#### Managing Member Status
1. Click "Activate" or "Deactivate" button in Actions column
2. Status pill updates immediately in table
3. If inactive, member can still see the UI but cannot log in (backend enforced)

#### Assigning Merchants
1. Scroll to "Assign Merchants to Team Members" section
2. Select team member from first dropdown
3. Select merchant from second dropdown (or leave as "Tenant-level")
4. Assignment updates immediately

#### Managing Permissions (TENANT_ADMIN Only)
1. Click "Permissions" button in Actions column for a team member
2. Permissions panel appears showing:
   - Current permissions with merchant names
   - Revoke button for each permission
3. Enter permission type and optional merchant resource
4. Click "Grant" to add permission
5. Panel updates with new permission

## UI/UX Improvements

### Responsive Design
- Actions column uses `whiteSpace: 'nowrap'` to prevent button wrapping
- Buttons spaced with `marginRight: 6` for readability
- Dedicated sections prevent table from becoming too wide

### Visual Clarity
- Merchant assignment section has background color and padding
- Permissions section in a card with subsection for grant form
- Status uses color-coded pills (green for active, red for inactive)
- Merchant names displayed instead of IDs throughout

### Accessibility
- Form labels are associated with their controls using matching `htmlFor` and `id` values
- Buttons have clear text ("Edit", "Activate", "Deactivate", "Grant", "Revoke")
- Empty states show helpful messages
- Error and success messages display prominently

## Verification Status

The API methods and corresponding route handlers are present in the source. Build and interactive behavior have not been verified as part of this review. The following checks remain pending:

- [ ] Build passes without errors (`npm run build`)
- [ ] User listing, creation, editing, and status changes work end to end
- [ ] Merchant assignment respects tenant and assigned-merchant scope
- [ ] Permission grants and revocations update the panel
- [ ] Permission-gated endpoints allow role defaults and valid grants and reject missing grants
- [ ] Form labels are associated with their controls

## Related Files Modified

1. [xorganam-checkout/src/pages/operator/OperatorTeam.jsx](xorganam-checkout/src/pages/operator/OperatorTeam.jsx)
   - Reorganized layout and improved UI

2. [xorganam-checkout/src/api/client.js](xorganam-checkout/src/api/client.js)
   - Added user and permission API methods

3. [xorganam-node-backend/src/routes/users.js](xorganam-node-backend/src/routes/users.js)
   - Implemented user and permission endpoints

4. [xorganam-node-backend/db/20260717_user_merchant_assignment.sql](xorganam-node-backend/db/20260717_user_merchant_assignment.sql)
   - Created user_permissions table and merchant_id column

5. [xorganam-node-backend/src/middleware/auth.js](xorganam-node-backend/src/middleware/auth.js)
   - Added merchant_id to authenticated user context

## Next Steps (If Needed)

1. **Backoffice Dashboard**: Similar updates can be applied to the admin dashboard if needed
2. **Permission Types**: Define standard permission types (e.g., MANAGE_COLLECTIONS, VIEW_REPORTS)
3. **Additional Permission Coverage**: The permission catalog includes types beyond the routes currently gated. Add checks where each remaining permission is intended to authorize a concrete action.
4. **Audit Trail**: Log who granted/revoked permissions and when
5. **Bulk Operations**: Add ability to manage multiple team members' permissions at once
