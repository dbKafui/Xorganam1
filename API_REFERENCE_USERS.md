# User Management API Reference

## Base URL
```
/api/v1/users
```

## Authentication
All endpoints require Bearer token authentication.

---

## Endpoints

### List Users
```
GET /users
```

**Query Parameters:**
- `tenantId` (optional) - Filter by tenant (platform admin only)
- `merchantId` (optional) - Filter by merchant

**Response:**
```json
[
  {
    "id": "uuid",
    "tenantId": "uuid",
    "merchantId": "uuid or null",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phoneNumber": "+233123456789",
    "role": "TENANT_MANAGER",
    "isActive": true,
    "createdAt": "2025-01-01T00:00:00Z",
    "lastLoginAt": "2025-01-05T10:30:00Z"
  }
]
```

---

### Create User
```
POST /users
```

**Required Role:** TENANT_MANAGER

**Request Body:**
```json
{
  "firstName": "Jane",
  "lastName": "Smith",
  "email": "jane@example.com",
  "phoneNumber": "+233123456789",
  "password": "SecurePassword123",
  "role": "TENANT_OPERATOR",
  "merchantId": "uuid (optional)",
  "tenantId": "uuid"
}
```

**Notes:**
- Password must be at least 10 characters
- Role must be one of: TENANT_ADMIN, TENANT_MANAGER, TENANT_OPERATOR, TENANT_VIEWER
- merchantId must belong to the specified tenantId
- Email must be unique

**Response:** 201 Created
```json
{
  "id": "uuid",
  "tenantId": "uuid",
  "merchantId": "uuid or null",
  "firstName": "Jane",
  "lastName": "Smith",
  "email": "jane@example.com",
  "phoneNumber": "+233123456789",
  "role": "TENANT_OPERATOR",
  "isActive": true,
  "createdAt": "2025-01-06T00:00:00Z",
  "lastLoginAt": null
}
```

---

### Update User
```
PUT /users/:userId
```

**Required Role:** TENANT_MANAGER

**Request Body (all optional):**
```json
{
  "firstName": "Jane",
  "lastName": "Smith",
  "phoneNumber": "+233987654321",
  "role": "TENANT_MANAGER",
  "isActive": true
}
```

**Response:**
```json
{
  "id": "uuid",
  "tenantId": "uuid",
  "merchantId": "uuid or null",
  "firstName": "Jane",
  "lastName": "Smith",
  "email": "jane@example.com",
  "phoneNumber": "+233987654321",
  "role": "TENANT_MANAGER",
  "isActive": true,
  "createdAt": "2025-01-06T00:00:00Z",
  "lastLoginAt": "2025-01-06T10:30:00Z"
}
```

---

### Suspend User (Disable)
```
POST /users/:userId/suspend
```

**Required Role:** TENANT_MANAGER

**Response:**
```json
{
  "message": "User suspended.",
  "userId": "uuid",
  "isActive": false
}
```

---

### Enable User (Reactivate)
```
POST /users/:userId/enable
```

**Required Role:** TENANT_MANAGER

**Response:**
```json
{
  "message": "User enabled.",
  "userId": "uuid",
  "isActive": true
}
```

---

### Update User Status
```
PUT /users/:userId/status
```

**Required Role:** TENANT_MANAGER

**Request Body:**
```json
{
  "isActive": true
}
```

**Response:**
```json
{
  "message": "User status updated.",
  "userId": "uuid",
  "isActive": true
}
```

---

### Assign Role
```
POST /users/:userId/assign-role
```

**Required Role:** TENANT_MANAGER

**Request Body:**
```json
{
  "role": "TENANT_MANAGER"
}
```

**Response:**
```json
{
  "message": "Role updated.",
  "userId": "uuid",
  "role": "TENANT_MANAGER"
}
```

---

### Assign Merchant
```
POST /users/:userId/assign-merchant
```

**Required Role:** TENANT_MANAGER

**Request Body:**
```json
{
  "merchantId": "uuid"
}
```

**Response:** Updated user object with new merchantId

---

### Unassign Merchant
```
POST /users/:userId/unassign-merchant
```

**Required Role:** TENANT_MANAGER

**Response:** Updated user object with merchantId = null

---

## Permission Management Endpoints

