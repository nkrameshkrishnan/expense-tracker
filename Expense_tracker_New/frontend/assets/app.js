import {
  CAT_NAMES,
  PAYMENTS,
  ACCOUNTS,
  currentYear,
  PERSON_KEY,
  getIdToken,
  setIdToken,
  CURRENCIES,
} from "./store.js";
import {
  $,
  view,
  esc,
  YEAR_KEY,
  state,
  withBusy,
  notice,
  refresh,
  switchActiveTenant,
  periodSelect,
} from "./core.js";
import { viewTransition } from "./motion.js";
import { aggregate, money, exportWorkbook, importFile } from "./xlsxio.js";
import { removeCustom, listFor } from "./categories.js";
import * as charts from "./charts.js";
import {
  planCopy,
  formatPlanAmount,
  formatPlanPeriod,
  planSeatsLabel,
  planFeatureList,
  ensurePlans,
  markPlanGateSeen,
} from "./tenant.js";
import {
  showGate,
  signOut,
  consumeAuthRedirect,
  revealApp,
  isRemoteStore,
  boot,
} from "./auth.js";
import { renderDashboard } from "./pages/dashboard.js";
import { renderCashFlow } from "./pages/cashflow.js";
import { renderSpending } from "./pages/spending.js";
import { renderAdd } from "./pages/add.js";
import { renderTransactions } from "./pages/transactions.js";
import { renderBudget } from "./pages/budget.js";
import { renderNetWorth } from "./pages/networth.js";

/* ------------------------------------------------------------------ plans
   Pure display copy, keyed by plan id - label and blurb are the only
   per-plan facts that can't come from the backend, since they're
   marketing text, not business logic. Everything that determines what a
   plan actually DOES or COSTS (seat cap, features, price) comes from
   state.plans (getPlans(), see ensurePlans below) - this app keeps no
   independent list of which tiers exist, so a tier added or removed on
   the server just works here without a matching edit. Personal-finance
   app, not a team tool - Family is deliberately the top tier; there is no
   unlimited-seat "Business" plan. A plan id with no entry here (a new
   tier added server-side before its copy is written) still renders, with
   a generic fallback label/blurb - see planCopy() below. The signup gate
   (renderPlanGate) and the Billing tab (renderBilling) deliberately do
   not share markup/CSS: the gate is a one-time, full-viewport decision
   (bigger cards, its own visual weight), while Billing is a page you
   return to, sitting alongside this app's other panels - collapsing them
   into one component would make whichever one changes next drag the
   other along with it. They DO share the small data helpers below
   (planCopy/planFeatureList/planSeatsLabel/formatPlanAmount/
   formatPlanPeriod) - those are pure derivation, not markup, so sharing
   them carries none of that risk. */

