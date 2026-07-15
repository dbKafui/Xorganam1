# XORGANAM Backoffice Dashboard

React (Vite) SPA for **platform admins only**. Talks to the Node.js backend
(`xorganam-node-backend`) - no mock data.

## Setup

```bash
npm install
cp .env.example .env   # point VITE_API_BASE_URL at your running backend
npm run dev             # http://localhost:5173
```

Log in with the account created by the backend's `npm run seed:admin` (defaults to
`admin@xorganam.local` / `ChangeMe!2026#`). Any account that isn't `PLATFORM_ADMIN` is rejected
at login here — Operators (tenants) and their staff use the checkout app's Operator portal
instead (`xorganam-checkout`, `/merchant/*` — see that app's README).

## What this app does

- **Overview** — system-wide totals and top tenants by volume.
- **Tenants & KYC** — review and approve/reject KYC documents, activate a tenant's Eganow API
  credentials once approved, configure their SMS/email provider, and see their merchants at a
  glance.
- **Transactions** — browse any tenant's transactions with a tenant + merchant picker, plus a
  "Check status now" button that forces an immediate reconciliation.

Manual collection/transfer/payout actions, merchant management, and tenant staff/user management
all live in the Operator portal now, not here — a platform admin's job is oversight and KYC, not
day-to-day transaction operation.

## Structure

```
src/
  api/          auth, tenants, merchants, transactions, reports
  context/      AuthContext - rejects any non-PLATFORM_ADMIN login
  components/   Layout (sidebar), ProtectedRoute, StatusChip
  pages/        Overview, Tenants (list/detail), Transactions (list/detail)
  styles/       global.css - unchanged ledger/ops design tokens
```
