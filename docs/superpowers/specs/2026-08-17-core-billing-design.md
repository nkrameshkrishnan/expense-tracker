# Core Billing — Design Spec

## Context

Ledger's backend (`Expense_tracker_New/`) was rearchitected into a
multi-tenant SaaS product (API Gateway + Lambda + Aurora Serverless v2 +
Cognito, tenant isolation via Postgres RLS) in an earlier effort — see
`docs/superpowers/plans/2026-08-16-ledger-saas-hardening.md` and
`Expense_tracker_New/README.md`. That work deliberately deferred billing:
`tenants.plan`/`tenants.status` columns exist in `db/schema.sql` but nothing
reads or writes them meaningfully yet (every tenant defaults to
`plan = 'free'`, `status = 'active'`, and nothing enforces either).

This spec covers **only core billing** — Stripe integration, plan storage,
seat-cap and feature-tier enforcement, and the associated frontend/UI. A
related but separable feature — **department/cost-center tracking**
(transactions tagged to a department, department-level budgets/reports),
which the Business tier's positioning implies — is explicitly **out of
scope for this spec**. It was decomposed out during brainstorming because a
business can pay for Business tier the day core billing ships even if
department tracking lands later; it gets its own spec when picked up.

There is a real customer ready to pay once this ships, which raises the bar
on reliability above what a purely pre-validation build would need
(failure-mode handling on payments matters, not just the happy path).

## Goals

- Four tiers — Free, Pro, Family, Business — gating seat count and two
  specific features (transaction history depth, net worth tracking).
- A tenant owner can subscribe, change tier, and manage payment details
  entirely through Stripe's own hosted UI (Checkout + Customer Portal) — no
  custom payment form built in this codebase.
- Enforcement happens server-side, the same way every other constraint in
  this codebase does (RLS, input validation) — the frontend reflects state,
  it never is the gate.
- Existing data/members are never locked out by a downgrade — only new
  growth (inviting past a seat cap) is blocked. See "Downgrade policy"
  below.
- A failed payment gives the customer a real, bounded grace period with
  real notification, not a silent or immediate lockout.

## Non-goals

- Department/cost-center tracking (separate future spec).
- Annual billing, multiple currencies, or pricing outside CAD (all
  out of scope until there's a reason to build them).
- A custom-styled embedded payment form (Stripe Checkout is a full-page
  redirect — see "Approach" below for why).
- Building payment retry/dunning logic ourselves — Stripe's built-in
  dunning, configured in the Stripe Dashboard, is the mechanism (see
  "Downgrade policy").
- Tenant-switching UI (separate spec, decomposed out during the same
  brainstorming session as this one).

## Pricing

CAD, monthly only, for now:

| Tier     | Price  | Seats     | Net worth | Transaction history                 |
| -------- | ------ | --------- | --------- | ----------------------------------- |
| Free     | $0     | 1         | ✗         | Last 12 months (rolling from today) |
| Pro      | $7/mo  | 2         | ✓         | Full                                |
| Family   | $13/mo | 5         | ✓         | Full                                |
| Business | $24/mo | Unlimited | ✓         | Full                                |

Business tier's positioning ("team segregation — marketing spend, software
license spend, employee salary spend") implies department/cost-center
tracking, which is the separate future spec noted above. For this spec,
Business tier means exactly what the table says: unlimited seats, all
current features.

## Approach: Stripe Checkout + webhooks (redirect-based)

Two other approaches were considered and rejected during brainstorming:

- **Stripe Elements (embedded payment form):** more UI control, but needs
  Stripe.js loaded client-side, a hand-built subscription flow, and
  PCI-scope considerations for the embedded card form — for a benefit
  (custom styling) that doesn't matter much for this product.
- **Manual/invoice-based billing** (admin manually flips `tenants.plan`
  after an offline payment): fastest to build, but doesn't scale past one
  customer and defeats the point of self-serve billing.

Checkout + webhooks was chosen because it's the smallest real integration,
reuses a pattern already proven in this codebase (Cognito's Hosted-UI
redirect flow — full-page redirect out, full-page redirect back, no SDK to
load for the common case), and offloads the genuinely hard parts (card
storage/PCI compliance, failed-payment retry logic) to Stripe entirely.

## Data model

```sql
alter table tenants add column stripe_customer_id text;
alter table tenants add column stripe_subscription_id text;
```

`tenants.plan` (already `text not null default 'free'`) becomes one of
`free | pro | family | business`. `tenants.status` (already exists)
becomes one of `active | past_due`. A canceled subscription reverts
`plan = 'free'`, `status = 'active'` — see "Downgrade policy."

No new table. Seat caps and feature flags are **code constants**, not
DB-configurable rows — there are exactly four fixed tiers, and making them
data-driven would be premature generality for a set that changes rarely and
requires a Stripe Dashboard change (new Product/Price) whenever it does:

```js
const SEAT_CAPS = { free: 1, pro: 2, family: 5, business: Infinity };
const FEATURES = {
  free: { netWorth: false, historyMonths: 12 },
  pro: { netWorth: true, historyMonths: null },
  family: { netWorth: true, historyMonths: null },
  business: { netWorth: true, historyMonths: null },
};
```

Stripe setup (one-time, in the Stripe Dashboard, not code): three Products
with one recurring CAD Price each (Pro $7/mo, Family $13/mo, Business
$24/mo). Free is not a Stripe object — it's the default state (no active
subscription).

