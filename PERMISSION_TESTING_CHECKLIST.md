# Permission System - Testing Checklist

## Quick Start Test (5 minutes)

### 1. Access Team Page
- [ ] Navigate to http://localhost:5174
- [ ] Log in with TENANT_ADMIN account
- [ ] Go to "Team" page

### 2. Select a Team Member
- [ ] Find any team member in the table
- [ ] Click **"Permissions"** button in Actions column
- [ ] Permissions panel should appear below the table

### 3. Verify Role-Based Permissions Display
- [ ] Should see "Role-Based Default Permissions" section
- [ ] Blue background box showing permissions for user's role
- [ ] Green checkmarks (✓) next to each permission
- [ ] Each permission has a description below it

### 4. Verify Custom Permissions Section
- [ ] "Additional Custom Permissions" section visible
- [ ] Should show "No additional permissions granted" initially
- [ ] "Grant Additional Permission" form below

### 5. Test Permission Grant
- [ ] Click on "Permission Type" dropdown
- [ ] Select any permission (e.g., "Initiate Collections")
- [ ] Leave "Scope" as "Tenant-wide"
- [ ] Click **Grant** button
- [ ] Should see success message at top
- [ ] Permission should appear in "Additional Custom Permissions" list with ✓ mark

### 6. Test Merchant-Scoped Permission
- [ ] In form, select "Initiate Payouts" permission
- [ ] Click "Scope" dropdown and select a merchant
- [ ] Description should update
- [ ] Click **Grant** button
- [ ] Permission should show with merchant name and 📍 icon

### 7. Test Permission Removal
- [ ] In "Additional Custom Permissions", find a permission you just added
- [ ] Click **Remove** button
- [ ] Permission should disappear

**Expected Result:** ✅ All permissions display, grant, and revoke successfully

---

## Detailed Test Scenarios

### Test A: New User Permission Flow

**Setup:**
1. Create a new team member:
   - First Name: "Test"
   - Last Name: "User"
   - Email: "test@example.com"
   - Role: "TENANT_OPERATOR"
   - No merchant assigned

**Test:**
1. Click "Permissions" for the new user
2. Verify these default permissions show:
   - INITIATE_COLLECTION ✓
   - VIEW_COLLECTIONS ✓
   - INITIATE_PAYOUT ✓
   - VIEW_PAYOUTS ✓
   - VIEW_MERCHANTS ✓
   - VIEW_REPORTS ✓
   - VIEW_TRANSACTIONS ✓
3. "Additional Custom Permissions" is empty
4. Verify description text shows for each permission

**Expected Result:** ✅ User shows correct default permissions for TENANT_OPERATOR role

---

### Test B: Grant Tenant-Wide Permission

**Setup:** Use "Test User" from Test A

**Test:**
1. Open permissions panel for Test User
2. In "Grant Additional Permission" form:
   - Select: "Manage Collections Settings"
   - Scope: "Tenant-wide" (default)
3. Read description: "Ability to configure collection settings and fees"
4. Click Grant
5. Permission appears with 🌐 icon
6. Refresh page
7. Permission should persist

**Expected Result:** ✅ Permission granted at tenant level and persists across page reloads

---

### Test C: Grant Merchant-Scoped Permission

**Setup:** Use "Test User" from Test A

**Test:**
1. Open permissions panel for Test User
2. In "Grant Additional Permission" form:
   - Select: "Manage Merchants"
   - Scope: Select specific merchant (e.g., "Market Woman 1")
3. Description updates
4. Click Grant
5. Permission appears with 📍 icon and merchant name
6. Grant same permission for another merchant
7. Both permissions should show in the list

**Expected Result:** ✅ Multiple merchant-scoped permissions for same permission type, each showing merchant name

---

### Test D: Revoke Permission

**Setup:** 
1. Grant 2-3 custom permissions to "Test User" (from Tests B and C)

**Test:**
1. Open permissions panel
2. Find a custom permission with Remove button
3. Click Remove
4. Permission disappears from list
5. Reload page
6. Permission should still be gone

**Expected Result:** ✅ Permission removed and removal persists

---

### Test E: Role Change Impact

**Setup:** "Test User" is TENANT_OPERATOR with custom permissions

**Test:**
1. Change user's role to "TENANT_VIEWER"
2. Open permissions panel
3. Role-Based Permissions should change:
   - TENANT_VIEWER has 5 permissions (fewer than OPERATOR)
4. Custom permissions remain in list
5. Change role back to "TENANT_OPERATOR"
6. Role-Based Permissions revert
7. Custom permissions still there

**Expected Result:** ✅ Default permissions update with role; custom permissions persist

---

### Test F: Invalid Permission Type (Backend)

**Setup:** Access backend API directly

**Test (curl or Postman):**
```bash
curl -X POST \
  http://localhost:3000/api/v1/users/{userId}/permissions \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "permissionType": "INVALID_PERMISSION",
    "resourceId": null
  }'
```

**Expected Result:** 
- [ ] 400 status code
- [ ] Message: "Invalid permissionType..."

---

### Test G: Duplicate Permission (Backend)

**Setup:** User already has "INITIATE_COLLECTION" granted

**Test:**
1. Grant "INITIATE_COLLECTION" for same scope again
2. Attempt to grant via UI or API

**Expected Result:**
- [ ] Error message: "This permission already exists"
- [ ] 409 status code

---

### Test H: Permission Scope Validation

**Setup:** Multiple merchants in system

**Test:**
1. Grant permission for "Market Woman 1"
2. Verify merchant dropdown shows merchant by displayName
3. Grant same permission for "Market Woman 2"
4. Both should appear with correct merchant names
5. Grant tenant-wide version of same permission
6. Should have 3 entries:
   - With 📍 Market Woman 1
   - With 📍 Market Woman 2
   - With 🌐 Tenant-wide

