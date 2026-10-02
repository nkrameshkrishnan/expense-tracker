/* Net worth page: asset/liability accounts, balances, and the debt-card
   list (debt-specific logic itself lives in debts.js). */
import {
  PEOPLE,
  UNASSIGNED,
  CUSTOM_KEY,
  NET_WORTH_ACCOUNTS,
  CURRENCIES,
  toCad,
  balanceCad,
  getHomeCurrency,
} from "../store.js";
import { money, moneyIn } from "../xlsxio.js";
import { loadCustom } from "../categories.js";
import * as charts from "../charts.js";
import {
  $,
  view,
  esc,
  state,
  personLabel,
  kpi,
  notice,
  withBusy,
} from "../core.js";
import { go } from "../router.js";
import { backendLabel, isRemoteStore } from "../auth.js";
import { emptyIcon } from "../icons.js";
import { debtNetWorth, renderDebtSection, wireDebtHandlers } from "./debts.js";
import {
  metalsSummary,
  renderMetalsSection,
  wireMetalsHandlers,
} from "./metals.js";
import {
  fixedDepositsSummary,
  renderFixedDepositsSection,
  wireFixedDepositsHandlers,
} from "./fixed-deposits.js";

// Which of the Net Worth page's own in-page tabs is showing. "Overview" is
// the page's original content (balances/snapshots/trend); Debts, Metals and
// Fixed Deposits each get their own tab rather than stacking as
// always-visible sections underneath Overview, the way they used to. A
// plain module-level variable, not state.*: it only needs to survive this
// page's own re-renders (after a save, a delete, etc.), the same lifetime
// renderBalanceForm's local variables already rely on, not a page
// navigation - leaving Net Worth and coming back to "Overview" by default
// is the expected reset, same as any other page's scroll position or
// in-progress form.
let activeTab = "overview";
const NW_TABS = [
  { id: "overview", label: "Overview" },
  { id: "debts", label: "Debts & Loans" },
  { id: "metals", label: "Precious Metals" },
  { id: "fixeddeposits", label: "Fixed Deposits" },
];

function nwAccounts() {
  const custom = loadCustom().nwAccount || [];
  // Accounts the person deleted. A custom account is simply dropped from
  // its own list (below), but a built-in NET_WORTH_ACCOUNTS entry has
  // nowhere else to record "deleted" - it's a hardcoded array in
  // constants.js, not this browser's storage - so it's hidden here
  // instead. Same for an account that only exists because an old snapshot
  // still references it; without this it would keep reappearing the
  // moment its balances were re-fetched.
  const hidden = new Set(loadCustom().nwAccountHidden || []);
  const seen = new Map();
  for (const a of NET_WORTH_ACCOUNTS) seen.set(a.account, a);
  for (const b of state.balances || []) {
    if (!seen.has(b.account)) {
      seen.set(b.account, {
        account: b.account,
        owner: b.owner || "Ramesh",
        kind: b.kind === "Liability" ? "Liability" : "Asset",
      });
    }
  }
  for (const c of custom) seen.set(c.account, c);
  for (const name of hidden) seen.delete(name);
  return [...seen.values()];
}

/** Owners that actually have accounts, so a Family account gets its own group. */
function nwOwners() {
  const set = new Set(nwAccounts().map((a) => a.owner));
  return [
    ...PEOPLE.filter((p) => set.has(p)),
    ...[...set].filter((o) => !PEOPLE.includes(o)),
  ];
}

function addNwAccount(account, owner, kind) {
  const name = String(account || "").trim();
  if (!name) return false;
  if (nwAccounts().some((a) => a.account.toLowerCase() === name.toLowerCase()))
    return false;
  const c = loadCustom();
  c.nwAccount = [...(c.nwAccount || []), { account: name, owner, kind }];
  // Un-hide: adding an account under a name that was previously deleted
  // (a built-in one, most likely) should bring it back rather than have
  // nwAccounts() immediately hide the very entry just created.
  c.nwAccountHidden = (c.nwAccountHidden || []).filter((a) => a !== name);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(c));
  return true;
}

/** Removes an account from the picklist - a custom one is dropped outright,
    while a built-in NET_WORTH_ACCOUNTS entry (which lives in constants.js,
    not in this browser's storage) is instead added to a hide-list so
    nwAccounts() stops offering it. Either way this only touches the
    picklist; call deleteAccountBalances() first if the account has any
    recorded balances to clear out too. */
function removeNwAccount(account) {
  const c = loadCustom();
  c.nwAccount = (c.nwAccount || []).filter((a) => a.account !== account);
  c.nwAccountHidden = [...new Set([...(c.nwAccountHidden || []), account])];
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(c));
}

