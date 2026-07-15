# XORGANAM Architecture Redesign — Tenant → Merchant on Eganow

## What changed, and why

The previous backend (the .NET system in this same upload) modeled `Tenant` as the business
itself — one Egacore/Eganow credential set per tenant, one payout destination per tenant. That
matches a "one merchant = one tenant" SaaS shape.

That's not what you actually described. Eganow gives **one API credential set** to a business
(the Tenant — e.g. an aggregator, or a savings group operator), and that business can provision
**many independent wallet pairs** underneath it — one collection account + one payout account
per market woman. The market woman never sees Eganow, never sees an API key, and often can't
navigate a dashboard at all. She just wants her money to land in her own MoMo number.

So the correct shape is:

```
Tenant (owns Eganow API credentials, one webhook secret)
  └── Merchant (one per market woman / sub-account)
        ├── eganow_collection_account_id   ← Eganow account that receives customer payments
        ├── eganow_payout_account_id        ← Eganow account funds are swept into before disbursal
        ├── mobile_money_number             ← where money ultimately lands, outside Eganow
        └── payout_mode: AUTO_SWEEP | MANUAL
```

This is a strict re-scoping, not a rename: every transaction, every credential lookup, and every
webhook must now resolve **both** `tenant_id` *and* `merchant_id` — tenant alone is no longer
enough to know whose money is moving.

## The money flow, mapped to Eganow's wallet model

Eganow is a wallet, not a bank: money that lands in a **collection account** (credit side) has to
be internally swept to a **payout account** (debit side) before it can leave Eganow to an
external MoMo number. Two Eganow API calls, always, regardless of payout mode:

```
Customer pays via Eganow channel
        │
        ▼
Webhook: money is in Merchant's collection account   → status RECEIVED
        │
        ▼
Internal transfer: collection account → payout account → status SWEPT_INTERNAL
        │
        ▼
External payout: payout account → merchant's MoMo number → status PAID_OUT
```

## Where AUTO_SWEEP vs MANUAL forks the pipeline

- **`payout_mode = AUTO_SWEEP`** ("collect for me"): the webhook enqueues a background job.
  The worker does both Eganow calls (sweep, then payout) with no human involved, then SMS's the
  merchant that her money landed. This is the whole point for a market woman who can't and
  shouldn't have to operate a dashboard.
- **`payout_mode = MANUAL`** ("collection only"): the webhook does *not* enqueue anything. It
  notifies the tenant/merchant by SMS + email that a collection succeeded, and a human uses the
  manual transfer/payout actions (already built in the checkout app's merchant portal) to move
  the money when they choose to.
- **`merchant_settings.allow_manual_control`**: independent of `payout_mode`. A merchant on
  AUTO_SWEEP can *still* be granted manual controls "on request" — e.g. she wants to double-check
  a large payment before it auto-sweeps, or she wants the option to redirect a specific payout.
  This is why it's its own table rather than a second enum value: it's a permission overlay, not
  a mode.

## Tenant isolation, concretely

Every table below carries `tenant_id`; `transactions` and `merchant_settings` carry
`tenant_id` *and* `merchant_id` together, with a composite index on `(tenant_id, merchant_id)` —
so every hot-path query (list a merchant's transactions, check her settings) hits one index and
can never accidentally cross a tenant boundary even if application code forgets a `WHERE`
clause on `merchant_id` alone (a bare `merchant_id` lookup without `tenant_id` is exactly the
kind of bug that leaks data across tenants once merchant IDs are enumerable).

The webhook listener never trusts the URL alone for authorization — it re-derives the tenant from
the signature verification step (fetches that tenant's own webhook secret and checks the HMAC
against it), so a forged `:tenant_id` in the URL with someone else's payload/signature fails
before any database write happens.

## What this means for the rest of the system (not built in this pass)

You asked to keep the current UI design — done, nothing here touches CSS or component structure.
But functionally, the existing React frontends (`backoffice-dashboard`, `xorganam-checkout`) and
the .NET backend's controllers were written against the old `Tenant == Merchant` model. Once this
Node backend and schema are live, the frontend's API client and merchant portal pages will need
to add a merchant picker/context (a tenant's staff view needs to select *which* merchant they're
looking at) — that adaptation isn't part of this delivery, which is scoped to exactly the three
artifacts requested: the schema, the webhook listener, and the AUTO_SWEEP worker.
