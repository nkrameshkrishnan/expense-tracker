/* Single Lambda behind API Gateway HTTP API, handling GET and POST /data.
   Deliberately mirrors Code.gs's doGet/doPost action contract — same
   {action, ...} POST body shape, same GET query params (year, txYear) —
   so the frontend's ApiStore (assets/store.js) is a near copy of
   SheetsStore rather than a redesign. requireUser() runs first, always,
   exactly like Code.gs's requireUser(): no route below ever executes
   without a verified tenant context. */

import { requireUser, AuthError } from "./auth.js";
import { ValidationError } from "./validate.js";
import { runInTenantTransaction } from "./db.js";
import * as tx from "./routes/transactions.js";
import * as budget from "./routes/budget.js";
import * as balances from "./routes/balances.js";
import * as debts from "./routes/debts.js";
import * as tenants from "./routes/tenants.js";
import {
  createCheckoutSession,
  createPortalSession,
} from "./routes/billing.js";
import { stripe } from "./stripe.js";
import { FEATURES, planFromPriceId } from "./plans.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  // x-active-tenant IS present here (and in template.yaml's
  // CorsConfiguration): auth.js validates it against real tenant_users
  // membership before trusting it (see the comment in auth.js), so, unlike
  // the removed x-tenant-id header, there is a legitimate reason for a
  // browser to send it. Keep the two lists in sync if this ever changes.
  "Access-Control-Allow-Headers": "authorization,content-type,x-active-tenant",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

export function assertManagesInvites(membership) {
  if (!membership || !["owner", "admin"].includes(membership.role))
    throw new Error("Only owners or admins can manage invites.");
}

/** The priceId in a createCheckoutSession request is client-supplied - it
    comes straight from frontend/assets/config.js, which is hand-transcribed
    from the Stripe Dashboard independently of the backend's own
    StripePriceId* parameters. If those two ever drift (or a caller simply
    makes one up), Stripe would happily charge the card for a price this app
    cannot map to a plan, and the resulting checkout.session.completed
    webhook would then throw `Unrecognized Stripe price id` on every single
    redelivery, forever, leaving a paying customer on the free plan.
    planFromPriceId is the exact same mapping the webhook will later apply,
    so calling it HERE - before any Stripe API call - turns that silent,
    money-has-already-moved failure into a request that fails before a
    charge is possible. The return value is deliberately discarded; this is
    called purely for its validation throw. */
export function assertKnownPriceId(priceId) {
  planFromPriceId(priceId);
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS };

  let user;
  try {
    user = await requireUser(event);
  } catch (err) {
    if (err instanceof AuthError)
      return json(401, { ok: false, error: err.message });
    throw err;
  }

  try {
    if (method === "GET") return json(200, await handleGet(user, event));
    if (method === "POST") return json(200, await handlePost(user, event));
    return json(405, { ok: false, error: "Method not allowed." });
  } catch (err) {
    // ValidationError messages are authored in validate.js specifically to
    // be shown to a user ("date is required."), so they pass through with
    // a 400. Everything else is an internal failure and stays opaque — a
    // 500 with a fixed string, details to the log only. Without this split
    // a mistyped date would surface as "Request failed.", which tells the
    // user nothing and sends them looking for an outage.
    if (err instanceof ValidationError)
      return json(400, { ok: false, error: err.message });
    console.error(`[${user.tenantId}] ${err.message}`, err.stack);
    return json(500, { ok: false, error: "Request failed." }); // never leak internals to the client
  }
};

