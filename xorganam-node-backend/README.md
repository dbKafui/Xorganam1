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
POST   /api/v1/public/tenants/register        Operator self-registration; MFA enrollment is required at sign-in
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

POST   /api/v1/credit-plans                      Create a hire-purchase plan       [TENANT_ADMIN/MANAGER]
GET    /api/v1/credit-plans                      List merchant credit plans       [TENANT]
GET    /api/v1/credit-plans/:id                  Plan and installment details     [TENANT]
POST   /api/v1/credit-plans/:id/installments/:iid/manual-payment  Record cash installment [TENANT]
POST   /api/v1/credit-plans/:id/installments/:iid/payment-link    Issue hosted link      [TENANT]
POST   /api/v1/public/credit-customer/request-code SMS customer verification        [PUBLIC, RATE LIMITED]
POST   /api/v1/public/credit-customer/verify-code  Verify code and issue customer token [PUBLIC, RATE LIMITED]
GET    /api/v1/credit-customer/plans              Customer schedules               [CUSTOMER TOKEN]
POST   /api/v1/public/credit-installments/:token/collect Hosted installment payment [PUBLIC]
PUT    /api/v1/credit-webhooks/:merchantId        Set merchant webhook             [TENANT]
DELETE /api/v1/credit-webhooks/:merchantId        Disable merchant webhook         [TENANT]
```

## Hire-purchase / credit sales (Track 4)

Apply the ordered `db/20261110` through `db/20261115` migrations after the existing Track 1–3
migrations. Run both `npm start` and at least one `npm run worker` process: the worker handles
payment status polling, overdue processing, SMS reminders, merchant webhook retries, and a
separate daily payout-wallet sweep for institution shares accrued from manually recorded cash
installments. `DEFAULTED` is a reporting status; customers can still repay those installments.
Plan creation requires `firstDueDate` in `YYYY-MM-DD` format.

Configure `SMS_GATEWAY_BASE_URL` and `SMS_DEFAULT_SENDER_ID` for the SMS provider. The default
gateway URL is a placeholder and cannot deliver verification codes or reminders. Merchant
webhook signing secrets are written to/read from a Vault KV v2 mount (`VAULT_KV_MOUNT`, default
`secret`) using references under `xorganam/webhooks/`. The Vault identity needs KV v2 read/write
access to that path in addition to any Transit permissions used for credential encryption.
`CHECKOUT_PUBLIC_URL` must point to the public checkout origin so generated payment links and
reminder links resolve to `/pay/:installmentToken`. Set `CREDIT_PRE_DUE_REMINDER_DAYS` to configure
the reminder lead time (default: 3 days).

Outbound merchant webhook events are `installment.paid`, `installment.overdue`, and
`plan.completed`. Requests contain `{ id, event, data, sentAt }` and an
`x-xorganam-signature` HMAC-SHA256 header computed over the exact JSON request body. Merchant
webhook URLs must use HTTPS and resolve only to public addresses.

## Vendor storefront and marketplace (Track 5)

Apply `db/20261120_add_storefront_marketplace_orders.sql`, then
`db/20261121_add_cancelled_credit_plan_status.sql`, then
`db/20261122_add_storefront_credit_order_linkage.sql`, after the Track 4 migrations. Run both
`npm start` and at least one `npm run worker` process. The worker expires order reservations,
checks uncertain Eganow payments before releasing stock, and flags payments confirmed after an
order was cancelled for platform-admin review. Set `ORDER_PAYMENT_EXPIRY_MINUTES` (5–60 minutes;
default 15) to control the reservation timeout.

Authenticated tenant admins and managers configure `GET/PUT /api/v1/storefront`, manage products,
branch stock and orders at `/api/v1/storefront/*`, and configure tenant credit checkout defaults at
`/api/v1/storefront/credit-defaults`. Public storefront and marketplace reads and checkout are
under `/api/v1/public/storefronts/:slug` and `/api/v1/public/marketplace/*`. Customers verify their
phone using the existing credit-customer SMS one-time-code flow, then access their orders and submit
verified-purchase reviews through `/api/v1/storefront-customer/*`. Platform admins manage
categories, approve/hide reviews, and resolve late-payment flags through `/api/v1/storefront-admin/*`.

Credit checkout uses the tenant defaults configured in the storefront operator page. Its first
installment is due the configured number of days after checkout, followed by the selected cadence;
this keeps the recurring defaults compatible with Track 4's required first due date without asking
each customer to set credit terms. A zero-down-payment plan places the order immediately. Cash
refunds are not initiated by the reconciliation queue: a platform admin must review the flagged
payment and decide how to fulfill or refund it using the operator's existing process.

Build the checkout app with `VITE_STOREFRONT_PUBLIC_URL` set to the dedicated public storefront
origin (for example `https://store.example.com`). Serve this build on an isolated origin with no
shared cookies or local storage with the operator portal. Configure DNS, TLS, and the web host to
serve that build; the repository cannot provision those hosting resources. The checkout HTML carries
a restrictive CSP as defense in depth, but the production edge/web server must also send an
appropriate `Content-Security-Policy` header, including `frame-ancestors 'none'`, because that
directive is not enforced from a meta policy. The API applies its own CSP and security headers.

Marketplace search uses PostgreSQL's English full-text index. The current storefront block format
supports hero, rich-text, and product-grid blocks with `categoryId` or explicit `productIds`; no
separate product-collection entity is defined by this schema. Product description HTML is sanitized
on write using the maintained `sanitize-html` allow-list.

## Institution onboarding

Institutions apply from the separate Institution Portal at `/register`; the public API stores a
pending application and returns an application ID plus a tracking code shown once. The applicant
selects the initial administrator password during registration. The code can be used at the same
page to check review status; it is stored hashed and is never returned by the API. Platform admins
review applications in Backoffice under **Institution applications**. Approval creates the
institution and its first `INSTITUTION_ADMIN` account in one database transaction and activates the
applicant-selected password. Rejection requires a reason and discards the pending password hash.

Before approval, platform staff must independently verify the institution, its settlement details,
and the applicant's authority. This flow does not verify email ownership or send email, so reviewers
must not rely only on the submitted contact information.

## Required authenticator MFA

Tenant/platform accounts and institution staff must enroll an authenticator app at first sign-in.
Subsequent sign-ins require a six-digit TOTP code. MFA secrets are encrypted through the configured
Vault Transit key. Apply `20261206_add_required_authenticator_mfa.sql` before deploying this version;
existing sessions without an MFA claim are rejected and users must sign in again. Email verification
and password recovery are not implemented because this repository has no email delivery provider.
Lost authenticator devices therefore require an audited operator recovery procedure before production.

## Deployment and release checks

`docker-compose.yml` is the local development stack, not a production TLS configuration. Production
must terminate TLS at a managed ingress, supply database/JWT/Vault secrets from an approved secret
manager, retain encrypted KYC storage with protected backups, and apply network egress rules for
Eganow, Vault, SMS, and other required providers. The application does not configure those external
controls or an antivirus scanner. Confirm the migration ledger in the target database and complete
provider transaction/recovery exercises before enabling real payments. Dependency audit results
are specific to the checked lockfile and must be repeated for each release.

## Webhook listener (`src/routes/webhooks.js`)

Parses Eganow's documented `TransactionId`, `TransactionStatus`, and `EganowReferenceNo` fields,
correlates the callback's transaction id to an existing internal reference, then queries Eganow's
authenticated status endpoint before changing ledger state. The callback status is not payment
proof, and unknown or ambiguous references are not used to create ledger rows. Confirm this field
mapping against the contracted Eganow account before enabling callbacks.

After authenticated reconciliation, `AUTO_SWEEP` merchants get a BullMQ
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
