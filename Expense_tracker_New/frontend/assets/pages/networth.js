import { UNASSIGNED, CUSTOM_KEY, NET_WORTH_ACCOUNTS } from "../store.js";
import {
  $,
  view,
  esc,
  state,
  personLabel,
  personColorClass,
  kpi,
  notice,
  withBusy,
} from "../core.js";
import { money } from "../xlsxio.js";
import { loadCustom, listFor } from "../categories.js";
import * as charts from "../charts.js";
import { isRemoteStore } from "../auth.js";
import { debtNetWorth, renderDebtSection, wireDebtHandlers } from "./debts.js";

/* ================================================================= NET WORTH */
/* Balances are snapshots, not movements. Nothing here feeds Income, Expense or
   Budget - a TFSA balance already contains the contributions recorded as
   Transfers, so counting both would double them. */

/* No balance seeding from a bundled file, deliberately. An earlier version
   shipped data/seed-balances.json containing real account balances - in a
   PUBLIC repo, which is the same mistake that put 687 transactions on
   raw.githubusercontent.com. Balances arrive one of two ways now: typed into
   Record balances, or imported from a file you choose at runtime. Neither
   touches the repository. */

/** Every account available on the Net worth tab.
    Built-ins + anything already in your saved balances + anything you add here.
    Deriving from saved balances matters: an account imported from a CSV shows
    up without needing to be registered anywhere. */
function nwAccounts() {
  const custom = loadCustom().nwAccount || [];
  const seen = new Map();
  for (const a of NET_WORTH_ACCOUNTS) seen.set(a.account, a);
  for (const b of state.balances || []) {
    if (!seen.has(b.account)) {
      seen.set(b.account, {
        account: b.account,
        owner: b.owner || UNASSIGNED,
        kind: b.kind === "Liability" ? "Liability" : "Asset",
      });
    }
  }
  for (const c of custom) if (!seen.has(c.account)) seen.set(c.account, c);
  return [...seen.values()];
}

/** Owners that actually have accounts, so a shared account gets its own
    group. Sorted alphabetically - there is no fixed household order to
    prefer since owner names are not known in advance. */
function nwOwners() {
  const set = new Set(nwAccounts().map((a) => a.owner));
  return [...set].sort((a, b) => a.localeCompare(b));
}

function addNwAccount(account, owner, kind) {
  const name = String(account || "").trim();
  if (!name) return false;
  if (nwAccounts().some((a) => a.account.toLowerCase() === name.toLowerCase()))
    return false;
  const c = loadCustom();
  c.nwAccount = [...(c.nwAccount || []), { account: name, owner, kind }];
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(c));
  return true;
}

function removeNwAccount(account) {
  const c = loadCustom();
  c.nwAccount = (c.nwAccount || []).filter((a) => a.account !== account);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(c));
}

