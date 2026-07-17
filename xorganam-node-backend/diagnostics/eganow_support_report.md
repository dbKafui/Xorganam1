# Eganow Support Report (sanitized)

Purpose: reproduce and escalate ambiguous gateway failures observed during tenant-scoped collection attempts. The gateway returns an unstructured string "Failed. Please try again later." (HTTP 200) for both KYC and collection requests and does not provide a transaction id, preventing prompt delivery to customers.

---

Summary
- Tenant: 8dd3ca13-c813-47c7-9444-c35c2b20539a
- Merchant used in repro: 96595d2f-1eda-44c9-9ff2-8d8dc1f50a7d
- Internal reference (our system): `COL-1784216509324-389DC95E`
- Observed gateway response body: `Failed. Please try again later.` (HTTP 200)
- Outcome: no `transactionId`/gateway reference returned; our transaction remains PENDING with no prompt delivered.

---

Sanitized request/response (KYC)

Request (POST https://developer.deveganowapi.com/api/vas/kyc)
Headers:
- Accept: application/json, text/plain, */*
- Content-Type: application/json
- Authorization: REDACTED
- x-Auth: REDACTED

Body:
{
  "paypartnerCode": "MTNGH",
  "mobileNumber": "***0052",
  "accountNoOrCardNoOrMSISDN": "***0052",
  "languageId": "en",
  "countryCode": "GH0233"
}

Response (200 OK)
- Body: `Failed. Please try again later.`

---

Sanitized request/response (Collection)

Request (POST https://developer.deveganowapi.com/api/transactions/collection)
Headers:
- Accept: application/json, text/plain, */*
- Content-Type: application/json
- Authorization: REDACTED
- x-Auth: REDACTED

Body:
{
  "paypartnerCode": "MTNGH",
  "amount": 1,
  "accountNoOrCardNoOrMSISDN": "233547620052",
  "countryCode": "GH0233",
  "accountName": "majestic",
  "transactionId": "COL-1784216509324-389DC95E",
  "eganowCollectionAccountId": "mcoll0012345",
  "narration": null,
  "transCurrencyIso": "GHS",
  "languageId": "en",
  "callback": "https://webhook.site/6063bf1e-9146-442d-a9ab-1f669f649b96"
}

Response (200 OK)
- Body: `Failed. Please try again later.`
- No JSON with `transactionId` or `reference` returned.

---

DB snapshot (transactions row)
- internal_reference: COL-1784216509324-389DC95E
- status: PENDING
- payment_gateway_status: "Failed. Please try again later."
- eganow_transaction_id: NULL

---

What we tried
- Ensured tenant credentials (base URL, x-Auth, api username/secret) are set for tenant.
- Executed backend reproduction script that performs token acquisition, KYC, then collection.
- Confirmed token acquisition succeeds (developerJwtToken obtained).
- Both KYC and collection return the same unstructured failure string (HTTP 200).

Reproduction steps (for gateway support)
1. Use tenant credentials for tenant id `8dd3ca13-c813-47c7-9444-c35c2b20539a`.
2. POST to `/api/auth/token` to obtain developerJwtToken using provided api username/secret.
3. POST to `/api/vas/kyc` with body shown above for paypartnerCode=MTNGH and MSISDN 233547620052.
4. Observe response body `Failed. Please try again later.` (HTTP 200).
5. POST to `/api/transactions/collection` with body shown above (include `transactionId` equal to internal reference).
6. Observe response body `Failed. Please try again later.` (HTTP 200) and **no** transaction id in JSON.

Suggested questions for gateway support
- Why are KYC and collection endpoints returning an unstructured failure string instead of structured JSON including a transaction identifier or error code?
- Is there any tenant-level configuration or routing causing these requests to be rejected silently? (We used developer sandbox endpoint `developer.deveganowapi.com`.)
- Are there additional headers or parameters required for developer/sandbox mode that differ from production?
- Can you provide server-side logs for the incoming requests with our `transactionId` `COL-1784216509324-389DC95E` to explain the failure reason?

Attachments (available if needed)
- Full debug logs (redacted) from backend showing token request/response, KYC request/response, collection request/response and timestamps.
- DB snapshot of the transactions row.

---

Next steps we can take
- Provide full redacted headers and raw responses for gateway support (we can include raw dumps with tokens/x-Auth redacted).
- Swap tenant to a non-sandbox/prod endpoint (if available) and re-run the repro to compare behavior.