/* ====================================================================== DATA */
function renderData() {
  // Derived here, at render time, rather than once in refresh() - state.plans
  // only populates lazily via ensurePlans() (see below), which resolves
  // AFTER the first refresh() of a fresh session has already run. Caching
  // these onto state.tenant inside refresh() would freeze aiImportAllowed at
  // its plans-not-loaded-yet value (false) forever, since nothing calls
  // refresh() again just because ensurePlans() resolved - only this
  // function's own ensurePlans() re-render would run, and it needs the
  // recompute to actually see the update. Recomputing on every render is
  // cheap (a short array lookup) and keeps state.tenant.aiImportAllowed
  // truthful for the template below, same as renderBilling/renderPlanGate
  // deriving straight from state.plans rather than trusting a cached copy.
  if (state.tenant) {
    state.tenant.aiImportAllowed = !!state.plans?.find(
      (p) => p.id === state.tenant.plan,
    )?.features?.aiImport;
    // Must match AI_IMPORT_MONTHLY_CAP in backend/src/plans.js - not sent
    // over the wire today, so this is a second, manually-synced copy.
    // Low-risk (display only, the real enforcement is server-side), but
    // worth revisiting if backend/src/plans.js's value ever changes.
    state.tenant.aiImportsRemaining =
      state.tenant.aiImportsUsedThisMonth != null
        ? Math.max(0, 20 - state.tenant.aiImportsUsedThisMonth)
        : null;
  }
  const live = state.store.kind === "api";
  const members = state.members || [];
  const invites = state.invites || [];
  const tenants = state.tenants || [];
  const myRole = state.role || "member";
  const canManageInvites = myRole === "owner" || myRole === "admin";

  view.innerHTML = `
  <div class="head"><div><h1>Data</h1><p class="sub">Where your data lives, and how to get it in and out.</p></div></div>

  <div class="eyebrow">Export</div>
  <div class="panel stack">
    <div class="actions">
      <button class="btn" id="xlsx">Download .xlsx</button>
      <button class="btn ghost" id="json">Download .json backup</button>
      <span class="muted">${state.rows.length} transactions</span>
    </div>
    <p class="note">Three sheets \u2014 Transactions, Budget, and a Pivot cross-tab. No charts: the browser cannot
    write chart objects into an .xlsx. The charts you see on the Dashboard are rendered live from the same data
    instead.</p>
  </div>

  <div class="eyebrow">Import</div>
  <div class="panel stack">
    <input type="file" id="file" accept=".xlsx,.xls,.csv">
    <div class="actions"><label><input type="checkbox" id="replace"> Replace everything first</label></div>
    <div id="imp" class="note"></div>
    <p class="note">Needs a flat table with at least <code>Date</code> and <code>Amount</code> columns. Large
    files are uploaded automatically in the background, a little at a time.</p>
  </div>

  <div class="eyebrow">AI Import</div>
  <div class="panel stack">
    ${
      !state.plans
        ? `<p class="note" style="margin:0">Checking your plan…</p>`
        : !state.tenant?.aiImportAllowed
          ? `<p class="note" style="margin:0">Upload a bank or credit-card statement (CSV or PDF) and let AI read it for you — <b>available on the Pro and Family plans.</b> <a href="#billing" data-goto-billing>Upgrade from Billing</a>.</p>`
          : (state.tenant?.aiImportsRemaining ?? Infinity) <= 0
            ? `<p class="note" style="margin:0">You've used all your AI imports for this month. It resets at the start of next month.</p>`
            : `
    <input type="file" id="ai-file" accept=".csv,.pdf">
    <p class="note" style="margin:0">Upload a real bank or credit-card statement — AI reads it and maps it into your categories. You review everything before anything is saved. ${esc(String(state.tenant?.aiImportsRemaining ?? ""))} import${state.tenant?.aiImportsRemaining === 1 ? "" : "s"} left this month.</p>
    <div id="ai-review"></div>`
    }
  </div>

  <div class="eyebrow">People</div>
  <div class="panel stack">
    <p class="note" style="margin:0">${(() => {
      const un = state.rows.filter((r) => !r.person).length;
      return un
        ? `<b>${un} entries have no person set</b> \u2014 everything imported before this feature existed. Assign them in one go:`
        : "Every entry has a person assigned.";
    })()}</p>
    ${
      state.rows.filter((r) => !r.person).length
        ? `
    <div class="actions">
      ${listFor("person")
        .map(
          (pp) =>
            `<button class="btn ghost" data-assign="${esc(pp)}">Assign all to ${esc(pp)}</button>`,
        )
        .join("")}
    </div>
    <p class="note">This rewrites every unassigned row. You can still change individual entries afterwards from Transactions \u2192 edit.</p>`
        : ""
    }
  </div>

  <div class="eyebrow">Household</div>
  <div class="panel stack">
    <p class="note" style="margin:0">Your role: <b>${esc(myRole)}</b>. ${members.length} member${members.length === 1 ? "" : "s"}.</p>
    <ul class="stack" style="margin:0;padding-left:1.2em">
      ${members.map((m) => `<li>${esc(m.email)} — ${esc(m.role)}</li>`).join("")}
    </ul>
    ${
      // Visible to any member belonging to more than one household, regardless
      // of role - unlike the invite controls just below, which stay owner/
      // admin-only. Most accounts belong to exactly one tenant and never see
      // this at all.
      tenants.length > 1
        ? `
    <div class="stack" style="max-width:420px">
      <label class="f"><span>Active household</span>
        <select id="tenant-switcher">
          ${tenants
            .map(
              // No active tenant set means no X-Active-Tenant header is
              // sent, so the server acts as the JWT's own default tenant -
              // and nothing is marked selected here, leaving the browser to
              // show the FIRST option. Those two agree because
              // listMyTenants orders by created_at ascending, the default
              // tenant is the one created at signup, and every membership
              // insert path can only append a later row (no leave-tenant or
              // remove-member action exists anywhere in this codebase). So
              // tenants[0] is provably the JWT's default today - but that
              // is an emergent property of the current insert paths, not an
              // enforced guarantee, and would need re-verifying if leaving
              // or removing a member is ever added.
              (t) =>
                `<option value="${esc(t.tenant_id)}"${t.tenant_id === state.store.getActiveTenant?.() ? " selected" : ""}>${esc(t.name)} (${esc(t.role)})</option>`,
            )
            .join("")}
        </select>
      </label>
    </div>`
        : ""
    }
    ${
      canManageInvites
        ? `
    <div class="stack" style="max-width:420px">
      <label class="f"><span>Invite by email</span>
        <input id="invite-email" type="email" placeholder="name@example.com"></label>
      <div class="actions"><button class="btn" id="send-invite">Send invite</button></div>
    </div>
    ${
      invites.length
        ? `<p class="note" style="margin:0">Pending invites:</p>
    <ul class="stack" style="margin:0;padding-left:1.2em">
      ${invites
        .map(
          (inv) => `<li>${esc(inv.email)}
            <button class="btn ghost" data-copy-invite="${esc(inv.token)}">Copy link</button>
            <button class="btn ghost" data-revoke-invite="${esc(inv.token)}">Revoke</button></li>`,
        )
        .join("")}
    </ul>`
        : ""
    }`
        : ""
    }
  </div>

  <div class="eyebrow">Danger zone</div>
  <div class="panel"><div class="actions">
    <button class="btn danger" id="wipe">Delete every row${live ? " from the server" : ""}</button>
    <span class="muted">Export first \u2014 this cannot be undone.</span>
  </div></div>`;

  $("#tenant-switcher")?.addEventListener("change", (e) => {
    switchActiveTenant(e.target.value);
  });

  $("#send-invite")?.addEventListener("click", async () => {
    const email = $("#invite-email").value.trim();
    if (!email) return notice("Enter an email address.", "bad");
    const done = await withBusy("Sending invite", async () => {
      await state.store.createInvite(email, "member");
      await refresh();
    });
    if (done) {
      notice(`Invited ${email}.`, "ok");
      renderData();
    }
  });

  view.querySelectorAll("[data-copy-invite]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const token = btn.dataset.copyInvite;
      const link = `${location.origin}${location.pathname}#invite=${token}`;
      await navigator.clipboard.writeText(link);
      notice("Invite link copied.", "ok");
    });
  });

  view.querySelectorAll("[data-revoke-invite]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const token = btn.dataset.revokeInvite;
      const done = await withBusy("Revoking invite", async () => {
        await state.store.revokeInvite(token);
        await refresh();
      });
      if (done) {
        notice("Invite revoked.", "ok");
        renderData();
      }
    });
  });

  view.querySelectorAll("[data-assign]").forEach(
    (b) =>
      (b.onclick = async () => {
        const who = b.dataset.assign;
        const todo = state.rows.filter((r) => !r.person);
        if (
          !confirm(
            `Assign ${todo.length} unassigned entries to ${who}?\n\nThis updates ${todo.length} rows one at a time and may take a moment.`,
          )
        )
          return;
        const done = await withBusy(
          `Assigning ${todo.length} entries to ${who}`,
          async () => {
            for (const r of todo)
              await state.store.update(r.id, { ...r, person: who });
            await refresh();
          },
        );
        if (done) {
          notice(`${todo.length} entries assigned to ${who}.`, "ok");
          renderData();
        }
      }),
  );

  $("#xlsx").onclick = async () => {
    const done = await withBusy("Preparing your workbook", async () => {
      await exportWorkbook(state.rows, state.budget);
    });
    if (done) notice("Workbook downloaded.", "ok");
  };
  $("#json").onclick = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          { year: state.year, transactions: state.rows, budget: state.budget },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ledger-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $("#file").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const out = $("#imp");
    out.textContent = "Reading\u2026";
    try {
      const { rows, skipped, reasons, sheet } = await importFile(file);
      if (!rows.length) {
        out.innerHTML = `<b class="over">No usable rows found on "${esc(sheet)}".</b>`;
        return;
      }
      if (!isRemoteStore(state.store)) {
        out.innerHTML =
          '<b class="over">Not connected to your Ledger account — reconnect before importing.</b>';
        return;
      }
      const replacing = $("#replace").checked;
      if (
        !confirm(
          `Import ${rows.length} rows from "${sheet}" into your Ledger account?${skipped ? `\n\n${skipped} rows will be skipped (no valid date or amount).` : ""}${
            replacing
              ? `\n\n"Replace everything first" is checked: every existing transaction will be deleted before the import.${hiddenHistoryWarning()}`
              : ""
          }`,
        )
      ) {
        out.textContent = "Cancelled.";
        return;
      }
      const done = await withBusy(`Writing ${rows.length} rows`, async () => {
        if (replacing) await state.store.clear(); // the same flag the confirmation above described
        await state.store.bulkAdd(rows, (n, total) => {
          notice(`Saving\u2026 ${n} of ${total} rows`);
        });
        await refresh();
      });
      if (done) {
        out.innerHTML = `<b class="under">Imported ${rows.length} rows.</b>${skipped ? ` ${skipped} skipped${reasons.length ? " (e.g. " + esc(reasons.join(", ")) + ")" : ""}.` : ""}`;
        notice(`Imported ${rows.length} transactions.`, "ok");
      }
    } catch (err) {
      out.innerHTML = `<b class="over">${esc(err.message)}</b>`;
    }
  };

  view.querySelector("[data-goto-billing]")?.addEventListener("click", (e) => {
    e.preventDefault();
    go("billing");
  });

  $("#ai-file")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reviewEl = $("#ai-review");
    const fileType = file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "csv";
    // Matches backend/src/extract.js's MAX_FILE_BYTES - reject an oversized
    // file instantly instead of paying for a full upload round trip (the
    // file goes straight to S3, not through a Lambda request body) only to
    // have the server reject it once it's already there.
    const MAX_FILE_BYTES = 4 * 1024 * 1024;
    if (file.size > MAX_FILE_BYTES) {
      reviewEl.innerHTML = `<b class="over">File is too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB).</b>`;
      return;
    }
    reviewEl.innerHTML = `<p class="note">Uploading your statement…</p>`;

    try {
      const { transactions, skipped } = await state.store.extractTransactions(
        file.name,
        fileType,
        file,
        CAT_NAMES,
      );
      renderAiReviewTable(reviewEl, transactions, skipped);
    } catch (err) {
      reviewEl.innerHTML = `<b class="over">${esc(err.message)}</b>`;
    }
  });

  $("#wipe").onclick = async () => {
    if (!isRemoteStore(state.store))
      return notice(
        "Not connected to your Ledger account — reconnect before deleting anything.",
        "bad",
      );
    if (
      !confirm(
        `Delete all ${state.rows.length} transactions from your Ledger account?\n\nThis cannot be undone.${hiddenHistoryWarning()}`,
      )
    )
      return;
    if (!confirm("Really sure? Export a backup first if you have not.")) return;
    const done = await withBusy("Deleting your transactions", async () => {
      await state.store.clear();
      await refresh();
    });
    renderData();
    if (done) notice("All rows deleted.", "ok");
  };

  // First render shows "Checking your plan…" above; once the fetch
  // resolves, silently re-render with the real aiImportAllowed value - but
  // only if Data is still the tab on screen (the user may have already
  // navigated away by the time it resolves).
  ensurePlans(() => {
    if (state.tab === "data") renderData();
  });
}