**Expected Result:** ✅ All three permission scopes coexist

---

## API Testing

### List Permissions

**Endpoint:**
```
GET /api/v1/users/{userId}/permissions
```

**Test:**
```bash
curl -X GET \
  http://localhost:3000/api/v1/users/{userId}/permissions \
  -H "Authorization: Bearer {token}"
```

**Expected Response:**
```json
[
  {
    "id": "uuid",
    "permissionType": "INITIATE_COLLECTION",
    "resourceId": null,
    "grantedAt": "2024-12-19T10:00:00Z",
    "grantedByUserId": "uuid"
  }
]
```

- [ ] Status: 200 OK
- [ ] Returns array of permissions
- [ ] Includes both role defaults and custom permissions? (No - only custom)
- [ ] Merchant-scoped permissions show resourceId

### Grant Permission

**Endpoint:**
```
POST /api/v1/users/{userId}/permissions
```

**Test (Tenant-Wide):**
```bash
curl -X POST \
  http://localhost:3000/api/v1/users/{userId}/permissions \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "permissionType": "VIEW_FINANCIAL_REPORTS",
    "resourceId": null
  }'
```

**Expected:** 201 Created, permission object returned

**Test (Merchant-Scoped):**
```bash
curl -X POST \
  http://localhost:3000/api/v1/users/{userId}/permissions \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "permissionType": "MANAGE_MERCHANTS",
    "resourceId": "{merchantId}"
  }'
```

**Expected:** 201 Created, permission object with resourceId included

### Revoke Permission

**Endpoint:**
```
DELETE /api/v1/users/{userId}/permissions/{permissionId}
```

**Test:**
```bash
curl -X DELETE \
  http://localhost:3000/api/v1/users/{userId}/permissions/{permissionId} \
  -H "Authorization: Bearer {token}"
```

**Expected:** 200 OK, message: "Permission revoked"

---

## Browser Console Diagnostics

### Enable Logging

Permissions components log to console. Open DevTools (F12):

**When clicking Permissions button, console should show:**
```
Loading permissions for user: {userId}
Permissions loaded: [...]
```

**When granting permission:**
```
Granting permission: PERMISSION_TYPE resource: SCOPE to user: {userId}
Permission granted successfully: {...}
```

**When revoking permission:**
```
Revoking permission: {permissionId} for user: {userId}
Permission revoked successfully
```

### Check for Errors

- [ ] No red error messages in console
- [ ] No 401/403 Unauthorized errors
- [ ] No failed network requests
- [ ] Verify `listUserPermissions` API call succeeds

---

## Known Behaviors

✅ **Role-Based Permissions (Blue Box)**
- Read-only display
- Shows permissions user has by default for their role
- Cannot be removed
- Change role to update

✅ **Custom Permissions (White List)**
- Shown in "Additional Custom Permissions"
- Can be removed
- Include merchant scope indicator (🌐 or 📍)

✅ **Permission Grant Form**
- Shows description while typing
- Dropdown prevents invalid permission types
- Dropdown shows merchant display names
- Submit validates permission type

✅ **Merchant-Scoped Permissions**
- Same permission can exist for multiple merchants
- Can also exist at tenant-wide level
- Each variation is tracked separately

---

## Troubleshooting Guide

### Issue: Permissions Panel Doesn't Appear

**Checklist:**
- [ ] Logged in as TENANT_ADMIN (lower roles don't see panel)
- [ ] Viewing another user (can't manage own permissions)
- [ ] Clicked "Permissions" button in Actions column
- [ ] No errors in console

**Solution:** Check user's role - only TENANT_ADMIN can see permissions panel

---

### Issue: Permissions Not Loading

**Checklist:**
- [ ] Console shows `Loading permissions for user: ...`
- [ ] Check Network tab - does `GET /users/{id}/permissions` return 200?
- [ ] Backend running? `docker compose ps backend`
- [ ] No 401/403 errors?

**Solution:** 
```bash
# Check backend logs
docker compose logs backend --tail=50

# Verify user exists
docker compose exec -T postgres psql -U postgres -d xorganam \
  -c "SELECT id, first_name FROM users LIMIT 5;"
```

---

### Issue: Permission Grant Fails

**Checklist:**
- [ ] Selected valid permission type (not typed manually)
- [ ] User found? (error should say)
- [ ] Tenant scoping correct? (check your tenant)
- [ ] Merchant exists? (if merchant-scoped)

**Backend Error Messages:**
- "User not found." - userId doesn't exist
- "Invalid permissionType..." - permission type not in allowed list
- "This permission already exists." - already granted for that scope

---

### Issue: Duplicate Permissions

**Why it happens:** 
- Clicking Grant button twice quickly
- Granting same permission for same scope

**Expected behavior:**
- Backend returns 409 "This permission already exists"
- UI shows error message
- Permission appears only once

**Solution:** Don't double-click Grant button

---

## Performance Considerations

### Large Permission Lists

If user has 50+ custom permissions:
- List still renders but may scroll
- Use Remove buttons to clean up old permissions
- Consider permission templates (future enhancement)

### Multiple Team Members

Loading permissions for many users:
- Frontend loads on-demand when clicking button
- No performance impact on main Team page
- Each permission loads independently

---

## Success Criteria

✅ All tests pass when:
1. Role-based permissions display correctly
2. Custom permissions can be granted and revoked
3. Merchant-scoped permissions work
4. Permission descriptions show
5. No console errors
6. Backend validation works
7. Permissions persist across page reloads

---

**Last Updated:** December 19, 2024
**Version:** 1.0 - Initial Implementation
