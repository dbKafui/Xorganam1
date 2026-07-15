# XORGANAM on Eganow — Node.js backend (schema + webhook + worker)

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first — it explains why this backend models
`Tenant → many Merchants` instead of the previous `Tenant == Merchant` shape, and how the two
payout modes map onto Eganow's collection/payout wallet pair.

# XORGANAM on Eganow — Node.js backend

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first — it explains why this backend models
`Tenant → many Merchants` instead of the previous `Tenant == Merchant` shape, and how the two
payout modes map onto Eganow's collection/payout wallet pair.

This is now the complete backend for both frontends: auth, tenant/KYC management, merchant
CRUD, transactions (manual + automated), reporting, and user management — not just the original
schema/webhook/worker slice.

## Setup

```bash
npm install
cp .env.example .env
psql "$DATABASE_URL" -f db/schema.sql
npm run seed:admin        # creates the first PLATFORM_ADMIN account

npm start                 # Express API on :3000
npm run worker             # BullMQ worker - separate process, run at least one
```

Requires PostgreSQL 14+ and Redis.

## Roles

`PLATFORM_ADMIN` (reviews tenant KYC, activates Eganow credentials, sees system-wide reports —
this is who logs into the Backoffice dashboard) and, per tenant, `TENANT_ADMIN` → `TENANT_MANAGER`
→ `TENANT_OPERATOR` → `TENANT_VIEWER` (the Operator portal in the checkout app). A market-woman
Merchant never authenticates at all — she only ever receives SMS.

## Endpoint map

```
POST   /api/v1/public/tenants/register        Operator self-registration + auto-login
GET    /api/v1/public/merchants/:id            Checkout: can this merchant take payments?
POST   /api/v1/public/collect                  Checkout: customer-initiated collection
GET    /api/v1/public/collect/:ref/status       Checkout: poll payment outcome

POST   /api/v1/auth/login                      Operator / platform admin login
GET    /api/v1/auth/me

GET    /api/v1/tenants                         List tenants                    [PLATFORM_ADMIN]
GET    /api/v1/tenants/:id                     Detail + KYC documents
POST   /api/v1/tenants/:id/kyc-documents        Upload a KYC/KYB document (multipart)
POST   /api/v1/tenants/kyc-documents/:id/review Approve/reject                 [PLATFORM_ADMIN]
PUT    /api/v1/tenants/:id/eganow-credentials    Activate Eganow API creds      [PLATFORM_ADMIN]
GET    /api/v1/tenants/:id/config               Read config
PUT    /api/v1/tenants/:id/notification-settings SMS/email provider config    [TENANT_MANAGER+]

GET    /api/v1/merchants?tenantId=              List a tenant's merchants
POST   /api/v1/merchants                        Add a merchant (market woman) [TENANT_MANAGER+]
GET    /api/v1/merchants/:id                    Detail + settings
PUT    /api/v1/merchants/:id                    Update                        [TENANT_MANAGER+]
PUT    /api/v1/merchants/:id/settings           allow_manual_control, notify prefs [TENANT_MANAGER+]

GET    /api/v1/transactions?tenantId=           List, filterable by merchantId/status/type
GET    /api/v1/transactions/:id                 Detail + linked children
POST   /api/v1/transactions/collect             Staff-triggered collection    [TENANT_OPERATOR+]
POST   /api/v1/transactions/internal-transfer    Manual sweep                  [TENANT_MANAGER+]
POST   /api/v1/transactions/payout               Manual payout                 [TENANT_MANAGER+]
POST   /api/v1/transactions/:id/reconcile        Force a status re-check       [TENANT_OPERATOR+]

GET    /api/v1/reports/merchant?merchantId=      One merchant's totals
GET    /api/v1/reports/tenant?tenantId=          Tenant aggregate across merchants
GET    /api/v1/reports/system                    Platform-wide                 [PLATFORM_ADMIN]

GET    /api/v1/users                             List (tenant-scoped, or all for platform admin)
POST   /api/v1/users                             Create                        [TENANT_MANAGER+]
PUT    /api/v1/users/:id/status                  Activate/deactivate           [TENANT_MANAGER+]
POST   /api/v1/users/:id/assign-role             Change role                   [TENANT_MANAGER+]

POST   /api/v1/webhooks/eganow/:tenant_id?       Inbound Eganow callback (HMAC-verified, anonymous)
```

## Webhook listener (`src/routes/webhooks.js`)

Resolves tenant from the URL or the payload's account id, verifies HMAC-SHA256 against that
tenant's own decrypted secret (raw body captured before JSON parsing), logs the collection
idempotently on `(tenant_id, eganow_reference)`, then forks: `AUTO_SWEEP` merchants get a BullMQ
job queued; `MANUAL` merchants get an SMS (and email, if configured) instead.

## Worker (`src/workers/collectForMeWorker.js`)

Sweep (collection → payout account) then disburse (payout account → the merchant's MoMo number),
each its own child `transactions` row, credentials fetched fresh per tenant per call. Three
layers of error isolation: BullMQ's per-job independence, a job-level try/catch that logs and
re-throws, and process-level `unhandledRejection`/`uncaughtException` guards — so tenant A's
expired token can't stall tenant B's jobs or crash the worker process.

## Tenant isolation

Every route that touches tenant-scoped data runs through `resolveTenantScope()`
(`src/middleware/auth.js`) — the single choke point that rejects a non-`PLATFORM_ADMIN` user
trying to act on a tenant that isn't their own, regardless of what's in the request body or query
string. This is on top of, not instead of, the database-level composite foreign keys in the
schema that make it structurally impossible for a `merchant_id` to belong to the wrong
`tenant_id`.

## Known simplifications (flagged, not hidden)

- **Token refresh**: `tenant_eganow_credentials.eganow_refresh_token_encrypted` and
  `access_token_expires_at` are in the schema but there's no refresh-flow implementation —
  needed before this goes to production against a real Eganow OAuth flow.
- **Eganow account provisioning**: adding a merchant requires already knowing her
  `eganow_collection_account_id`/`eganow_payout_account_id` (entered manually via
  `POST /merchants`) — there's no integration with an Eganow sub-account provisioning API, if one
  exists, to generate these automatically.
- **Reference-only ownership on the public status-check endpoint**
  (`GET /public/collect/:reference/status`): relies on the reference being a high-entropy,
  unguessable token rather than checking it against a stored MSISDN, since MSISDN isn't
  persisted per-collection in this schema revision.