/** Renders the read-only, checkbox-driven review table for AI-extracted
    transactions - see this feature's spec, Architecture §7. No inline
    editing (Non-goals): anything wrong here gets fixed after import via
    the normal Transactions edit flow, same as any other imported row. */
function renderAiReviewTable(reviewEl, transactions, skipped) {
  if (transactions.length === 0) {
    reviewEl.innerHTML = `<p class="note">No transactions found in this file.${skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} couldn't be read reliably.)` : ""}</p>`;
    return;
  }

  reviewEl.innerHTML = `
    ${skipped ? `<p class="note" style="margin:0 0 8px">${skipped} row${skipped === 1 ? "" : "s"} couldn't be read reliably and ${skipped === 1 ? "isn't" : "aren't"} shown below.</p>` : ""}
    <table class="ai-review-table">
      <thead><tr><th></th><th>Date</th><th>Type</th><th>Category</th><th>Description</th><th>Amount</th></tr></thead>
      <tbody>
        ${transactions
          .map(
            (t, i) => `
        <tr class="${t.confidence === "low" ? "ai-low-confidence" : ""}">
          <td><input type="checkbox" class="ai-row-check" data-idx="${i}" checked></td>
          <td>${esc(t.date)}</td>
          <td>${esc(t.type)}</td>
          <td>${esc(t.category)}${t.confidence === "low" ? ' <span class="ai-flag" title="Low confidence — double-check this row">⚠</span>' : ""}</td>
          <td>${esc(t.description)}</td>
          <td class="num">${esc(money(t.amount))}</td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table>
    <div class="actions" style="margin-top:10px">
      <button class="btn" id="ai-import-selected">Import selected</button>
    </div>`;

  reviewEl.querySelector("#ai-import-selected").onclick = async () => {
    const checked = [...reviewEl.querySelectorAll(".ai-row-check:checked")].map(
      (cb) => transactions[Number(cb.dataset.idx)],
    );
    if (!checked.length) return notice("Select at least one row.", "bad");
    const done = await withBusy(
      `Importing ${checked.length} transactions`,
      async () => {
        await state.store.bulkAdd(checked);
        await refresh();
      },
    );
    if (done) {
      notice(`Imported ${checked.length} transactions.`, "ok");
      reviewEl.innerHTML = "";
      renderData();
    }
  };
}

/** The household's plan, status and payment actions - its own top-level page
    rather than a section of Data, since it is where an owner actually goes
    to make a billing decision, not incidental to "where your data lives".
    Deliberately does not share markup with renderPlanGate: that overlay is
    a one-time, full-viewport decision shown once at signup, this is a page
    you come back to and sits visually among this app's other panels. */
function renderBilling() {
  const tenant = state.tenant || { plan: "free", status: "active" };
  const myRole = state.role || "member";
  // Billing is owner-only (the backend enforces the same rule on both
  // billing actions) - a narrower rule than canManageInvites, since an
  // admin can invite people but cannot spend the household's money.
  const canManageBilling = myRole === "owner";
  // Checkout can only CREATE a subscription. Once one exists, changing or
  // cancelling it belongs to the Customer Portal - showing "Choose <other
  // plan>" here would start a second, separately-billed subscription
  // (routes/billing.js rejects it server-side too).
  const hasSubscription = tenant.plan !== "free";
  const showDowngradeBanner =
    tenant.plan === "free" && !!tenant.hasStripeCustomer;
  const plans = state.plans || [];
  const planMeta = plans.find((p) => p.id === tenant.plan);
  const currentLabel = planCopy(tenant.plan).label;
  const statusLabel =
    tenant.status === "past_due"
      ? "Payment failed"
      : showDowngradeBanner
        ? "Back on Free"
        : "Active";
  const statusClass =
    tenant.status === "past_due" ? "bad" : showDowngradeBanner ? "warn" : "ok";

  view.innerHTML = `
  <div class="head"><div><h1>Billing</h1><p class="sub">This household's plan, seats and payment details.</p></div></div>

  <div class="eyebrow">Current plan</div>
  <div class="panel billing-current">
    <div class="billing-current-top">
      <div>
        <div class="billing-current-plan">${esc(currentLabel)}</div>
        <div class="muted">${
          planMeta
            ? `${esc(planSeatsLabel(planMeta.seatCap))} &middot; <span class="num">${esc(formatPlanAmount(planMeta))}</span>${esc(formatPlanPeriod(planMeta))}`
            : esc(state.plans ? "Plan details unavailable" : "Loading…")
        }</div>
      </div>
      <span class="status-pill ${statusClass}">${esc(statusLabel)}</span>
    </div>
    ${
      tenant.status === "past_due"
        ? `<p class="note" style="margin-top:12px">Your last payment failed. Update your card in the billing portal before the grace period ends to keep full access.</p>`
        : ""
    }
    ${
      showDowngradeBanner
        ? `<p class="note" style="margin-top:12px">Your subscription was canceled after a failed payment — you're on the Free plan.${canManageBilling ? ' <button class="btn ghost" id="resubscribe">Resubscribe</button>' : ""}</p>`
        : ""
    }
    ${
      canManageBilling
        ? ""
        : '<p class="note" style="margin-top:12px">Only the household owner can change the plan or manage payment details.</p>'
    }
  </div>

  <div class="eyebrow">Plans</div>
  ${
    !state.plans
      ? `<p class="note">Loading plans…</p>`
      : plans.length === 0
        ? `<p class="note">Plans are temporarily unavailable. Try reconnecting from the banner above, then reload.</p>`
        : `<div class="billing-plan-grid">
    ${plans
      .map((p) => {
        const isCurrent = p.id === tenant.plan;
        const copy = planCopy(p.id);
        return `
      <div class="billing-plan-card${isCurrent ? " current" : ""}${copy.recommended && !isCurrent ? " recommended" : ""}">
        ${copy.recommended && !isCurrent ? '<div class="billing-plan-tag">Most households</div>' : ""}
        <div class="billing-plan-name">${esc(copy.label)}</div>
        <div class="billing-plan-price"><span class="num">${esc(formatPlanAmount(p))}</span><span class="muted">${esc(formatPlanPeriod(p))}</span></div>
        <div class="muted" style="margin:2px 0 10px">${esc(planSeatsLabel(p.seatCap))}</div>
        <p class="note" style="margin:0 0 10px">${esc(copy.blurb)}</p>
        <ul class="billing-plan-features">
          ${planFeatureList(p.features)
            .map((f) => `<li>${esc(f)}</li>`)
            .join("")}
        </ul>
        ${
          isCurrent
            ? '<span class="billing-plan-current-tag">Current plan</span>'
            : !canManageBilling || hasSubscription || !p.priceId
              ? ""
              : `<button class="btn ghost" data-upgrade-plan="${esc(p.priceId)}">Choose ${esc(copy.label)}</button>`
        }
      </div>`;
      })
      .join("")}
  </div>`
  }

  ${
    hasSubscription && canManageBilling
      ? `<div class="eyebrow">Manage</div>
  <div class="panel stack">
    <p class="note" style="margin:0">Switching plans, updating your card and cancelling all happen in the Stripe billing portal — starting a second checkout here would bill you twice.</p>
    <div class="actions"><button class="btn ghost" id="manage-billing">Manage billing</button></div>
  </div>`
      : ""
  }`;

  view.querySelectorAll("[data-upgrade-plan]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const base = location.origin + location.pathname;
      const done = await withBusy("Starting checkout", async () => {
        const { url } = await state.store.createCheckoutSession(
          btn.dataset.upgradePlan,
          `${base}#billing`,
          `${base}#billing`,
        );
        location.href = url;
      });
      if (!done) notice("Could not start checkout.", "bad");
    });
  });

  $("#manage-billing")?.addEventListener("click", async () => {
    const returnUrl = location.origin + location.pathname;
    const done = await withBusy("Opening billing portal", async () => {
      const { url } = await state.store.createPortalSession(returnUrl);
      location.href = url;
    });
    if (!done) notice("Could not open billing portal.", "bad");
  });

  $("#resubscribe")?.addEventListener("click", () => {
    // Re-renders this same page's plan cards - resubscribing is just
    // choosing a plan again, no separate flow needed.
    renderBilling();
  });

  // First render shows "Loading plans…" above; once the fetch resolves,
  // silently re-render with the real list - but only if Billing is still
  // the tab on screen (the user may have already navigated away by the
  // time it resolves).
  ensurePlans(() => {
    if (state.tab === "billing") renderBilling();
  });
}