/* ---------------------------------------------------------- debts and loans
   A debt is an agreement plus its repayment history. Outstanding is always
   recomputed as principal minus payments, never stored, so the number on
   screen cannot drift away from the payments that produced it.

   Direction is from your side:
     Owed  - you owe them  -> a LIABILITY, reduces net worth
     Lent  - they owe you  -> an ASSET (a receivable), increases net worth

   These sit alongside Transactions, they do not replace them. Sending $200 to
   Varun is a Transfer in Transactions (cash left an account) AND a payment
   here (a balance-sheet position changed). Counting it as an expense in
   Transactions would be the actual error - lending money is not spending it. */
// jsPDF + autotable together are a genuinely large download (a few hundred
// KB) for something only the "Export PDF" button on a debt card ever
// touches - loaded on first actual use and cached, same reasoning and same
// pattern as loadXLSX() in xlsxio.js for the spreadsheet Export/Import
// buttons. Dynamic import() rather than a <script> tag: both libraries'
// jsdelivr CDN builds are ES modules (the `+esm` on-the-fly bundle
// jsdelivr generates for any npm package), and app.js is already loaded as
// type="module", so this needs no UMD-global juggling the way xlsx.js's
// script-tag approach does.

export function renderNetWorth() {
  const snaps = state.balances || [];
  const dates = [...new Set(snaps.map((b) => b.date))].sort().reverse();
  const latest = dates[0] || null;
  const prev = dates[1] || null;

  const at = (d) => snaps.filter((b) => b.date === d);
  const scopeOwner =
    state.person && state.person !== UNASSIGNED ? state.person : null;
  const sumOf = (d, kind) =>
    at(d)
      .filter((b) => b.kind === kind && (!scopeOwner || b.owner === scopeOwner))
      .reduce((a, b) => a + balanceCad(b), 0);

  // Outstanding debts and loans are part of net worth, computed from their
  // payment history rather than needing a balance snapshot of their own.
  const dnw = debtNetWorth(state.debts || [], scopeOwner);
  const metalHoldings = (state.metalHoldings || []).filter(
    (h) => !scopeOwner || h.owner === scopeOwner,
  );
  const metalsValue = metalsSummary(
    metalHoldings,
    state.goldPrice || null,
  ).value;
  const fixedDeposits = (state.fixedDeposits || []).filter(
    (d) => !scopeOwner || d.owner === scopeOwner,
  );
  const today = new Date().toISOString().slice(0, 10);
  const fdValueCad = fixedDepositsSummary(fixedDeposits, today).totalValueCad;
  const assets =
    (latest ? sumOf(latest, "Asset") : 0) +
    dnw.receivable +
    metalsValue +
    fdValueCad;
  const liabs = (latest ? sumOf(latest, "Liability") : 0) + dnw.liability;
  const net = assets - liabs;
  const prevNet = prev ? sumOf(prev, "Asset") - sumOf(prev, "Liability") : null;
  const delta = prevNet === null ? null : net - prevNet;

  const accounts = nwAccounts().filter(
    (a) => !scopeOwner || a.owner === scopeOwner,
  );
  // Returns the CAD-equivalent (balanceCad), or null when that account has no
  // row in that snapshot. A separate valueAtRow() below gets at the native
  // balance/currency for display - this one is for arithmetic (the "By
  // account" table's month-over-month Change, and anything else that sums or
  // diffs across accounts, must never mix currencies).
  const valueAt = (d, acct) => {
    const hit = at(d).find((b) => b.account === acct);
    return hit ? balanceCad(hit) : null;
  };
  const valueAtRow = (d, acct) => at(d).find((b) => b.account === acct) || null;

  const series = [...dates].reverse().map((d) => ({
    date: d,
    net: sumOf(d, "Asset") - sumOf(d, "Liability"),
    assets: sumOf(d, "Asset"),
    liabs: sumOf(d, "Liability"),
    covered: at(d).filter((b) => !scopeOwner || b.owner === scopeOwner).length,
  }));

  // Comparing snapshots that cover different numbers of accounts is misleading:
  // net worth appears to jump when really the coverage changed. Say so.
  const maxCover = Math.max(0, ...series.map((s) => s.covered));
  const uneven = series.some((s) => s.covered !== maxCover);
  const missing = latest
    ? accounts.filter((a) => valueAt(latest, a.account) === null)
    : accounts;

  // "Refresh FX" only ever touches the LATEST snapshot's stored fx_rate, and
  // only for accounts already in a non-CAD currency - it never changes a
  // native balance, never creates a new dated snapshot, and never rewrites
  // an older snapshot (those stay historically accurate to the rate on the
  // day they were recorded, same as the trend chart below). It's purely
  // "bring today's rate into the current total", for the gap-between-
  // snapshots problem: a foreign balance can drift in CAD value purely from
  // FX movement even when nothing about the account itself changed, and
  // nothing else here would ever notice that on its own.
  const foreignInLatest = latest
    ? at(latest).filter((b) => b.currency && b.currency !== "CAD")
    : [];
  const canRefreshFx =
    foreignInLatest.length > 0 &&
    typeof state.store.getExchangeRate === "function";

  const fmtDate = (d) => {
    try {
      return new Date(d + "T12:00:00").toLocaleDateString("en-CA", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    } catch {
      return d;
    }
  };

  view.innerHTML = `
  <div class="head">
    <div><h1>Net worth</h1>
      <p class="sub">${esc(personLabel())}${latest ? " &middot; " + dates.length + " snapshot" + (dates.length > 1 ? "s" : "") : ""}</p>
    </div>
    <div class="spacer"></div>
    <button class="btn" id="nw-record">Record balances</button>
  </div>

  <div class="nw-tabs" role="tablist">
    ${NW_TABS.map(
      (t) =>
        `<button class="nw-tab-btn${activeTab === t.id ? " on" : ""}" data-nwtab="${t.id}" type="button" role="tab" aria-selected="${activeTab === t.id}">${t.label}</button>`,
    ).join("")}
  </div>

  ${
    activeTab === "fixeddeposits"
      ? renderFixedDepositsSection(scopeOwner)
      : activeTab === "debts"
        ? renderDebtSection(scopeOwner)
        : activeTab === "metals"
          ? renderMetalsSection(scopeOwner)
          : `
  ${
    !isRemoteStore(state.store)
      ? `<div class="nw-warn" style="border-left-color:var(--red)">
    <b>Not connected to Supabase.</b> Everything on this page is saved to
    ${state.store.kind === "memory" ? "this session only \u2014 it will be lost on reload" : "this browser only"}.
    Connect under <b>Data \u2192 Supabase</b> if you want balances to persist.
  </div>`
      : ""
  }

  ${
    !latest
      ? `<div class="empty">${emptyIcon()}<span>No balances recorded yet. Click <b>Record balances</b> to enter what each
     account is worth today &mdash; separate from your transactions, and never affects income or expense.</span></div>`
      : `

  <div class="nw-asat">
    <span class="nw-asat-label">Net worth as at</span>
    <span class="nw-asat-date">${esc(fmtDate(latest))}</span>
    ${
      canRefreshFx
        ? `<button class="btn ghost nw-refresh-btn" id="nw-refresh-fx" type="button"
             title="Re-fetch today's rate for ${esc(foreignInLatest.map((b) => b.account).join(", "))} and update this snapshot's CAD totals — native balances and older snapshots are untouched">
             &#8635; Refresh FX (${foreignInLatest.length})</button>`
        : ""
    }
    <span class="nw-asat-note">${
      latest === dates[0] && dates.length > 1
        ? `updates automatically when you record a newer snapshot`
        : `record a newer snapshot to move this forward`
    }</span>
  </div>

  <div class="kpis">
    ${kpi("Assets", money(assets), `${at(latest).filter((b) => b.kind === "Asset" && (!scopeOwner || b.owner === scopeOwner)).length} accounts`)}
    ${kpi("Liabilities", money(liabs), liabs > 0 ? "owed" : "nothing owed")}
    ${kpi("Net worth", money(net), "", net < 0 ? "neg" : "pos")}
    ${kpi(
      "Change",
      delta === null ? "\u2014" : (delta >= 0 ? "+" : "") + money(delta),
      prev ? `since ${prev}` : "need a second snapshot",
      delta === null ? "" : delta < 0 ? "neg" : "pos",
    )}
  </div>

  ${
    series.length > 1
      ? `
  <div class="eyebrow">Over time</div>
  <div class="grid2">
    <div class="panel"><h3>Net worth trend</h3><div class="chartbox"><canvas id="c-nw-trend"></canvas></div></div>
    <div class="panel"><h3>Assets by account &mdash; ${esc(latest)}</h3><div class="chartbox"><canvas id="c-nw-split"></canvas></div></div>
  </div>`
      : `<p class="note">Record a second snapshot to see a trend. Monthly is plenty &mdash; balances move slowly.</p>`
  }

  ${
    missing.length
      ? `<div class="nw-warn">
    <b>${missing.length} account${missing.length > 1 ? "s have" : " has"} no balance in this snapshot</b> &mdash;
    ${esc(
      missing
        .slice(0, 4)
        .map((a) => a.account)
        .join(", "),
    )}${missing.length > 4 ? ` and ${missing.length - 4} more` : ""}.
    They are excluded from the totals above rather than counted as zero.
  </div>`
      : ""
  }

  ${
    uneven
      ? `<div class="nw-warn">
    Snapshots cover different numbers of accounts (${Math.min(...series.map((s) => s.covered))}\u2013${maxCover}),
    so the trend below partly reflects <b>changing coverage, not changing wealth</b>.
    Record every account on the same date for a comparable line.
  </div>`
      : ""
  }

  <div class="eyebrow">By account &mdash; ${esc(latest)}</div>
  <div class="tablewrap"><table><thead><tr>
    <th>Account</th><th>Owner</th><th>Kind</th><th class="n">Balance</th>
    <th class="n">${prev ? "Change" : ""}</th></tr></thead><tbody>
    ${accounts
      .map((a) => {
        const row = valueAtRow(latest, a.account);
        const v = row ? balanceCad(row) : null;
        const p = prev ? valueAt(prev, a.account) : null;
        const ch = v !== null && p !== null ? v - p : null;
        const foreign = row && row.currency && row.currency !== "CAD";
        return `<tr class="${v === null ? "nw-blank" : ""}">
        <td>${esc(a.account)}</td>
        <td><span class="person-chip" data-p="${esc(a.owner)}">${esc(a.owner)}</span></td>
        <td><span class="tag">${a.kind}</span></td>
        <td class="n num">${
          v === null
            ? '<span class="muted">not recorded</span>'
            : foreign
              ? `${moneyIn(row.balance, row.currency)}<br><span class="muted" style="font-size:10.5px">\u2248 ${money(v)} ${getHomeCurrency()}</span>`
              : money(v)
        }</td>
        <td class="n num ${ch === null ? "muted" : ch < 0 ? "tx-over" : "tx-income"}">${
          ch === null ? "\u2014" : (ch >= 0 ? "+" : "") + money(ch)
        }</td></tr>`;
      })
      .join("")}
  </tbody></table></div>

  <div class="eyebrow">Snapshots</div>
  <div class="tablewrap"><table><thead><tr><th>Date</th><th class="n">Accounts</th><th class="n">Assets</th><th class="n">Liabilities</th><th class="n">Net worth</th><th></th></tr></thead><tbody>
    ${[...series]
      .reverse()
      .map(
        (x) => `<tr>
      <td class="num">${esc(x.date)}</td>
      <td class="n num ${x.covered < maxCover ? "muted" : ""}">${x.covered}${x.covered < maxCover ? " of " + maxCover : ""}</td>
      <td class="n num">${money(x.assets)}</td>
      <td class="n num">${money(x.liabs)}</td>
      <td class="n num"><b>${money(x.net)}</b></td>
      <td><button class="rowbtn" data-delsnap="${esc(x.date)}" title="Delete this snapshot">\u2715</button></td>
    </tr>`,
      )
      .join("")}
  </tbody></table></div>
  `
  }
  `
  }`;

  view.querySelectorAll("[data-nwtab]").forEach(
    (b) =>
      (b.onclick = () => {
        activeTab = b.dataset.nwtab;
        renderNetWorth();
      }),
  );

  if (activeTab === "fixeddeposits") {
    wireFixedDepositsHandlers();
    return;
  }
  if (activeTab === "debts") {
    wireDebtHandlers();
    return;
  }
  if (activeTab === "metals") {
    wireMetalsHandlers();
    return;
  }

  $("#nw-record").onclick = () => renderBalanceForm(latest);

  if (canRefreshFx) {
    $("#nw-refresh-fx").onclick = async () => {
      const today = new Date().toISOString().slice(0, 10);
      let refreshed = [];
      let misses = [];
      const done = await withBusy(
        `Refreshing today's rate for ${foreignInLatest.length} account${foreignInLatest.length > 1 ? "s" : ""}`,
        async () => {
          const entries = await Promise.all(
            at(latest).map(async (row) => {
              const base = {
                account: row.account,
                owner: row.owner,
                kind: row.kind,
                balance: row.balance,
                currency: row.currency || "CAD",
                fx_rate: row.fx_rate || 1,
                notes: row.notes || "",
              };
              if (!row.currency || row.currency === "CAD") return base;
              const fx = await state.store.getExchangeRate(today, row.currency);
              if (!fx) {
                misses.push(row.account);
                return base; // leave this one's rate exactly as it was
              }
              refreshed.push(row.account);
              return { ...base, fx_rate: fx.rateToCad };
            }),
          );
          // Same primary key as a normal save (date, account) - this replaces
          // the latest snapshot in place rather than creating a new dated one.
          await state.store.setBalances(latest, entries);
          state.balances = await state.store.getBalances();
        },
      );
      if (done) {
        renderNetWorth();
        if (refreshed.length && !misses.length) {
          notice(
            `Refreshed today's rate for ${refreshed.join(", ")}. Native balances and older snapshots are unchanged.`,
            "ok",
          );
        } else if (refreshed.length && misses.length) {
          notice(
            `Refreshed ${refreshed.join(", ")}. No rate available yet for ${misses.join(", ")} — left as is.`,
            "ok",
          );
        } else {
          notice(
            `No exchange rate available yet for ${misses.join(", ")}. Try again after today's rate has been fetched.`,
            "bad",
          );
        }
      }
    };
  }
  view.querySelectorAll("[data-delsnap]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm(`Delete the whole snapshot dated ${b.dataset.delsnap}?`))
          return;
        const done = await withBusy("Deleting snapshot", async () => {
          await state.store.deleteBalanceDate(b.dataset.delsnap);
          state.balances = await state.store.getBalances();
        });
        if (done) {
          renderNetWorth();
          notice("Snapshot deleted.", "ok");
        }
      }),
  );

  if (typeof Chart !== "undefined" && series.length > 1) {
    charts.netWorthTrend(series);
    charts.assetSplit(
      at(latest).filter(
        (b) => b.kind === "Asset" && (!scopeOwner || b.owner === scopeOwner),
      ),
    );
  }
}

