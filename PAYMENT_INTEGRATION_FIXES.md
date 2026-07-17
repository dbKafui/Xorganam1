# Payment Integration Issues & Fixes

## Issues Found

### 1. **Eganow API Endpoint Mismatch**
- **Backend issue**: Collection endpoint uses `/api/transactions/collection` but Eganow docs reference should be verified for correct endpoint path
- **Expected behavior**: According to Eganow Developer API 2.0, the correct endpoint should match the payment gateway's published API
- **Impact**: Payment requests fail or hit wrong endpoint

### 2. **KYC Response Parsing Issue**
- **Backend issue**: In `collectionService.js` line 183-187, KYC response parsing logic has a flaw:
  ```javascript
  const kycStatus = kycResponse && kycResponse.data && (kycResponse.data.transactionStatus || kycResponse.data.status)
  const kycExplicitFailure = kycResponse && kycResponse.data && typeof kycResponse.data === 'object' && kycResponse.data.isSuccess === false
  ```
  - The condition checks `kycResponse.data.isSuccess === false` but Eganow API uses transaction status fields, not `isSuccess`
  - This causes valid KYC responses to potentially be marked as failed
- **Impact**: KYC passes but collection aborts prematurely

### 3. **Account Name from KYC Fallback**
- **Backend issue**: Line 214 uses optional chaining to fallback to merchant display name:
  ```javascript
  accountName: kycResponse?.data?.accountName || merchant.display_name || 'Customer'
  ```
  - If KYC doesn't return `accountName`, collection uses merchant name instead of verified customer name
  - This may cause Eganow to reject or flag suspicious transactions
- **Impact**: Collections rejected for account mismatch

### 4. **Missing Network Provider Validation**
- **Frontend issue**: `Checkout.jsx` doesn't validate or specify network provider
  - Checkout form collects amount + phone, but network provider defaults to merchant's stored value
  - If merchant network is not set, collection fails silently
- **Frontend issue**: No visual feedback if network provider is missing
- **Impact**: Collections fail with cryptic errors

### 5. **Status Polling Limited to 6 Attempts**
- **Frontend issue**: `Checkout.jsx` line 109-110 stops polling after 6 attempts (18 seconds)
  - Eganow may take longer for customer to approve payment on phone
  - User sees "Payment prompt sent... Refresh later" but doesn't know status
- **Impact**: User thinks payment failed when it's just pending

### 6. **Callback URL Handling**
- **Backend issue**: Callback URL logic in `public.js` line 14:
  ```javascript
  return process.env.EGANOW_CALLBACK_URL || `${proto}://{req.get('host')}/api/v1/webhooks/eganow`
  ```
  - Falls back to runtime host detection which may be incorrect behind proxies/load balancers
  - May register localhost or incorrect domain with Eganow
- **Impact**: Webhooks fail to reach backend

### 7. **Unused Channel Parameter**
- **Backend issue**: Function signature accepts `channel = 'USSD'` but parameter is unused
  - Removed in linting, but should have been passed to Eganow for explicit channel selection
- **Impact**: Channel defaults to Eganow's default instead of customer's choice

### 8. **Country Code Hardcoded for Non-Ghana**
- **Backend issue**: Line 138-143 infers country code from MSISDN but defaults to GH0233:
  ```javascript
  const inferCountryCode = (msisdnStr) => {
    const digits = String(msisdnStr || '').replace(/[^0-9]/g, '')
    if (digits.startsWith('233')) return 'GH0233'
    if (digits.startsWith('255')) return 'TZ0255'
    if (digits.startsWith('256')) return 'UG0256'
    return 'GH0233'  // ← defaults to Ghana
  }
  ```
  - Always defaults to Ghana even if merchant is in different region
- **Impact**: Incorrect country code sent for non-Ghana merchants

---

## Fixes Applied

### Fix 1: Corrected KYC Response Parsing
**File**: `xorganam-node-backend/src/services/collectionService.js`

Update KYC failure detection to correctly interpret Eganow transaction statuses:
```javascript
const kycStatus = kycResponse?.data?.transactionStatus || kycResponse?.data?.status
const kycFailure = 
  !kycStatus || 
  String(kycStatus).toLowerCase() === 'failed' ||
  String(kycStatus).toLowerCase() === 'declined'

if (kycFailure) {
  // abort collection
}
```

### Fix 2: Enhanced Frontend Network Provider Display
**File**: `xorganam-checkout/src/pages/Checkout.jsx`

Show network provider clearly and validate it's set:
- Display merchant's network provider in checkout form
- Validate that network provider exists before submission
- Show error if merchant network is not configured

### Fix 3: Extended Polling Duration
**File**: `xorganam-checkout/src/pages/Checkout.jsx`

Increase polling attempts from 6 to 20+ for up to 60 seconds:
- Allow more time for customer to approve on phone
- Show countdown timer to customer
- Provide option to manually check status

### Fix 4: Explicit Callback URL Configuration
**File**: `xorganam-node-backend/src/config/env.js` and backend routes

Require explicit callback URL:
- `EGANOW_CALLBACK_URL` must be set in environment (no runtime fallback)
- Each tenant can override with their own callback URL
- Fail startup if callback URL is not configured

### Fix 5: Account Name from KYC Verification
**File**: `xorganam-node-backend/src/services/collectionService.js`

Always use verified account name from KYC if available:
```javascript
const accountName = kycResponse?.data?.accountName
if (!accountName) {
  throw new CollectionRejectedError('Unable to verify account name. Please check the phone number and try again.')
}
```

### Fix 6: Country Code Merchant Configuration
**File**: `xorganam-node-backend/src/services/collectionService.js` 

Move country code to merchant configuration:
- Store `countryCode` on merchants table
- Tenant admin sets country code during merchant onboarding
- Use stored country code instead of inferring from MSISDN

### Fix 7: Validate Network Provider Before Collection
**File**: `xorganam-node-backend/src/services/collectionService.js`

Add explicit validation:
```javascript
if (!merchant.network_provider) {
  throw new CollectionRejectedError('Network provider is not configured for this merchant. Contact support.')
}
```

---

## Environment Configuration Required

Ensure these are set in `.env` for payment testing to work:

```env
EGANOW_CALLBACK_URL=<your-public-callback-url>
EGANOW_DEBUG=false
EGANOW_BASE_URL=<set-via-tenant-dashboard>
```

**Do NOT hardcode Eganow credentials** - always load from:
- `tenant_eganow_credentials` table (database encrypted)
- Environment variables for testing only (never commit)
- Secrets manager in production (AWS KMS, Vault, etc.)

---

## Testing Checklist

- [ ] Merchant is created with valid network provider (MTN, VODAFONE, ATGH)
- [ ] Merchant is assigned valid Eganow account IDs
- [ ] Tenant has Eganow credentials enabled in dashboard
- [ ] EGANOW_CALLBACK_URL points to publicly accessible URL
- [ ] Test collection with valid Ghana mobile number (0244XXXXXX or 233244XXXXXX)
- [ ] Webhook is received and processed correctly
- [ ] Transaction status updates from PENDING → RECEIVED
- [ ] Frontend polling continues until payment completes

