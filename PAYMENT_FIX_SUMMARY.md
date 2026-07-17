# Payment Flow Fix Summary

## Problem
Eganow collection requests were failing silently with null responses:
```json
{
  "transactionStatus": null,
  "eganowReferenceNo": null,
  "message": null
}
```

This caused transactions to be stuck in PENDING status and customers never received USSD prompts.

## Root Cause
The collection request body included **card payment fields** that are invalid for mobile money (USSD) transactions:
- `expiryDateMonth: 0`
- `expiryDateYear: 0`
- `cvv: ''`

Eganow rejected these requests silently, returning null values for all response fields.

## Solution
Removed card-specific fields from the collection request payload in `xorganam-node-backend/src/services/collectionService.js`:

**Before:**
```javascript
const body = {
  paypartnerCode,
  amount,
  accountNoOrCardNoOrMSISDN: normalizedMsisdn,
  countryCode,
  accountName: kycResponse?.data?.accountName || merchant.display_name || 'Customer',
  transactionId: internalReference,
  narration,
  transCurrencyIso: 'GHS',
  expiryDateMonth: 0,        // ❌ REMOVED
  expiryDateYear: 0,          // ❌ REMOVED
  cvv: '',                    // ❌ REMOVED
  languageId: 'en',
  callback: callbackUrl
}
```

**After:**
```javascript
const body = {
  paypartnerCode,
  amount,
  accountNoOrCardNoOrMSISDN: normalizedMsisdn,
  countryCode,
  accountName: kycResponse?.data?.accountName || merchant.display_name || 'Customer',
  transactionId: internalReference,
  narration: narration || undefined,
  transCurrencyIso: 'GHS',
  languageId: 'en',
  callback: callbackUrl
}
```

## Results After Fix
### Before
```
Status: 404
Response: { transactionStatus: null, eganowReferenceNo: null, message: null }
```

### After
```
Status: 200
Response: {
  transactionStatus: 'PENDING',
  eganowReferenceNo: 'GHOD41B38A59795140D58178EFD3BDCEEE3D',
  message: 'Transaction initiated'
}
```

## Testing
Verified with test collection request:
```bash
POST /api/v1/public/collect
{
  "merchantId": "96595d2f-1eda-44c9-9ff2-8d8dc1f50a7d",
  "amount": 5,
  "msisdn": "0547620052",
  "network": "MTNGH"
}
```

Response:
```json
{
  "reference": "COL-1784143231394-0A86CB12",
  "status": "PENDING",
  "paymentGatewayStatus": "pending",
  "failureReason": null,
  "message": "Check your phone to approve the payment prompt."
}
```

Transaction recorded in database with PENDING status and ready for polling.

## What Works Now
1. ✅ Collection requests properly formatted for mobile money
2. ✅ Eganow accepts requests and returns valid references
3. ✅ Transactions tracked with both internal and Eganow references
4. ✅ Callback URLs properly configured per tenant
5. ✅ USSD prompts ready to be sent to customer phones
6. ✅ Status polling configured to track payment completion

## Additional Context
- All previous configuration fixes remain in place:
  - Per-tenant callback URL support
  - Callback URL configurable via dashboard
  - Verbose HTTP logging enabled with `EGANOW_DEBUG=true`
  - Developer base URL validation allows `developer.deveganowapi.com`
  - Request-host fallback callback still functional

## Deployment
Backend container restarted with new code. All services operational.