async function handleGet(user, event) {
  const qs = event.queryStringParameters || {};
  const year = qs.year ? Number(qs.year) : undefined;
  const txYear = qs.txYear !== undefined ? Number(qs.txYear) : undefined;

  return runInTenantTransaction(user.tenantId, user.sub, async (execute) => {
    const [tenantRow] = await execute.rows(
      `select plan, status, stripe_customer_id from tenants where id = cast(current_setting('app.tenant_id', true) as uuid)`,
    );
    const features = FEATURES[tenantRow.plan] || FEATURES.free;

    const [
      transactions,
      budgetRows,
      balanceRows,
      debtRows,
      years,
      membership,
      members,
    ] = await Promise.all([
      tx.listTransactions(execute, { txYear }, features),
      budget.getBudgetRows(execute, year || new Date().getFullYear()),
      balances.listBalances(execute, features),
      debts.listDebts(execute),
      tx.listTransactionYears(execute, features),
      tenants.getMembership(execute, user.sub),
      tenants.listMembers(execute),
    ]);
    const role = membership?.role || "member";
    const invites =
      role === "owner" || role === "admin"
        ? await tenants.listPendingInvites(execute)
        : [];
    return {
      ok: true,
      transactions,
      budget: budgetRowsToShape(budgetRows),
      budgetYear: year || new Date().getFullYear(),
      balances: balanceRows,
      debts: debtRows.map(fromDbDebt),
      transactionYearsAvailable: years,
      user: { email: user.email, role },
      members,
      invites,
      // hasStripeCustomer, not stripe_subscription_id: the webhook handler
      // (Task 4/7) CLEARS stripe_subscription_id on cancellation, so it can
      // never be true for a tenant who was just downgraded - it would be
      // useless as the "used to be subscribed" signal Task 9's downgrade
      // banner needs. stripe_customer_id is set once on first checkout and
      // never cleared by any handler, so it survives a downgrade and is the
      // correct durable signal.
      tenant: {
        plan: tenantRow.plan,
        status: tenantRow.status,
        hasStripeCustomer: !!tenantRow.stripe_customer_id,
      },
    };
  });
}

async function handlePost(user, event) {
  const payload = JSON.parse(event.body || "{}");
  const { action } = payload;

  return runInTenantTransaction(user.tenantId, user.sub, async (execute) => {
    switch (action) {
      case "create":
        return {
          ok: true,
          record: await tx.createTransaction(execute, payload.record),
        };
      case "update":
        return {
          ok: true,
          record: await tx.updateTransaction(
            execute,
            payload.id,
            payload.record,
          ),
        };
      case "delete":
        await tx.deleteTransaction(execute, payload.id);
        return { ok: true };
      case "clear":
        await tx.clearTransactions(execute);
        return { ok: true };
      case "bulk": {
        const inserted = await tx.bulkInsertTransactions(
          execute,
          payload.records,
        );
        return { ok: true, inserted };
      }
      case "setBudget":
        await budget.setBudgetRows(execute, payload.year, payload.budget);
        return { ok: true };
      case "setBalances":
        await balances.setBalances(execute, payload.date, payload.entries);
        return { ok: true };
      case "deleteBalanceDate":
        await balances.deleteBalanceDate(execute, payload.date);
        return { ok: true };
      case "addDebt":
        return { ok: true, id: await debts.addDebt(execute, payload.record) };
      case "updateDebt":
        await debts.updateDebt(execute, payload.id, payload.record);
        return { ok: true };
      case "deleteDebt":
        await debts.deleteDebt(execute, payload.id);
        return { ok: true };
      case "importDebts":
        return {
          ok: true,
          ...(await debts.importDebts(execute, payload.records)),
        };
      case "createInvite": {
        const membership = await tenants.getMembership(execute, user.sub);
        assertManagesInvites(membership);
        return {
          ok: true,
          invite: await tenants.createInvite(execute, payload),
        };
      }
      case "revokeInvite": {
        const membership = await tenants.getMembership(execute, user.sub);
        assertManagesInvites(membership);
        await tenants.revokeInvite(execute, payload.token);
        return { ok: true };
      }
      case "createCheckoutSession": {
        const membership = await tenants.getMembership(execute, user.sub);
        if (!membership || membership.role !== "owner")
          throw new Error("Only the owner can manage billing.");
        if (
          !/^https:\/\//.test(payload.successUrl) ||
          !/^https:\/\//.test(payload.cancelUrl)
        )
          throw new Error("successUrl/cancelUrl must be https:// URLs.");
        assertKnownPriceId(payload.priceId); // must precede createCheckoutSession - see above
        return {
          ok: true,
          ...(await createCheckoutSession(
            execute,
            stripe,
            user.tenantId,
            payload,
          )),
        };
      }
      case "createPortalSession": {
        const membership = await tenants.getMembership(execute, user.sub);
        if (!membership || membership.role !== "owner")
          throw new Error("Only the owner can manage billing.");
        if (!/^https:\/\//.test(payload.returnUrl))
          throw new Error("returnUrl must be an https:// URL.");
        return {
          ok: true,
          ...(await createPortalSession(
            execute,
            stripe,
            user.tenantId,
            payload,
          )),
        };
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  });
}

function budgetRowsToShape(rows) {
  const shape = {};
  for (const row of rows) {
    shape[row.category] = shape[row.category] || {};
    shape[row.category][row.month] = Number(row.amount);
  }
  return shape;
}

function fromDbDebt(row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    name: row.name,
    amount: Number(row.amount),
    date: row.date,
    notes: row.notes,
  };
}
