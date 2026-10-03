# XORGANAM Checkout + Operator portal

Two things live in this app, both wired to the Node.js backend (`xorganam-node-backend`) - no
mock data:

1. **The payment page** (`/`) - anonymous, scoped to a single **merchant** (a market woman),
   not a tenant. Link: `/?merchant=<merchantId>`.
2. **The Operator portal** (`/operator/*`) - where a **Tenant** (the business holding Eganow
   credentials, managing many merchants underneath it) registers, logs in, adds merchants,
   and runs transactions.

## Setup

```bash
npm install
cp .env.example .env
npm run dev   # http://localhost:5174
```

For a production build, set `VITE_API_BASE_URL`, `VITE_STOREFRONT_PUBLIC_URL`,
and `VITE_OPERATOR_PUBLIC_URL`. The API URL must be HTTPS; the storefront and
operator URLs must be distinct HTTPS origins (for example,
`https://store.example.com` and `https://app.example.com`). Production builds
fail if either value is missing, non-HTTPS, contains a path/query/fragment, or
uses the same origin. Deploy the same build on both hosts; the app redirects
storefront routes to the public host and sends all other routes from that host
to the operator host before React renders. Configure the API's `CORS_ORIGINS`
to allow both deployed origins.

For production containers, build with `Dockerfile.production`, passing all
three URLs as build arguments. It serves the SPA through Nginx, whose response
headers enforce CSP (including `frame-ancestors`) on storefront HTML and asset
responses. Build one image and serve it on both configured hosts.

## Payment page

`GET /public/merchants/:id` confirms the merchant can accept payments and shows her name.
`POST /public/collect` starts the real Eganow collection. **Note on status**: the backend's
`transaction_status` enum is `RECEIVED | SWEPT_INTERNAL | PAID_OUT | FAILED` - there's no
"awaiting customer approval" state to poll for, so this page shows the result of the collection
call itself (started vs. rejected) rather than faking a wait for the customer's phone. It cannot
confirm the customer actually approved the prompt - only that Eganow accepted the request.

## Operator portal

- **Overview** - tenant-wide totals (collected, paid out, net revenue) and merchants by volume.
- **Merchants** - list, add (`eganow_collection_account_id`/`eganow_payout_account_id` are
  entered manually here - Eganow provisions these when a new sub-account is set up, there's no
  auto-provisioning integration in this backend), and per-merchant detail: edit details, toggle
  **allow manual control** independently of her payout mode, see her own totals, and copy her
  payment link.
- **Transactions** - list filterable by merchant/status/type; **Start a collection** for
  phone-order/manual pushes; transaction detail with manual internal-transfer/payout actions and
  an on-demand **"Check status now"** reconcile button.
- **Team** - invite additional staff (Admin, Manager, Operator, Viewer roles), deactivate/
  reactivate, and change roles. Gated client-side to Admin/Manager (Operators and Viewers see a
  read-only list) - the real enforcement is server-side (`requireRole('TENANT_MANAGER')`), this
  is just so the UI doesn't offer buttons that would 403.
- **Account & KYC** - tenant-level onboarding status and document upload. Nothing is
  auto-approved - a platform admin reviews these in the Backoffice dashboard before Eganow gets
  activated.

Registration (`/operator/register`) auto-logs the operator in immediately (`Pending` status);
no merchant/payout fields are collected at registration time since those now live per-merchant,
added after login from **Merchants → Add a merchant**.

## Design

Same plain, trustworthy payment-card look as before (deep teal accent, IBM Plex Sans/Mono).
The Operator portal reuses this app's `.card`/`.portal-*` classes, consistent with the
Backoffice dashboard's ledger aesthetic where it makes sense (tables, mono figures, status pills).