function renderBalanceForm(copyFrom) {
  const today = new Date().toISOString().slice(0, 10);
  const snaps = state.balances || [];
  const dates = [...new Set(snaps.map((b) => b.date))].sort().reverse();
  const source = copyFrom || dates[0] || null;
  const existing = snaps.filter((b) => b.date === source);
  const prefill = (a) => {
    const hit = existing.find((x) => x.account === a.account);
    return hit ? Number(hit.balance) : "";
  };
  // An account's currency is a property of the account itself in practice
  // (an INR savings account doesn't switch currency month to month) - rather
  // than a separate setting to maintain, it's just read off that account's
  // own most recent snapshot, anywhere one exists yet. Brand new accounts
  // default to CAD and the person picks the right one on first entry.
  const lastCurrencyFor = (acct) => {
    const rows = snaps
      .filter((b) => b.account === acct)
      .sort((x, y) => (x.date < y.date ? 1 : -1));
    return rows[0]?.currency || "CAD";
  };
  const prefillRate = (a) => {
    const hit = existing.find((x) => x.account === a.account);
    return hit && hit.currency && hit.currency !== "CAD" ? hit.fx_rate : "";
  };

  const groupRows = (owner) =>
    nwAccounts()
      .filter((a) => a.owner === owner)
      .map((a) => {
        const ccy = existing.find((x) => x.account === a.account)?.currency ||
          lastCurrencyFor(a.account);
        return `
    <tr>
      <td>${esc(a.account)}
        <button class="rowbtn nw-del-acct" data-delacct="${esc(a.account)}"
           title="Delete this account">\u2715</button></td>
      <td><span class="tag ${a.kind === "Liability" ? "tag-liab" : ""}">${a.kind}</span></td>
      <td class="n">
        <div class="nw-input-wrap">
          <span class="nw-currency">$</span>
          <input class="num nw-input" type="number" step="0.01" inputmode="decimal"
            data-account="${esc(a.account)}" data-owner="${esc(a.owner)}" data-kind="${a.kind}"
            value="${prefill(a)}" placeholder="0.00">
          <select class="nw-ccy-select" data-ccy-for="${esc(a.account)}">
            ${CURRENCIES.map((c) => `<option value="${c}"${c === ccy ? " selected" : ""}>${c}</option>`).join("")}
          </select>
        </div>
        <div class="nw-fx-row" data-fxrow-for="${esc(a.account)}" ${ccy === "CAD" ? 'style="display:none"' : ""}>
          <input class="nw-fx-input" type="number" step="0.000001" min="0.000001"
            data-fx-for="${esc(a.account)}" value="${prefillRate(a)}" placeholder="rate to CAD">
          <span class="muted" style="font-size:10.5px">1 ${esc(ccy)} = ? CAD</span>
        </div>
      </td>
    </tr>`;
      })
      .join("");

  view.innerHTML = `
  <div class="head">
    <div><h1>Record balances</h1>
      <p class="sub">One snapshot per date. Saving the same date again replaces it rather than duplicating.</p></div>
    <div class="spacer"></div><button class="btn ghost" id="nw-back">&larr; Back</button>
  </div>

  <div class="nw-form-bar">
    <label class="f"><span>Snapshot date</span><input type="date" id="nw-date" value="${today}"></label>
    ${source ? `<button class="btn ghost" id="nw-copy" type="button">Copy from ${esc(source)}</button>` : ""}
    <button class="btn ghost" id="nw-clear" type="button">Clear all</button>
    <label class="btn ghost nw-import-btn" for="nw-import">Import file\u2026</label>
    <input type="file" id="nw-import" accept=".json,.csv" hidden>
    <div class="spacer"></div>
    <div class="nw-running">
      <span class="nw-running-label">Running net worth</span>
      <span class="nw-running-val num" id="nw-total">$0.00</span>
      <span class="nw-running-sub" id="nw-breakdown">&mdash;</span>
    </div>
  </div>

  <div id="nw-import-out" class="note" style="margin:0 0 10px"></div>

  ${nwOwners()
    .map(
      (owner) => `
    <div class="eyebrow">${owner} <span class="muted" style="text-transform:none;letter-spacing:0" id="nw-sub-${owner}"></span></div>
    <div class="tablewrap"><table><thead><tr><th>Account</th><th>Kind</th><th class="n" style="width:230px">Balance</th></tr></thead>
      <tbody>${groupRows(owner)}</tbody></table></div>`,
    )
    .join("")}

  <div class="actions" style="margin-top:18px">
    <button class="btn" id="nw-save">Save snapshot</button>
    <span class="muted" id="nw-hint">Blank accounts are omitted from the snapshot, not recorded as zero.</span>
  </div>

  <div class="eyebrow">Add an account</div>
  <div class="panel">
    <div class="nw-add-row">
      <label class="f" style="flex:2;min-width:180px"><span>Account name</span>
        <input id="nw-new-name" placeholder="e.g. Car loan, RESP, Condo" autocomplete="off"></label>
      <label class="f"><span>Owner</span>
        <select id="nw-new-owner">${PEOPLE.map((p) => `<option${p === "Ramesh" ? " selected" : ""}>${esc(p)}</option>`).join("")}</select></label>
      <label class="f"><span>Kind</span>
        <select id="nw-new-kind"><option>Asset</option><option>Liability</option></select></label>
      <button class="btn" id="nw-add-acct" type="button">Add</button>
    </div>
    <p class="note" style="margin:10px 0 0">Anything with a value counts: a car, a property, an RESP,
      a loan, money owed to family. <b>Asset</b> adds to net worth, <b>Liability</b> subtracts.
      Accounts you add can be removed with the \u2715 beside their name, as long as no snapshot uses them.</p>
  </div>

  <p class="note"><b>Import file\u2026</b> loads a <code>.json</code> or <code>.csv</code> from your machine
    (columns <code>date, account, owner, kind, balance</code>, plus optional <code>currency</code> and
    <code>fx_rate</code> for an INR/AED account &mdash; omit both and CAD is assumed). It is read in the browser
    and written straight to your sheet &mdash; never uploaded, never stored in the repository.</p>
  <p class="note">Enter liabilities as positive numbers &mdash; a $500 card balance is <code>500</code>, and it is
    subtracted from net worth automatically. Balances never affect your income, expense or budget figures.</p>`;

  // rateFor() falls back to 1 when the field is blank/invalid - that fallback
  // is only correct for the LIVE PREVIEW total (recalc(), below), which must
  // show *some* number as the person types. It must never be used to decide
  // whether a real rate was actually entered - rawRateFor() below is for
  // that, so the missing-rate save guard can't be defeated by its own
  // fallback the way it briefly was.
  const rawRateFor = (acct) =>
    view.querySelector(`.nw-fx-input[data-fx-for="${CSS.escape(acct)}"]`)
      ?.value ?? "";
  const rateFor = (acct) => Number(rawRateFor(acct)) || 1;
  const ccyFor = (acct) =>
    view.querySelector(`.nw-ccy-select[data-ccy-for="${CSS.escape(acct)}"]`)
      ?.value || "CAD";

  const recalc = () => {
    let A = 0,
      L = 0,
      filled = 0;
    const perOwner = Object.fromEntries(nwOwners().map((o) => [o, 0]));
    view.querySelectorAll(".nw-input").forEach((i) => {
      if (i.value === "") return;
      filled++;
      const native = Math.abs(Number(i.value) || 0);
      const ccy = ccyFor(i.dataset.account);
      // Running total is always CAD - a foreign row's rate field (1 when the
      // field is blank/not yet entered, same fallback normalise() uses)
      // converts it before it's added in, so an INR balance never gets
      // added to a CAD one as if they were the same unit.
      const v = ccy === "CAD" ? native : toCad(native, rateFor(i.dataset.account));
      if (i.dataset.kind === "Liability") {
        L += v;
        perOwner[i.dataset.owner] -= v;
      } else {
        A += v;
        perOwner[i.dataset.owner] += v;
      }
    });
    $("#nw-total").textContent = money(A - L);
    $("#nw-total").className =
      "nw-running-val num " + (A - L < 0 ? "tx-over" : "tx-income");
    $("#nw-breakdown").textContent = filled
      ? `${money(A)} assets \u2212 ${money(L)} liabilities \u00b7 ${filled} account${filled > 1 ? "s" : ""}`
      : "nothing entered yet";
    for (const o of nwOwners()) {
      const el = $("#nw-sub-" + o);
      if (el)
        el.textContent = perOwner[o] ? `\u00b7 ${money(perOwner[o])}` : "";
    }
  };
  view
    .querySelectorAll(".nw-input")
    .forEach((i) => i.addEventListener("input", recalc));
  view.querySelectorAll(".nw-fx-input").forEach((i) =>
    i.addEventListener("input", recalc),
  );
  view.querySelectorAll(".nw-ccy-select").forEach((sel) =>
    sel.addEventListener("change", async () => {
      const acct = sel.dataset.ccyFor;
      const row = view.querySelector(`[data-fxrow-for="${CSS.escape(acct)}"]`);
      const rateInput = view.querySelector(
        `.nw-fx-input[data-fx-for="${CSS.escape(acct)}"]`,
      );
      if (row) {
        row.style.display = sel.value === "CAD" ? "none" : "";
        const label = row.querySelector("span");
        if (label) label.textContent = `1 ${sel.value} = ? CAD`;
      }
      if (sel.value === "CAD") {
        if (rateInput) rateInput.value = "";
      } else if (rateInput && !rateInput.value) {
        // Same optional-chained lookup Add page uses - only present on
        // SupabaseStore, so this is a no-op (manual entry) on Local/Memory.
        const found = await state.store.getExchangeRate?.(
          $("#nw-date")?.value || today,
          sel.value,
        );
        if (found) rateInput.value = found.rateToCad;
      }
      recalc();
    }),
  );
  recalc();

  $("#nw-add-acct").onclick = () => {
    const name = $("#nw-new-name").value.trim();
    if (!name) return notice("Give the account a name.", "bad");
    if (
      !addNwAccount(name, $("#nw-new-owner").value, $("#nw-new-kind").value)
    ) {
      return notice(`"${name}" already exists.`, "bad");
    }
    notice(
      `Added "${name}". Enter its balance above, then save the snapshot.`,
      "ok",
    );
    renderBalanceForm(copyFrom);
  };
  $("#nw-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("#nw-add-acct").click();
    }
  });

  view.querySelectorAll("[data-delacct]").forEach(
    (b) =>
      (b.onclick = async () => {
        const name = b.dataset.delacct;
        const used = (state.balances || []).filter((x) => x.account === name);
        const warning = used.length
          ? ` This deletes ${used.length} recorded balance${used.length > 1 ? "s" : ""} for it across ${new Set(used.map((x) => x.date)).size} snapshot${new Set(used.map((x) => x.date)).size > 1 ? "s" : ""}.`
          : "";
        if (!confirm(`Delete "${name}" from the account list?${warning}`))
          return;
        const done = await withBusy(`Deleting "${name}"`, async () => {
          if (used.length) {
            await state.store.deleteBalanceAccount(name);
            state.balances = await state.store.getBalances();
          }
          removeNwAccount(name);
        });
        if (done) {
          renderBalanceForm(copyFrom);
          notice(`Deleted "${name}".`, "ok");
        }
      }),
  );

  $("#nw-back").onclick = () => renderNetWorth();
  $("#nw-clear").onclick = () => {
    view.querySelectorAll(".nw-input").forEach((i) => {
      i.value = "";
    });
    recalc();
  };
  $("#nw-copy")?.addEventListener("click", () => {
    view.querySelectorAll(".nw-input").forEach((i) => {
      const hit = existing.find((x) => x.account === i.dataset.account);
      i.value = hit ? Number(hit.balance) : "";
    });
    view.querySelectorAll(".nw-ccy-select").forEach((sel) => {
      const hit = existing.find((x) => x.account === sel.dataset.ccyFor);
      sel.value = hit?.currency || "CAD";
      sel.dispatchEvent(new Event("change"));
    });
    view.querySelectorAll(".nw-fx-input").forEach((i) => {
      const hit = existing.find((x) => x.account === i.dataset.fxFor);
      i.value = hit && hit.currency !== "CAD" ? hit.fx_rate : "";
    });
    recalc();
    notice(
      `Copied ${existing.length} balances from ${source} \u2014 edit what changed, then save.`,
      "ok",
    );
  });

  $("#nw-import").onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const out = $("#nw-import-out");
    try {
      const text = await file.text();
      let rows;
      if (file.name.toLowerCase().endsWith(".json")) {
        rows = JSON.parse(text);
      } else {
        const lines = text.trim().split(/\r?\n/);
        const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
        rows = lines
          .slice(1)
          .filter(Boolean)
          .map((l) => {
            const c = l.split(",");
            const g = (k) =>
              head.indexOf(k) === -1
                ? ""
                : String(c[head.indexOf(k)] ?? "").trim();
            return {
              date: g("date"),
              account: g("account"),
              owner: g("owner"),
              kind: g("kind"),
              balance: Number(String(g("balance")).replace(/[$,\s]/g, "")),
              currency: g("currency"),
              fx_rate: g("fx_rate") || g("rate") || g("rate to cad"),
            };
          });
      }
      rows = rows.filter(
        (r) =>
          /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
          r.account &&
          isFinite(r.balance),
      );
      if (!rows.length) {
        out.innerHTML =
          '<b class="over">No usable rows. Need date, account and balance.</b>';
        return;
      }
      // Same rule as everywhere else money moves in this feature: a
      // non-CAD row with no valid rate is refused rather than silently
      // defaulted to 1 (which would book a foreign balance as if it were
      // already CAD).
      const badRate = rows.find(
        (r) =>
          r.currency &&
          r.currency !== "CAD" &&
          !(Number(r.fx_rate) > 0),
      );
      if (badRate) {
        out.innerHTML = `<b class="over">"${esc(badRate.account)}" is in ${esc(badRate.currency)} but has no valid fx_rate column value — add one and re-import.</b>`;
        return;
      }
      const byDate = {};
      for (const r of rows) {
        const currency = CURRENCIES.includes(r.currency) ? r.currency : "CAD";
        (byDate[r.date] ||= []).push({
          account: r.account,
          owner: r.owner || "Ramesh",
          kind: r.kind === "Liability" ? "Liability" : "Asset",
          balance: Math.abs(Number(r.balance) || 0),
          currency,
          fx_rate: currency === "CAD" ? 1 : Number(r.fx_rate),
          notes: r.notes || "imported",
        });
      }
      const dateList = Object.keys(byDate).sort();
      if (
        !confirm(
          `Import ${rows.length} balances across ${dateList.length} date(s)?\n\n${dateList.join(", ")}\n\nAny existing snapshot on these dates is replaced.`,
        )
      )
        return;
      const target = backendLabel(state.store);
      if (
        !isRemoteStore(state.store) &&
        !confirm(
          `Not connected to Supabase right now. This import will go to ${target}.\n\n` +
            `Connect first under Data \u2192 Supabase if you want it saved there instead. Continue anyway?`,
        )
      ) {
        out.textContent = "Cancelled.";
        return;
      }
      const done = await withBusy(
        `Importing ${rows.length} balances`,
        async () => {
          for (const [date, entries] of Object.entries(byDate))
            await state.store.setBalances(date, entries);
          state.balances = await state.store.getBalances();
        },
      );
      // State can flip mid-import (a token can expire between click and completion),
      // so report where the data actually landed, not where it was aimed.
      if (done) {
        notice(
          `Imported ${rows.length} balances to ${target}.`,
          isRemoteStore(state.store) ? "ok" : "bad",
        );
        renderNetWorth();
      }
    } catch (err) {
      out.innerHTML = `<b class="over">${esc(err.message)}</b>`;
    }
  };

  $("#nw-save").onclick = async () => {
    const date = $("#nw-date").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return notice("Pick a valid date.", "bad");
    const filledInputs = [...view.querySelectorAll(".nw-input")].filter(
      (i) => i.value !== "",
    );
    // Same discipline as the Add page: normalise() would silently default a
    // missing/invalid rate to 1, recording a foreign balance as if it were
    // already CAD. Refuse to save rather than trust that fallback here.
    const missingRate = filledInputs.find((i) => {
      const ccy = ccyFor(i.dataset.account);
      return ccy !== "CAD" && !(Number(rawRateFor(i.dataset.account)) > 0);
    });
    if (missingRate)
      return notice(
        `Enter the rate to CAD for ${missingRate.dataset.account}.`,
        "bad",
      );
    const entries = filledInputs.map((i) => {
      const currency = ccyFor(i.dataset.account);
      return {
        account: i.dataset.account,
        owner: i.dataset.owner,
        kind: i.dataset.kind,
        balance: Math.abs(Number(i.value) || 0),
        currency,
        fx_rate: currency === "CAD" ? 1 : rateFor(i.dataset.account),
        notes: "",
      };
    });
    if (!entries.length) return notice("Enter at least one balance.", "bad");
    if (
      dates.includes(date) &&
      !confirm(`A snapshot for ${date} already exists. Replace it?`)
    )
      return;
    const target = backendLabel(state.store);
    if (
      !isRemoteStore(state.store) &&
      !confirm(
        `Not connected to Supabase right now. This will save to ${target}.\n\n` +
          `Connect first under Data \u2192 Supabase if you want it saved there instead. Continue anyway?`,
      )
    )
      return;
    const done = await withBusy(
      `Saving ${entries.length} balances`,
      async () => {
        await state.store.setBalances(date, entries);
        state.balances = await state.store.getBalances();
      },
    );
    if (done) {
      notice(
        `Snapshot saved for ${date} to ${target}.`,
        isRemoteStore(state.store) ? "ok" : "bad",
      );
      renderNetWorth();
    }
  };
}

/* ====================================================================== DATA */