## Checkout & webhook flow

**New actions on the existing `{action, ...}` POST contract**
(`backend/src/routes/billing.js`, new), owner-only (reusing/generalizing the
`assertManagesInvites`-style role gate):

- `createCheckoutSession` — if `tenants.stripe_customer_id` is null, creates
  a Stripe Customer first (tagged with `tenant_id` in metadata — this is how
  the webhook maps an event back to a tenant without trusting anything
  client-supplied) and stores the id. Creates a Checkout Session for the
  requested price; `success_url`/`cancel_url` point back at the frontend's
  Billing panel. Returns the session URL for the frontend to redirect to.
- `createPortalSession` — same shape, for Stripe's Customer Portal (card
  updates, cancellation, invoice history — no custom UI needed for any of
  it).

**Webhook handler — a separate, unauthenticated Lambda** (`POST
/webhooks/stripe`), not behind `requireUser()`, since Stripe calls it
directly with no Cognito JWT. Authenticity is verified via Stripe's
signature scheme instead: the raw body + `Stripe-Signature` header, checked
against `STRIPE_WEBHOOK_SECRET` via `stripe.webhooks.constructEvent`. A
request that fails signature verification is rejected before touching the
database.

Handles four event types, each idempotent (safe to process the same event
twice — an `UPDATE ... WHERE stripe_customer_id = ...` naturally is):

- `checkout.session.completed` → look up the tenant by `customer` id, set
  `plan` from the purchased price id (via a price-id → plan-name map built
  from the `StripePriceId*` env vars), `status = 'active'`, store
  `stripe_subscription_id`.
- `customer.subscription.updated`, status transitions to `past_due` → set
  `tenants.status = 'past_due'`, trigger the past-due notification email
  (see "Notifications"). No access restriction yet.
- `customer.subscription.updated`, status transitions back to `active`
  (payment recovered) → set `tenants.status = 'active'`. No notification
  needed beyond what Stripe itself sends the customer for a successful
  charge.
