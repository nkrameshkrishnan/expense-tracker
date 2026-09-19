import { CAT_NAMES } from "../store.js";
import {
  $,
  view,
  esc,
  state,
  withBusy,
  notice,
  refresh,
  switchActiveTenant,
} from "../core.js";
import { exportWorkbook, importFile, money } from "../xlsxio.js";
import { listFor } from "../categories.js";
import { ensurePlans } from "../tenant.js";
import { isRemoteStore } from "../auth.js";
import { go } from "../router.js";

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

export function renderData() {
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