/** The signed-in individual's own account: identity, role, and sign-out.
    Distinct from Data's Household panel (which manages OTHER members and
    invites) and from Billing (tenant-wide money) - this is the one page
    that's about you specifically, not the household. Only shows real
    fields the backend actually returns (email, role) - no display name or
    avatar exists anywhere in this app's auth (see auth.js/handler.js). */
function renderProfile() {
  const signedIn = !!getIdToken();
  const email = state.userEmail || state.store.user?.email || "";
  const myRole = state.role || "member";
  const roleInfo =
    {
      owner:
        "Full access — can manage billing, invite or remove members, and use every feature.",
      admin: "Can invite members. Billing stays with the owner.",
      member:
        "Can add and edit transactions, budget and net worth. Inviting and billing stay with the owner or admins.",
    }[myRole] || "";
  const members = state.members || [];
  const tenants = state.tenants || [];

  view.innerHTML = `
  <div class="head"><div><h1>Profile</h1><p class="sub">Your account in this ledger.</p></div></div>

  <div class="eyebrow">Account</div>
  <div class="panel stack">
    ${
      signedIn
        ? `
    <p class="note" style="margin:0">Signed in as <b>${esc(email || "unknown")}</b>.</p>
    <p class="note" style="margin:0">Your role: <b>${esc(myRole)}</b>. ${esc(roleInfo)}</p>
    <p class="note" style="margin:0">Sign-in is Google-only — there's no separate Ledger password to set or reset.</p>`
        : `<p class="note" style="margin:0">Not signed in to a Ledger account.</p>`
    }
  </div>

  ${
    signedIn
      ? `
  <div class="eyebrow">Currency</div>
  <div class="panel stack">
    <label>Display currency
      <select id="profile-currency">
        ${CURRENCIES.map(
          (c) =>
            `<option value="${esc(c)}"${c === (state.tenant?.currency || "CAD") ? " selected" : ""}>${esc(c)}</option>`,
        ).join("")}
      </select>
    </label>
    <p class="note" style="margin:0">Changes how amounts are formatted everywhere in this household's ledger. Every amount already entered keeps its original number — only the currency label changes, nothing is converted.</p>
  </div>`
      : ""
  }

  ${
    signedIn
      ? `
  <div class="eyebrow">Household</div>
  <div class="panel stack">
    <p class="note" style="margin:0">${members.length} member${members.length === 1 ? "" : "s"} in this household.${tenants.length > 1 ? ` You belong to ${tenants.length} households.` : ""}</p>
    <p class="note" style="margin:0">Manage members, invites${tenants.length > 1 ? " and switch households" : ""} from Data &rarr; Household.</p>
  </div>

  <div class="eyebrow">Session</div>
  <div class="panel"><div class="actions">
    <button class="btn ghost" id="profile-signout">Sign out</button>
  </div></div>`
      : ""
  }`;

  $("#profile-currency")?.addEventListener("change", async (e) => {
    const currency = e.target.value;
    await withBusy(`Switching to ${currency}`, async () => {
      await state.store.setCurrency(currency);
      await refresh();
    });
    renderProfile();
  });
  $("#profile-signout")?.addEventListener("click", signOut);
}

/* ==================================================================== router */
const VIEWS = {
  dashboard: renderDashboard,
  cashflow: renderCashFlow,
  spending: renderSpending,
  add: renderAdd,
  transactions: renderTransactions,
  budget: renderBudget,
  networth: renderNetWorth,
  data: renderData,
  billing: renderBilling,
  profile: renderProfile,
};

function go(tab) {
  state.tab = tab;
  charts.destroyAll();
  // dataset.shell lives on the #view ELEMENT, not its children - reassigning
  // innerHTML for a DIFFERENT page never clears it on its own. Without this,
  // Dashboard -> Transactions -> Dashboard could find the stale flag still
  // set, wrongly take the fast patch path against Transactions' leftover
  // markup, and silently show nothing new at all. Only renderDashboard()'s
  // OWN direct calls (from its year/month selectors, which bypass go()
  // entirely) should ever see this flag intact.
  delete view.dataset.shell;
  document
    .querySelectorAll("#tabs button")
    .forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  location.hash = tab;
  viewTransition(() => {
    (VIEWS[tab] || renderDashboard)();
    window.scrollTo(0, 0);
  });
}

document.querySelectorAll("#tabs button").forEach(
  (b) =>
    (b.onclick = () => {
      if (b.dataset.tab !== "add") state.editing = null;
      go(b.dataset.tab);
    }),
);

// A tenant that downgraded to Free still HAS its older transactions on the
// server - the Free plan's 12-month window only hides them from what the
// API returns (see backend/src/plans.js's FEATURES.historyMonths). The
// destructive flows below, though, clear the table server-side with no date
// filter at all, so they delete those hidden rows too, and neither the
// "Delete all N transactions" count nor the import's "Replace everything
// first" wording would otherwise account for them. Only a tenant that has
// been through checkout (hasStripeCustomer) can have rows outside the
// window, so the warning is scoped to exactly that case rather than shown
// to every Free user.
const hiddenHistoryWarning = () =>
  state.tenant?.plan === "free" && state.tenant?.hasStripeCustomer
    ? "\n\nWARNING: your account is on the Free plan, which only shows the last 12 months. Older transactions that are currently hidden from you will ALSO be permanently deleted, and they are not in the counts above or in an export taken now."
    : "";

(async function main() {
  // XLSX is deliberately excluded - it's loaded on demand by xlsxio.js when
  // Export/Import is actually clicked, not before. Waiting for it here would
  // reintroduce the exact 930KB blocking cost this change removes.
  const ready = () => typeof Chart !== "undefined";
  if (!ready())
    await new Promise((r) =>
      window.addEventListener("load", r, { once: true }),
    );

  // A redirect back from Cognito's Hosted UI carries the id_token in the URL
  // fragment - consume it before deciding whether the gate needs showing, so
  // a just-completed sign-in doesn't get shown the gate again.
  consumeAuthRedirect();

  // Sign-in is always required — this is multi-tenant SaaS with no
  // local/offline mode to fall back to (see store.js), so an unauthenticated
  // session has nothing to show. If Cognito itself isn't configured for this
  // deployment, showGate() renders that as its own clear error rather than a
  // broken sign-in button.
  if (!getIdToken()) {
    showGate();
    return;
  }

  try {
    await boot();
  } catch (e) {
    if (e?.auth || /sign in|not permitted/i.test(e?.message || "")) {
      setIdToken("");
      showGate(e.message);
    } else {
      revealApp();
      throw e;
    }
  }
})();