- `customer.subscription.deleted` (Stripe gives up after its own dunning
  retries — see "Downgrade policy") → set `plan = 'free'`,
  `status = 'active'`, clear `stripe_subscription_id` (but leave
  `stripe_customer_id`, so the frontend can tell "used to be subscribed,
  now isn't" — see "Frontend"). Trigger the downgrade notification email.

## Downgrade policy

**Existing members/data are never locked out by a downgrade or a
cancellation** — only new growth (inviting a member past the new plan's
seat cap) is blocked going forward. This applies whether the downgrade came
from the owner choosing a cheaper plan via the Customer Portal, or from a
subscription being canceled after failed payments.

**The 30-day grace period on a failed payment is a Stripe Dashboard
setting, not custom application code.** Stripe Billing's "manage failed
payments" settings are configured to retry for 30 days, then cancel the
subscription. The existing `customer.subscription.deleted` webhook handler
above already reverts the tenant to Free when that fires — no separate
timer/scheduled job needs to be built.

Seat cap is checked in two places, because state can change between when an
invite is sent and when it's redeemed:

1. `createInvite` (soft check, immediate feedback to the inviting owner):
   if `current members + pending invites >= SEAT_CAPS[plan]`, reject with a
   clear error before the invite is even created.
2. Invite redemption in `postConfirmation.js` (hard check, authoritative):
   re-checked at the moment membership would actually grow, since the
   tenant's plan or membership count could have changed since the invite
   was sent.

## Feature enforcement

Plan is resolved once per request in `handler.js` (extending the existing
membership/role fetch from the Task 6 membership work) and passed to route
functions — no route re-queries `tenants` itself.

- **Net worth (Free tier):** `getBalances` in `routes/balances.js` returns
  an empty array for Free-tier tenants — server-side, not just a hidden
  frontend tab.
- **1-year rolling history (Free tier):** `listTransactions`/
  `listTransactionYears` in `routes/transactions.js` filter to the last 12
  months from today for Free-tier tenants — both the transaction rows and
  the year-selector data, so the frontend's year picker never offers a year
  outside the window.

## Notifications

Two events need customer notification, delivered via **real email (AWS
SES)** — an in-app-only notice is easy to miss if the customer doesn't log
back in during the grace window, and a card failure needs to reach them
regardless. New pieces: an SES verified sending address, two email
templates/senders (`sendPastDueEmail`, `sendDowngradedEmail`), triggered
directly from the webhook handler's `past_due` and `subscription.deleted`
branches.

**Plus in-app banners** (added during brainstorming, on top of email),
reusing the existing `notice()` / `#banner` mechanism in `app.js` (which
already supports an action button):

- **`past_due` banner** — global, persistent (does not auto-hide), shown
  app-wide once GET `/data`'s response includes `tenant.status ===
'past_due'` (extending that response the same way `role` was added for
  the membership work): _"Your payment failed — update your card to keep
  full access."_ with a "Manage billing →" button calling
  `createPortalSession`.
- **Downgrade banner** — shown specifically on the Billing panel (not
  global — avoids nagging forever), when `plan === 'free'` but
  `stripe_subscription_id` is still present. That combination is a natural,
  already-in-schema signal for "this tenant used to be subscribed, and no
  longer is" (no new column needed): _"Your subscription was canceled after
  a failed payment — you're on the Free plan."_ with a "Resubscribe"
  button.

## Frontend

A new **"Billing" panel** in the Data tab (same pattern as the Household
panel from the earlier membership work), visible to the owner:

- Current plan, status, next renewal date if applicable.
- Four plan cards with an Upgrade/Downgrade button on each → calls
  `createCheckoutSession`, redirects to Stripe.
- "Manage billing" button (once a paid plan is active) → calls
  `createPortalSession`, redirects to Stripe's Customer Portal.
- The downgrade banner described above.

Feature-gate UI, matching the server-side gates:

- Net Worth nav tab hidden (or shown with an "Upgrade to unlock" prompt)
  for Free-tier tenants — cosmetic only, since `getBalances` already
  returns empty server-side regardless.
- Transactions/year-picker only offers the last 12 months on Free tier,
  matching what the server actually returns.

The global `past_due` banner described above is not scoped to the Billing
panel — it's rendered app-wide once boot/`refresh()` picks up
`tenant.status`.

## Testing

Matches the existing project pattern (mocked AWS SDK for unit tests, real
Postgres via `pg-harness.js` for integration):

- Webhook handler tests construct a fake signed payload using Stripe's own
  test helper (`stripe.webhooks.generateTestHeaderString`) and assert the
  resulting `tenants` row — mirrors how `db.js`'s tests mock
  `RDSDataClient.prototype.send`.
- Seat-cap and feature-gate tests run against real Postgres via the
  existing harness, same as every other route test (`routes-write.test.js`,
  `provisioning.test.js`).
- SES calls are mocked the same way (`SESClient.prototype.send`), asserting
  the right template/recipient was invoked, not that an email was actually
  delivered.

## Configuration

New `template.yaml` parameters, following the existing pattern
(`GoogleClientId`/`GoogleClientSecret`): `StripeSecretKey`,
`StripeWebhookSecret`, `StripePriceIdPro`, `StripePriceIdFamily`,
`StripePriceIdBusiness`, `SesFromAddress`.

## Open questions for the implementation plan to resolve

None outstanding — every decision point raised during brainstorming
(pricing, tier restrictions, downgrade policy, notification channel,
Stripe vs. Elements vs. manual) was resolved during this design
conversation. The department/cost-center feature implied by Business
tier's positioning is deliberately deferred to its own future spec, not an
open question within this one.
