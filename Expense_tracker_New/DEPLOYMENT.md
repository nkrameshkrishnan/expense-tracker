# Deployment Guide

This is a step-by-step runbook for the **first real deployment** of this
app: AWS backend (API Gateway + Lambda + Aurora Serverless v2 + Cognito),
Stripe billing, SES notifications, and the static frontend.

Nothing in this repo automates this — the CI workflow's `deploy` job is
deliberately a manual-only stub (`.github/workflows/ledger-new-ci.yml`,
`if: false`). Every step below is a command you run or a console screen you
click through yourself.

**Follow the phases in order.** Phase 3 (Stripe) needs the API URL that
only exists after Phase 2's first deploy, and Phase 2 needs to run a
**second time** once Phase 3 gives you a real webhook secret. That's not a
mistake in this document — it's the actual dependency order.

---

## Phase 0 — Prerequisites

Check each of these before starting. Skipping this phase is the single
most common reason `sam deploy` fails 20 minutes in.

- [ ] **AWS account** with billing enabled and a user/role with permission
      to create: VPC/subnets, RDS/Aurora, Lambda, API Gateway, Cognito,
      IAM roles, Secrets Manager secrets, SES identities, a WAFv2 WebACL,
      and a DynamoDB table.
- [ ] **AWS CLI v2** installed and configured.
- [ ] **AWS SAM CLI** installed.
- [ ] **Node.js 20.x** (matches `template.yaml`'s `Runtime: nodejs20.x`).
- [ ] **A Stripe account** (test mode is fine to start — you'll switch to
      live mode later by repeating the Stripe steps in Phase 3 with live
      keys/prices).
- [ ] **This repo cloned locally**, on the `main` branch, up to date.
- [ ] Decide your **Stage name** now — it becomes part of URLs and
      resource names (`ledger-<Stage>-...`). Use `dev` for a first test
      deploy, `prod` when you're ready for real customers. This guide uses
      `dev` in every example; substitute your real value throughout.

Verify the tools above are actually installed and working:

```bash
aws --version                # expect aws-cli/2.x
aws sts get-caller-identity  # must return your account, not an error
sam --version                # expect SAM CLI, version 1.100+
node --version                # expect v20.x
```

If `aws sts get-caller-identity` errors, run `aws configure` (or
`aws sso login` if your org uses SSO) before continuing. Then install
dependencies:

```bash
cd Expense_tracker_New/backend
npm install
```

---

## Phase 1 — Google OAuth client (for Cognito federation)

Cognito's Hosted UI federates sign-in to Google. You need a Google OAuth
client ID/secret before the first deploy, because `sam deploy --guided`
asks for them.

1. Go to <https://console.cloud.google.com/apis/credentials> (create/select
   a Google Cloud project first if you don't have one — any project works,
   this doesn't need to be a special "Ledger" project).
2. Check whether the **original** Ledger project already has a Google
   OAuth client you can reuse (same Google Cloud project, if you set that
   up before). Reusing is fine — a second app can share one OAuth client.
   Skip to step 3 to add this app's redirect URI to it if so.
3. If creating new: click **Create Credentials → OAuth client ID**.
   - Application type: **Web application**
   - Name: anything recognizable, e.g. `ledger-dev`
4. **Authorized redirect URIs** — add exactly this pattern (you don't have
   the real domain yet, so use a placeholder now and **come back to add
   the real one after Phase 5's Cognito domain exists**):
   ```
   https://ledger-dev-<YOUR_ACCOUNT_ID>.auth.<YOUR_REGION>.amazoncognito.com/oauth2/idpresponse
   ```
   Get `<YOUR_ACCOUNT_ID>` from `aws sts get-caller-identity` (the
   `Account` field) and `<YOUR_REGION>` from your AWS CLI config
   (`aws configure get region`). This URL is deterministic — you can
   compute it now even though the Cognito domain doesn't exist until you
   deploy.
5. Click **Create**. Copy the **Client ID** and **Client Secret** shown —
   you need both in Phase 2. (If you lose the secret, you can generate a
   new one from this same screen later — it's not shown again.)

---

## Phase 2 — First deploy (`sam build && sam deploy --guided`)

This creates every AWS resource except the database's actual tables (that's
Phase 4) and doesn't yet have real Stripe values (you'll redeploy in
Phase 6 with those).

1. From `Expense_tracker_New/backend`:

   ```bash
   sam build
   ```

   Expect `Build Succeeded` at the end. If it fails on
   `Cannot find package 'stripe'` or similar, confirm
   `backend/src/package.json` exists (it should — this repo ships it) and
   re-run.

2. ```bash
   sam deploy --guided
   ```

   Answer each prompt exactly as below. **Placeholder values are fine for
   the Stripe/SES parameters this first time** — you'll redeploy with real
   ones in Phase 6.

   | Prompt                               | What to enter                                                                   |
   | ------------------------------------ | ------------------------------------------------------------------------------- |
   | Stack Name                           | `ledger-dev` (or your Stage)                                                    |
   | AWS Region                           | your target region, e.g. `us-east-1`                                            |
   | Parameter `Stage`                    | `dev`                                                                           |
   | Parameter `GoogleClientId`           | the Client ID from Phase 1                                                      |
   | Parameter `GoogleClientSecret`       | the Client Secret from Phase 1                                                  |
   | Parameter `AllowedOrigin`            | `*` for now — tighten later (see Phase 9)                                       |
   | Parameter `FrontendUrl`              | see note below — **cannot be `*`**                                              |
   | Parameter `StripeSecretKey`          | `sk_test_placeholder` for now                                                   |
   | Parameter `StripeWebhookSecret`      | `whsec_placeholder` for now                                                     |
   | Parameter `StripePriceIdPro`         | `price_placeholder_pro` for now                                                 |
   | Parameter `StripePriceIdFamily`      | `price_placeholder_family` for now                                              |
   | Parameter `BedrockModelId`           | leave the default unless you need a different region/model                      |
   | Parameter `SesFromAddress`           | a real email you can verify later, e.g. `billing@yourdomain.com`                |
   | Confirm changes before deploy        | `Y`                                                                             |
   | Allow SAM CLI IAM role creation      | `Y`                                                                             |
   | Disable rollback                     | `N` (keep rollback enabled)                                                     |
   | Save arguments to configuration file | `Y` — this writes `samconfig.toml` so future `sam deploy` calls don't re-prompt |

   **`FrontendUrl`**: this must be the _exact_ URL your static site will be
   served from. If you're using this repo's existing GitHub Pages
   publishing (see Phase 8 — it already auto-publishes the whole repo on
   every push to `main`), this is:

   ```
   https://<your-github-username>.github.io/<repo-name>/Expense_tracker_New/frontend/
   ```

   Get the exact path by checking your repo's **Settings → Pages** page
   for the published base URL, then append
   `Expense_tracker_New/frontend/`. Trailing slash matters — match whatever
   your actual served URL looks like once you check it in Phase 8; you can
   redeploy this one parameter later if you got it wrong (Cognito rejects
   sign-in with a mismatched redirect otherwise).

**Bedrock model access**: unlike the other parameters above, `BedrockModelId`
needs the model itself _enabled_ for your account in this region before
`ExtractFunction` can call it — AWS Console → Bedrock → Model access,
request access to the Anthropic models if you haven't already. This is
a real thing to verify, not a formality: a request against a model your
account hasn't been granted access to fails at call time, not at deploy
time, so nothing here catches it early. Before first real use, also verify
the configured `BedrockModelId` is actually invokable on-demand in your
target region (AWS Console → Bedrock → the model's page, or a manual
`converse`/`invoke-model` call under the same IAM role) — some models only
work via a cross-region inference profile, in which case you'll need to
set `BedrockModelId` to that profile's id instead.

The Guardrail itself (`AiImportGuardrail`) is fully defined in `template.yaml` and needs no separate manual enablement, unlike model access above.

**GuardDuty Malware Protection**: this feature's `AiUploadsMalwareProtectionPlan`
resource requires GuardDuty itself to already be enabled for this AWS
account and region. If it isn't, enable it once via AWS Console → GuardDuty
→ Get Started (or `aws guardduty create-detector --enable`) before this
stack deploys - the `AWS::GuardDuty::MalwareProtectionPlan` resource will
fail to create otherwise. This is a one-time, account-level step, not
something `template.yaml` can express.

3. Deploy takes **10-15 minutes** the first time (Aurora Serverless v2
   cluster creation is the slow part). Watch for `Successfully created/
updated stack` at the end.

4. **Record the stack outputs** — you need all four for later phases:

   ```bash
   aws cloudformation describe-stacks --stack-name ledger-dev \
     --query "Stacks[0].Outputs" --output table
   ```

   Write down `ApiUrl`, `UserPoolId`, `UserPoolClientId`, `UserPoolDomain`.

5. **Go back to Phase 1's Google OAuth client** and add the _real_
   redirect URI now that you have the actual `UserPoolDomain` value (it
   should match what you predicted in Phase 1 step 4 — if your account ID
   or region assumption was wrong, fix the redirect URI now to match the
   real `UserPoolDomain` output).

---

## Phase 3 — Stripe setup

You need `ApiUrl` from Phase 2 before you can do step 2 below.

1. **Create the two Prices.** In the Stripe Dashboard (test mode to
   start): **Product catalog → + Add product**. Create two separate
   products (or one product with two prices — either works, but two
   separate products is simpler to read later), each with a **recurring
   monthly** price:
   - Pro
   - Family

   For each, click into the price and copy its **API ID** — it looks like
   `price_1AbCdEfGhIjKlMnOp`. You'll need both in Phase 6 — that's the
   only place they go; the frontend fetches them from the backend's
   `getPlans` action at runtime, so there's nothing to also enter in
   Phase 8.

   **Write these down now**, and make sure they come from the same mode
   (test vs. live) as the rest of Phase 3.

2. **Register the webhook endpoint.** **Developers → Webhooks → + Add
   endpoint**.
   - Endpoint URL: `<your ApiUrl from Phase 2>/webhooks/stripe`
     (e.g. `https://abc123.execute-api.us-east-1.amazonaws.com/dev/webhooks/stripe`)
   - Events to send: click **Select events** and check at least:
     - `checkout.session.completed`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
   - Click **Add endpoint**.
   - On the endpoint's detail page, click **Reveal** under **Signing
     secret** and copy the `whsec_...` value. You need this in Phase 6.

3. **Set the 30-day dunning retry.** **Settings → Billing → Subscriptions
   and emails → Manage failed payments**. Set the retry schedule to
   **30 days**, then **cancel the subscription**. This Dashboard setting
   _is_ the grace period the app's past-due email promises — there is no
   API/webhook that reports it back, so if you ever change it here, also
   update `RETRY_WINDOW_DAYS` in `backend/src/notify.js` to match.

4. **Disable plan-switching in the Customer Portal.** **Settings →
   Billing → Customer portal**. Under the features section:
   - Leave **payment method updates** ON
   - Leave **invoice history** ON
   - Leave **cancel subscription** ON
   - Turn **"Customers can switch plans"** OFF

5. **Get your Stripe secret key.** **Developers → API keys**. Copy the
   **Secret key** (`sk_test_...` for test mode, `sk_live_...` for live).
   You need this in Phase 6.

---

## Phase 4 — Apply the database schema

No direct network path is opened to the Aurora cluster by design (it's
accessed only via the RDS Data API). Apply the schema through the RDS
console's query editor.

1. AWS Console → **RDS → Databases** → find the cluster named
   `ledger-dev-...` (or your Stage) → **Query Editor** (or **Actions →
   Query with Query Editor** depending on console version).
2. Connect using **Secrets Manager**, selecting the secret this stack
   created (named like `ledger-dev-db-credentials` — matches
   `template.yaml`'s `DbSecret` resource). Database name: `ledger`.
3. Open `Expense_tracker_New/db/schema.sql` from this repo locally, copy
   its **entire contents**, paste into the query editor, and run it.
4. Confirm success — the editor should report each `CREATE TABLE`/
   `CREATE POLICY` statement succeeding with no errors. If you see
   `relation "tenants" already exists`, the schema was already applied
   (safe to ignore on a re-run of an idempotent statement, but check
   which statement actually failed before assuming that).

   **Already-deployed stack picking up AI import:** re-running the whole
   file against a database that already has the earlier tables fails on
   `create table` for each one that already exists. Instead, copy just the
   `ai_imports` table + its RLS policy block from the end of
   `db/schema.sql` (the section under the `-- ai_imports` comment) and run
   only that.

   **Already-deployed stack picking up multi-currency:** the same problem
   applies here - re-running the whole file fails on tables that already
   exist. Instead, run just this one statement against your existing
   database:

   ```sql
   alter table tenants add column currency text not null default 'CAD';
   ```

---

## Phase 5 — SES sender verification

1. AWS Console → **SES → Verified identities → Create identity**.
2. Choose **Email address**, enter the same address you used for
   `SesFromAddress` in Phase 2.
3. Check that inbox and click the verification link SES sends.
4. **Sandbox note**: a brand-new AWS account's SES is in **sandbox mode**,
   which only delivers to _other verified addresses_ — every notification
   to a real customer will silently fail (logged, not erroring anywhere
   visible) until you request production access. To leave the sandbox:
   **SES → Account dashboard → Request production access**, fill out the
   use-case form (describe: transactional billing emails, e.g. "payment
   past due" / "subscription downgraded" notifications for a SaaS app),
   and wait for AWS approval (usually within 24 hours, sometimes faster).
   You can continue deploying and testing everything else while this is
   pending — just verify your own test-customer email addresses too in the
   meantime so end-to-end billing tests actually receive mail.

---

## Phase 6 — Redeploy with real Stripe values

Now that Phase 3 gave you real values, replace the placeholders from
Phase 2.

```bash
cd Expense_tracker_New/backend
sam deploy \
  --parameter-overrides \
    StripeSecretKey=<sk_test_... from Phase 3 step 5> \
    StripeWebhookSecret=<whsec_... from Phase 3 step 2> \
    StripePriceIdPro=<price_... from Phase 3 step 1> \
    StripePriceIdFamily=<price_... from Phase 3 step 1>
```

Because you saved arguments to `samconfig.toml` in Phase 2, this reuses
your prior stack name/region/other-parameter values automatically — you
only need to override the four that changed. This redeploy is much faster
than the first (~2-3 minutes; no new infrastructure, just Lambda env vars).

---

## Phase 7 — Verify the two MUST-VERIFY Cognito assumptions

These cannot be checked any other way than a real deployed stack and a
real sign-in. If either is false, the invite flow silently misbehaves
(landing an invited user in their own new tenant instead of the
household that invited them) — **verify deliberately now**, don't wait
for a bug report.

1. **Create a test invite.** Sign up as a brand-new user first (Phase 10
   below walks through first sign-in) to get your first tenant, then use
   the Household panel to create an invite for a second email address you
   control.
2. **Redeem it as a genuinely new signup**: open the invite link in a
   private/incognito window, sign up with the second email via Google.
3. Check the resulting user's tenant: query `tenant_users` in the RDS
   query editor (`select * from tenant_users;`) and confirm the new
   `user_sub` row has `tenant_id` matching the **inviter's** tenant, not a
   freshly created one.
   - **If it matches the inviter's tenant**: both assumptions hold, you're
     done with this phase.
   - **If it doesn't**: `client_metadata` isn't reaching
     `PostConfirmation`, or `PostConfirmation` isn't firing for federated
     signups at all. Check CloudWatch Logs for the
     `PostConfirmationFunction` Lambda (Console → Lambda → find the
     function → Monitor → View CloudWatch logs) to see whether it even
     invoked, and whether `event.request.clientMetadata` was empty. This
     is a real, documented gap in the current design — see this repo's
     `README.md`, "Not done" item 4, for what a fix looks like (an
     explicit "join tenant" endpoint called after first sign-in instead of
     relying on `client_metadata`). Don't guess at a fix without
     confirming which of the two assumptions actually failed.

---

## Phase 8 — Frontend configuration

1. Open `Expense_tracker_New/frontend/assets/config.js` in this repo.
2. Fill in every blank export using your Phase 2 stack outputs:
   ```js
   export const API_ENDPOINT = "<ApiUrl output>";
   export const COGNITO_USER_POOL_ID = "<UserPoolId output>";
   export const COGNITO_CLIENT_ID = "<UserPoolClientId output>";
   export const COGNITO_DOMAIN =
     "<UserPoolDomain output, without the https:// prefix>";
   export const COGNITO_REGION = "<your AWS region, e.g. us-east-1>";
   ```
   No Stripe price IDs go here — the frontend fetches the plan list (id,
   seats, features, Stripe price id, live amount) from the backend's
   `getPlans` action at runtime, reading the same `StripePriceIdPro`/
   `StripePriceIdFamily` values you set as SAM deploy parameters in Phase 6.
   There is nothing to keep in sync by hand between frontend and backend.
3. `COGNITO_DOMAIN` is used bare (no `https://`) by
   `frontend/assets/app.js`'s `cognitoAuthorizeUrl()` — copy just the
   hostname portion of the `UserPoolDomain` output.

---

## Phase 9 — Serve the frontend

This repo's existing `.github/workflows/deploy.yml` already publishes the
**entire repository** to GitHub Pages on every push to `main` (it's set up
for the original Ledger app at the repo root, but `path: .` means
`Expense_tracker_New/frontend/` is served too, as a subdirectory).

1. Commit your filled-in `config.js` from Phase 8:
   ```bash
   git add Expense_tracker_New/frontend/assets/config.js
   git commit -m "chore: configure Expense_tracker_New frontend for dev deploy"
   ```
   **Before pushing**: `config.js` is downloaded by every visitor, same as
   the original app's config.js. Everything in it is safe to expose by
   design (see the file's own header comment) — `API_ENDPOINT` is just a
   URL, `COGNITO_CLIENT_ID` doesn't authorize anything by itself, access
   control happens server-side. Confirm you're comfortable with that before
   pushing to a public repo; if the repo is private this is moot.
2. ```bash
   git push origin main
   ```
3. Check **Settings → Pages** in your GitHub repo for the publish status
   and exact base URL (this is also how you should have confirmed the
   exact `FrontendUrl` value back in Phase 2 — if it doesn't match what
   you entered there, redeploy Phase 2 with the corrected `FrontendUrl`
   parameter, or Cognito will reject the sign-in redirect).
4. Visit `<published base URL>/Expense_tracker_New/frontend/` and confirm
   the page loads (you'll see the sign-in gate, since nothing is signed in
   yet).

---

## Phase 10 — End-to-end smoke test

Walk through the full flow once before considering this deployed for real.

1. **First sign-in**: visit the frontend URL, click sign in, complete
   Google OAuth via the Hosted UI. Confirm you land on the Dashboard, not
   an error page.
2. **Check tenant provisioning**: `select * from tenants;` in the RDS
   query editor — confirm a new row was created for you as owner.
3. **Add a transaction**: use the Add tab, confirm it appears on the
   Dashboard/Transactions.
4. **Invite flow**: covered already in Phase 7 — if you haven't done it
   yet, do it now.
5. **Tenant switching** (if you completed Phase 7's invite test): as the
   invited user, use `joinTenant` via the app's UI to join the inviter's
   household as a _second_ membership, then use the Household panel's
   switcher to move between your two tenants. Confirm the displayed data
   changes correctly each time.
6. **Billing — Checkout**: as a tenant owner, go to the Billing panel,
   click a paid plan, complete Stripe Checkout with a
   [test card](https://docs.stripe.com/testing) (`4242 4242 4242 4242`,
   any future expiry, any CVC) if you're still in Stripe test mode.
   Confirm you're redirected back and the plan updates within a few
   seconds (the webhook needs to fire and be processed).
7. **Billing — webhook delivery**: Stripe Dashboard → Developers →
   Webhooks → your endpoint → check the **Events** tab shows a `200`
   response for the `checkout.session.completed` event. A non-200 here
   means the webhook secret or endpoint URL is wrong — recheck Phase 6.
8. **Billing — Portal**: click "Manage billing", confirm it opens Stripe's
   Customer Portal and that plan-switching is genuinely absent (Phase 3
   step 4).
9. **SES**: trigger a past-due notification if you can (e.g. use a Stripe
   test card that simulates a decline on renewal), and check CloudWatch
   Logs for the `StripeWebhookFunction` for either a successful SES send
   or a swallowed failure log line (see Phase 5's sandbox note if it's the
   latter).

---

## Phase 11 — Before real customers (production hardening)

Don't skip these before pointing this at real money or real user data.

- [ ] **Tighten `AllowedOrigin`** from `*` to your actual frontend origin
      only. Redeploy: `sam deploy --parameter-overrides AllowedOrigin=https://your-real-origin`.
- [ ] **Switch Stripe to live mode**: repeat Phase 3 entirely in Stripe's
      live mode (separate Products/Prices/webhook/keys from test mode —
      nothing carries over), then repeat Phase 6 with the live values.
      Phase 8 needs nothing Stripe-related redone — the frontend has no
      Stripe price ids of its own to update.
- [ ] **Confirm SES production access** was granted (Phase 5).
- [ ] **Set `Stage=prod`** for a genuinely separate production stack
      rather than reusing your `dev` stack, if you want dev/prod isolation
      (recommended) — this means repeating Phases 1-9 as a second,
      parallel deployment rather than overwriting `dev`.
- [x] ~~API abuse protection~~ — already in `template.yaml` by default, no
      action needed: API Gateway stage throttling, a WAF rate-based rule
      per source IP, and a DynamoDB-backed per-IP rate limit inside
      `DataFunction` itself. Cognito's `AdvancedSecurityMode` is set to
      `AUDIT` (logs risk detections, doesn't block sign-in) — move it to
      `ENFORCED` once you've seen what AUDIT actually flags for real
      traffic, and check current Cognito pricing for the Essentials/Plus
      tier first, since enabling it moves the whole User Pool off Lite
      pricing.
- [ ] Review this repo's `README.md`'s "Not done" section for anything
      still outstanding at the time you read this — it's a living document
      and may have grown new items since this guide was written.