/** Only custom accounts can be removed, and only while they hold no balances. */
function isCustomNwAccount(account) {
  return (loadCustom().nwAccount || []).some((a) => a.account === account);
}

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
      .reduce((a, b) => a + Number(b.balance || 0), 0);

  // Outstanding debts and loans are part of net worth, computed from their
  // payment history rather than needing a balance snapshot of their own.
  const dnw = debtNetWorth(state.debts || [], scopeOwner);
  const assets = (latest ? sumOf(latest, "Asset") : 0) + dnw.receivable;
  const liabs = (latest ? sumOf(latest, "Liability") : 0) + dnw.liability;
  const net = assets - liabs;
  const prevNet = prev ? sumOf(prev, "Asset") - sumOf(prev, "Liability") : null;
  const delta = prevNet === null ? null : net - prevNet;

  const accounts = nwAccounts().filter(
    (a) => !scopeOwner || a.owner === scopeOwner,
  );
  const valueAt = (d, acct) => {
    const hit = at(d).find((b) => b.account === acct);
    return hit ? Number(hit.balance || 0) : null;
  };

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

  ${
    !isRemoteStore(state.store)
      ? `<div class="nw-warn" style="border-left-color:var(--red)">
    <b>Not connected to your Ledger account.</b> Nothing on this page can be saved right now
    &mdash; reconnect under <b>Data</b> to record or view balances.
  </div>`
      : ""
  }

  ${
    !latest
      ? `<div class="empty">No balances recorded yet. Click <b>Record balances</b> to enter what each
     account is worth today &mdash; separate from your transactions, and never affects income or expense.</div>
     ${renderDebtSection(scopeOwner)}`
      : `

  <div class="nw-asat">
    <span class="nw-asat-label">Net worth as at</span>
    <span class="nw-asat-date">${esc(fmtDate(latest))}</span>
    <span class="nw-asat-note">${
      latest === dates[0] && dates.length > 1
        ? `updates automatically when you record a newer snapshot`
        : `record a newer snapshot to move this forward`
    }</span>
  </div>

  <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
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
        const v = valueAt(latest, a.account);
        const p = prev ? valueAt(prev, a.account) : null;
        const ch = v !== null && p !== null ? v - p : null;
        return `<tr class="${v === null ? "nw-blank" : ""}">
        <td>${esc(a.account)}</td>
        <td><span class="person-chip ${personColorClass(a.owner)}" data-p="${esc(a.owner)}">${esc(a.owner)}</span></td>
        <td><span class="tag">${a.kind}</span></td>
        <td class="n num">${v === null ? '<span class="muted">not recorded</span>' : money(v)}</td>
        <td class="n num ${ch === null ? "muted" : ch < 0 ? "tx-over" : "tx-income"}">${
          ch === null ? "\u2014" : (ch >= 0 ? "+" : "") + money(ch)
        }</td></tr>`;
      })
      .join("")}
  </tbody></table></div>

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

  ${renderDebtSection(scopeOwner)}

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
  }`;

  $("#nw-record").onclick = () => renderBalanceForm(latest);
  wireDebtHandlers();
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

/** Enter every account's balance for one date. Grouped, running total, carry-forward. */
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

  const groupRows = (owner) =>
    nwAccounts()
      .filter((a) => a.owner === owner)
      .map(
        (a) => `
    <tr>
      <td>${esc(a.account)}
        ${
          isCustomNwAccount(a.account)
            ? `<button class="rowbtn nw-del-acct" data-delacct="${esc(a.account)}"
               title="Remove this account">\u2715</button>`
            : ""
        }</td>
      <td><span class="tag ${a.kind === "Liability" ? "tag-liab" : ""}">${a.kind}</span></td>
      <td class="n">
        <div class="nw-input-wrap">
          <span class="nw-currency">${esc(state.tenant?.currency || "CAD")}</span>
          <input class="num nw-input" type="number" step="0.01" inputmode="decimal"
            data-account="${esc(a.account)}" data-owner="${esc(a.owner)}" data-kind="${a.kind}"
            value="${prefill(a)}" placeholder="0.00">
        </div>
      </td>
    </tr>`,
      )
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
    <div class="tablewrap"><table><thead><tr><th>Account</th><th>Kind</th><th class="n" style="width:190px">Balance (${esc(state.tenant?.currency || "CAD")})</th></tr></thead>
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
        <input id="nw-new-owner" list="nw-owner-names" placeholder="e.g. ${esc(listFor("person")[0] || "your name")}" autocomplete="off"></label>
      <datalist id="nw-owner-names">${listFor("person")
        .map((p) => `<option>${esc(p)}</option>`)
        .join("")}</datalist>
      <label class="f"><span>Kind</span>
        <select id="nw-new-kind"><option>Asset</option><option>Liability</option></select></label>
      <button class="btn" id="nw-add-acct" type="button">Add</button>
    </div>
    <p class="note" style="margin:10px 0 0">Anything with a value counts: a car, a property, an RESP,
      a loan, money owed to family. <b>Asset</b> adds to net worth, <b>Liability</b> subtracts.
      Accounts you add can be removed with the \u2715 beside their name, as long as no snapshot uses them.</p>
  </div>

  <p class="note"><b>Import file\u2026</b> loads a <code>.json</code> or <code>.csv</code> from your machine
    (columns <code>date, account, owner, kind, balance</code>). It's read in your browser, then saved to
    your Ledger account the same way as anything you enter by hand.</p>
  <p class="note">Enter liabilities as positive numbers &mdash; a $500 card balance is <code>500</code>, and it is
    subtracted from net worth automatically. Balances never affect your income, expense or budget figures.</p>`;

  const recalc = () => {
    let A = 0,
      L = 0,
      filled = 0;
    const perOwner = Object.fromEntries(nwOwners().map((o) => [o, 0]));
    view.querySelectorAll(".nw-input").forEach((i) => {
      if (i.value === "") return;
      filled++;
      const v = Math.abs(Number(i.value) || 0);
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
      (b.onclick = () => {
        const name = b.dataset.delacct;
        const used = (state.balances || []).filter((x) => x.account === name);
        if (used.length) {
          return notice(
            `"${name}" appears in ${used.length} saved snapshot${used.length > 1 ? "s" : ""}. ` +
              `Delete those snapshots first, or leave the account in place.`,
            "bad",
          );
        }
        if (!confirm(`Remove "${name}" from the account list?`)) return;
        removeNwAccount(name);
        renderBalanceForm(copyFrom);
        notice(`Removed "${name}".`, "ok");
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
      const byDate = {};
      for (const r of rows)
        (byDate[r.date] ||= []).push({
          account: r.account,
          owner: r.owner || UNASSIGNED,
          kind: r.kind === "Liability" ? "Liability" : "Asset",
          balance: Math.abs(Number(r.balance) || 0),
          notes: r.notes || "imported",
        });
      const dateList = Object.keys(byDate).sort();
      if (
        !confirm(
          `Import ${rows.length} balances across ${dateList.length} date(s)?\n\n${dateList.join(", ")}\n\nAny existing snapshot on these dates is replaced.`,
        )
      )
        return;
      if (!isRemoteStore(state.store)) {
        out.innerHTML =
          '<b class="over">Not connected to your Ledger account \u2014 reconnect before importing.</b>';
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
      if (done) {
        notice(
          `Imported ${rows.length} balances to your Ledger account.`,
          "ok",
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
    const entries = [...view.querySelectorAll(".nw-input")]
      .filter((i) => i.value !== "")
      .map((i) => ({
        account: i.dataset.account,
        owner: i.dataset.owner,
        kind: i.dataset.kind,
        balance: Math.abs(Number(i.value) || 0),
        notes: "",
      }));
    if (!entries.length) return notice("Enter at least one balance.", "bad");
    if (
      dates.includes(date) &&
      !confirm(`A snapshot for ${date} already exists. Replace it?`)
    )
      return;
    if (!isRemoteStore(state.store))
      return notice(
        "Not connected to your Ledger account \u2014 reconnect before saving.",
        "bad",
      );
    const done = await withBusy(
      `Saving ${entries.length} balances`,
      async () => {
        await state.store.setBalances(date, entries);
        state.balances = await state.store.getBalances();
      },
    );
    if (done) {
      notice(`Snapshot saved for ${date}.`, "ok");
      renderNetWorth();
    }
  };
}