### List User Permissions
```
GET /users/:userId/permissions
```

**Required Role:** TENANT_MANAGER

**Response:**
```json
[
  {
    "id": "uuid",
    "permissionType": "EDIT_MERCHANTS",
    "resourceId": "uuid or null",
    "grantedAt": "2025-01-06T00:00:00Z",
    "grantedByUserId": "uuid"
  }
]
```

---

### Grant Permission
```
POST /users/:userId/permissions
```

**Required Role:** TENANT_ADMIN

**Request Body:**
```json
{
  "permissionType": "EDIT_MERCHANTS",
  "resourceId": "uuid (optional)"
}
```

**Permission Types:**
- `EDIT_MERCHANTS` - Can create/edit merchants
- `APPROVE_PAYOUTS` - Can approve payout requests
- `VIEW_REPORTS` - Can access financial reports
- `MANAGE_USERS` - Can create/manage team members
- `VIEW_TRANSACTIONS` - Can view transaction details
- Custom types as needed

**Response:** 201 Created
```json
{
  "id": "uuid",
  "permissionType": "EDIT_MERCHANTS",
  "resourceId": null,
  "grantedAt": "2025-01-06T12:00:00Z",
  "grantedByUserId": "uuid"
}
```

---

### Revoke Permission
```
DELETE /users/:userId/permissions/:permissionId
```

**Required Role:** TENANT_ADMIN

**Response:**
```json
{
  "message": "Permission revoked.",
  "permissionId": "uuid"
}
```

---

## Role Hierarchy

| Role | Rank | Permissions |
|------|------|-------------|
| PLATFORM_ADMIN | 100 | Full system access |
| TENANT_ADMIN | 40 | Tenant admin + grant/revoke permissions |
| TENANT_MANAGER | 30 | Create/manage team members, manage merchants, transactions |
| TENANT_OPERATOR | 20 | View & execute transactions |
| TENANT_VIEWER | 10 | Read-only access |

---

## Error Responses

### 400 Bad Request
```json
{
  "message": "firstName, lastName, email, password, and role are required."
}
```

### 401 Unauthorized
```json
{
  "message": "Authentication required."
}
```

### 403 Forbidden
```json
{
  "message": "You do not have permission to do this."
}
```

### 404 Not Found
```json
{
  "message": "User not found."
}
```

### 409 Conflict
```json
{
  "message": "A user with this email already exists."
}
```

---

## Usage Examples

### Create a merchant-specific operator
```bash
curl -X POST http://localhost:3000/api/v1/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "John",
    "lastName": "Operator",
    "email": "john.op@merchants.com",
    "password": "SecurePass123!",
    "role": "TENANT_OPERATOR",
    "merchantId": "550e8400-e29b-41d4-a716-446655440000",
    "tenantId": "550e8400-e29b-41d4-a716-446655440001"
  }'
```

### Grant EDIT_MERCHANTS permission to a manager
```bash
curl -X POST http://localhost:3000/api/v1/users/user-id/permissions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "permissionType": "EDIT_MERCHANTS"
  }'
```

### Grant resource-specific permission (specific merchant)
```bash
curl -X POST http://localhost:3000/api/v1/users/user-id/permissions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "permissionType": "APPROVE_PAYOUTS",
    "resourceId": "550e8400-e29b-41d4-a716-446655440000"
  }'
```

### Suspend a user
```bash
curl -X POST http://localhost:3000/api/v1/users/user-id/suspend \
  -H "Authorization: Bearer $TOKEN"
```

### Reactivate a suspended user
```bash
curl -X POST http://localhost:3000/api/v1/users/user-id/enable \
  -H "Authorization: Bearer $TOKEN"
```

### Update user details
```bash
curl -X PUT http://localhost:3000/api/v1/users/user-id \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Janet",
    "phoneNumber": "+233987654321"
  }'
```

---

## Migration Notes

To use these new features:

1. Apply database migration:
   ```bash
   psql -d xorganam -f db/20260717_user_merchant_assignment.sql
   ```

2. Update your frontend to:
   - Add merchant selection when creating users
   - Add user edit/suspend/enable buttons
   - Add permission management UI for TENANT_ADMIN

3. Test all workflows before deploying to production

---

Last Updated: 2025-01-06
