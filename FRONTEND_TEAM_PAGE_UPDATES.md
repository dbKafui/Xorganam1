# Frontend Team Page Updates - Complete Summary

## Overview
Successfully updated the operator checkout Team page (`xorganam-checkout/src/pages/operator/OperatorTeam.jsx`) to support:
1. Merchant-specific user isolation
2. Permission-based access control
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
**Visibility:** `user.role === 'TENANT_ADMIN' && selectedUser`

**Features:**
- Lists current permissions with merchant names displayed (not just IDs)
- Each permission shows:
  - Permission type (e.g., "MANAGE_COLLECTIONS")
  - Merchant display name if resource-specific (e.g., "• Market Woman 1")
  - Revoke button for removal
- Grant new permissions section with:
  - Permission type input field
  - Resource dropdown (Tenant-wide or specific merchant)
  - Grant button
- Styled in card with gray background for the grant section

### 5. API Integration
**File:** `xorganam-checkout/src/api/client.js`

Verified all endpoints are properly defined:
```javascript
listUsers: (tenantId, merchantId) => request('/users', { params: { tenantId, merchantId }, auth: true }),
updateUser: (userId, payload) => request(`/users/${userId}`, { method: 'PUT', body: payload, auth: true }),
updateUserStatus: (userId, isActive) => request(`/users/${userId}/status`, { method: 'PUT', body: { isActive }, auth: true }),
assignMerchant: (userId, merchantId) => request(`/users/${userId}/assign-merchant`, { method: 'POST', body: { merchantId }, auth: true }),
unassignMerchant: (userId) => request(`/users/${userId}/unassign-merchant`, { method: 'POST', auth: true }),
listUserPermissions: (userId) => request(`/users/${userId}/permissions`, { auth: true }),
grantPermission: (userId, payload) => request(`/users/${userId}/permissions`, { method: 'POST', body: payload, auth: true }),
revokePermission: (userId, permissionId) => request(`/users/${userId}/permissions/${permissionId}`, { method: 'DELETE', auth: true })
```

### 6. Backend Data Structure Mapping
**Fields returned from backend** (via `mapUser` in `src/routes/users.js`):
- `id`: UUID
- `tenantId`: UUID (from `tenant_id`)
- `merchantId`: UUID or null (from `merchant_id`)
- `firstName`: string (from `first_name`)
- `lastName`: string (from `last_name`)
- `email`: string
- `phoneNumber`: string (from `phone_number`)
- `role`: string (TENANT_ADMIN, TENANT_MANAGER, TENANT_OPERATOR, TENANT_VIEWER)
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
- All form fields have proper labels
- Buttons have clear text ("Edit", "Activate", "Deactivate", "Grant", "Revoke")
- Empty states show helpful messages
- Error and success messages display prominently

## Testing Checklist

- [x] Build passes without errors (`npm run build`)
- [x] All API endpoints properly defined in client
- [x] Backend schema includes merchant_id and user_permissions table
- [x] User list loads with merchants data
- [x] Table displays all team members correctly
- [x] Edit form opens and closes properly
- [x] Activate/Deactivate buttons work
- [x] Merchant assignment section functional
- [x] Permissions panel visible only to TENANT_ADMIN
- [x] Permission listing shows merchant names
- [x] Grant/Revoke permissions functional
- [x] Merchant dropdown displays displayName correctly

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
3. **Permission Enforcement**: Backend services can check permissions in request handling
4. **Audit Trail**: Log who granted/revoked permissions and when
5. **Bulk Operations**: Add ability to manage multiple team members' permissions at once
