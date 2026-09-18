/* Transactions list page - search/filter, inline edit, delete. */
import { TYPES, MONTHS, UNASSIGNED } from "../store.js";
import { money, monthOf } from "../xlsxio.js";
import { listFor } from "../categories.js";
import {
  $,
  view,
  esc,
  state,
  scoped,
  personLabel,
  notice,
  withBusy,
  refresh,
} from "../core.js";
import { go } from "../router.js";

const txCollapsed = new Set();

export function renderTransactions() {
  const f = state.filter;
  let rows = scoped();
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((r) =>
      (r.description + " " + r.subcategory + " " + r.notes + " " + r.category)
        .toLowerCase()
        .includes(q),
    );
  }
  if (f.cat) rows = rows.filter((r) => r.category === f.cat);
  if (f.type) rows = rows.filter((r) => r.type === f.type);
  if (f.month) rows = rows.filter((r) => monthOf(r) === Number(f.month));

  const income = rows
    .filter((r) => r.type === "Income")
    .reduce((a, r) => a + r.amount, 0);
  const expense = rows
    .filter((r) => r.type === "Expense")
    .reduce((a, r) => a + r.amount, 0);
  const net = income - expense;
  const hasFilters = f.q || f.cat || f.month || f.type;

  // Group rows by YYYY-MM for section headers
  const groups = [];
  const seen = new Map();
  for (const r of rows) {
    const key = String(r.date).slice(0, 7); // YYYY-MM
    if (!seen.has(key)) {
      seen.set(key, groups.length);
      groups.push({ key, label: "", rows: [] });
    }
    groups[seen.get(key)].rows.push(r);
  }
  // Label each group e.g. "Jul 2026"
  for (const g of groups) {
    const [y, m] = g.key.split("-");
    g.label = (MONTHS[Number(m) - 1] || m) + " " + y;
    g.income = g.rows
      .filter((r) => r.type === "Income")
      .reduce((a, r) => a + r.amount, 0);
    g.expense = g.rows
      .filter((r) => r.type === "Expense")
      .reduce((a, r) => a + r.amount, 0);
  }

  // First time we see these groups (e.g. first load, or a filter just narrowed
  // the list to new months): collapse everything except the newest month, so
  // opening the page doesn't dump the whole year down the screen at once.
  // A month the user has explicitly toggled keeps whatever state they set.
  groups.forEach((g, i) => {
    if (!txCollapsed.has("__seen:" + g.key)) {
      txCollapsed.add("__seen:" + g.key);
      if (i > 0) txCollapsed.add(g.key);
    }
  });

  const typeIcon = (t) => (t === "Income" ? "↑" : t === "Transfer" ? "⇄" : "↓");
  const typeClass = (t) =>
    t === "Income" ? "tx-income" : t === "Transfer" ? "tx-transfer" : "";

  const txRow = (r) => `
    <div class="tx-row ${typeClass(r.type)}" data-id="${r.id}">
      <div class="tx-date num">${String(r.date).slice(8, 10)}</div>
      <div class="tx-type-icon ${typeClass(r.type)}">${typeIcon(r.type)}</div>
      <div class="tx-body">
        <div class="tx-desc">${esc(r.description) || `<span class="muted">${esc(r.category)}</span>`}
          ${r.recurring === "Yes" ? '<span class="tx-badge">Recurring</span>' : ""}
        </div>
        <div class="tx-meta">
          ${!state.person ? `<span class="person-chip" data-p="${esc(r.person || UNASSIGNED)}">${esc(r.person || UNASSIGNED)}</span>` : ""}
          <span class="tx-cat">${esc(r.category)}${r.subcategory ? " · " + esc(r.subcategory) : ""}</span>
          ${r.payment ? `<span class="tx-sep">·</span><span class="tx-pay">${esc(r.payment)}</span>` : ""}
        </div>
      </div>
      <div class="tx-amount num ${typeClass(r.type)}">${r.type === "Income" ? "+" : ""}${money(r.amount)}</div>
      <div class="tx-actions">
        <button class="txbtn edit" data-edit="${r.id}" title="Edit">✎</button>
        <button class="txbtn del" data-del="${r.id}" title="Delete">✕</button>
      </div>
    </div>`;

  const activePills = [
    f.q ? `<span class="fpill" data-clear="q">${esc(f.q)} ✕</span>` : "",
    f.cat ? `<span class="fpill" data-clear="cat">${esc(f.cat)} ✕</span>` : "",
    f.type
      ? `<span class="fpill" data-clear="type">${esc(f.type)} ✕</span>`
      : "",
    f.month
      ? `<span class="fpill" data-clear="month">${MONTHS[Number(f.month) - 1]} ✕</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  view.innerHTML = `
  <div class="head">
    <div><h1>Transactions</h1>
      <p class="sub">${esc(personLabel())} &middot; ${rows.length} of ${scoped().length} entries${hasFilters ? " · filtered" : ""}</p>
    </div>
    <div class="spacer"></div>
    <button class="btn" id="tx-add">+ Add entry</button>
  </div>

  <div class="tx-summary">
    <div class="tx-sum-item ${expense > 0 ? "" : "muted-block"}">
      <span class="tx-sum-label">Expense</span>
      <span class="tx-sum-val num">${money(expense)}</span>
    </div>
    <div class="tx-sum-item ${income > 0 ? "" : "muted-block"}">
      <span class="tx-sum-label">Income</span>
      <span class="tx-sum-val num tx-income">${money(income)}</span>
    </div>
    <div class="tx-sum-item ${net !== 0 ? "" : "muted-block"}">
      <span class="tx-sum-label">Net</span>
      <span class="tx-sum-val num ${net < 0 ? "tx-over" : "tx-income"}">${net >= 0 ? "+" : ""}${money(net)}</span>
    </div>
  </div>

  <div class="tx-filterbar">
    <div class="tx-search-wrap">
      <span class="tx-search-icon">⌕</span>
      <input id="q" class="tx-search" value="${esc(f.q)}" placeholder="Search description, category, notes…" autocomplete="off">
      ${f.q ? `<button class="tx-search-clear" id="qclear">✕</button>` : ""}
    </div>
    <div class="tx-filter-selects">
      <select id="fm">
        <option value="">All months</option>
        ${MONTHS.map((m, i) => `<option value="${i + 1}"${String(i + 1) === f.month ? " selected" : ""}>${m}</option>`).join("")}
      </select>
      <select id="fc">
        <option value="">All categories</option>
        ${listFor("category")
          .map(
            (c) =>
              `<option${c === f.cat ? " selected" : ""}>${esc(c)}</option>`,
          )
          .join("")}
      </select>
      <select id="ft">
        <option value="">All types</option>
        ${TYPES.map((t) => `<option${t === f.type ? " selected" : ""}>${esc(t)}</option>`).join("")}
      </select>
      ${hasFilters ? `<button class="btn ghost tx-reset" id="clearf">Reset</button>` : ""}
    </div>
  </div>

  ${activePills ? `<div class="tx-pills">${activePills}</div>` : ""}

  ${
    groups.length > 1
      ? `<div class="tx-collapse-all">
    <button class="tx-collapse-btn" id="tx-expand-all">Expand all</button>
    <span class="tx-sep">·</span>
    <button class="tx-collapse-btn" id="tx-collapse-all">Collapse all</button>
  </div>`
      : ""
  }

  <div class="tx-list">
    ${
      rows.length === 0
        ? `<div class="empty">${hasFilters ? "No entries match those filters." : "No transactions yet — add one with the button above."}</div>`
        : groups
            .map((g) => {
              const closed = txCollapsed.has(g.key);
              return `
          <div class="tx-group${closed ? " closed" : ""}" data-month="${g.key}">
            <button class="tx-group-header" data-toggle="${g.key}" aria-expanded="${!closed}">
              <span class="tx-group-chevron">▾</span>
              <span class="tx-group-label">${esc(g.label)}</span>
              <span class="tx-group-count muted">${g.rows.length}</span>
              <span class="tx-group-stats num">
                ${g.income > 0 ? `<span class="tx-income">+${money(g.income)}</span>` : ""}
                ${g.income > 0 && g.expense > 0 ? '<span class="tx-sep">·</span>' : ""}
                ${g.expense > 0 ? `<span>${money(g.expense)}</span>` : ""}
              </span>
            </button>
            <div class="tx-group-body">${g.rows.map(txRow).join("")}</div>
          </div>`;
            })
            .join("")
    }
  </div>`;

  // — month group collapse/expand
  view.querySelectorAll("[data-toggle]").forEach(
    (btn) =>
      (btn.onclick = () => {
        const key = btn.dataset.toggle;
        const group = btn.closest(".tx-group");
        const nowClosed = !group.classList.contains("closed");
        group.classList.toggle("closed", nowClosed);
        btn.setAttribute("aria-expanded", String(!nowClosed));
        if (nowClosed) txCollapsed.add(key);
        else txCollapsed.delete(key);
      }),
  );
  $("#tx-expand-all")?.addEventListener("click", () => {
    groups.forEach((g) => txCollapsed.delete(g.key));
    view
      .querySelectorAll(".tx-group")
      .forEach((el) => el.classList.remove("closed"));
    view
      .querySelectorAll("[data-toggle]")
      .forEach((b) => b.setAttribute("aria-expanded", "true"));
  });
  $("#tx-collapse-all")?.addEventListener("click", () => {
    groups.forEach((g) => txCollapsed.add(g.key));
    view
      .querySelectorAll(".tx-group")
      .forEach((el) => el.classList.add("closed"));
    view
      .querySelectorAll("[data-toggle]")
      .forEach((b) => b.setAttribute("aria-expanded", "false"));
  });

  // — filter events
  const refilter = () => renderTransactions();

  /* Typing must NOT re-render the search box. renderTransactions() replaces
     view.innerHTML, which destroys the <input> and rebuilds it with the caret
     at position 0 - so the next character lands at the front and the text comes
     out backwards ("coffee" -> "eeffoc"). Instead, remember the caret, re-render,
     then restore focus and caret onto the fresh input. Debounced so a 687-row
     list isn't rebuilt on every keystroke. */
  let qTimer = null;
  $("#q").oninput = (e) => {
    f.q = e.target.value;
    const caret = e.target.selectionStart;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      refilter();
      const el = $("#q");
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    }, 150);
  };
  $("#qclear")?.addEventListener("click", () => {
    f.q = "";
    refilter();
    $("#q")?.focus();
  });
  $("#fm").onchange = (e) => {
    f.month = e.target.value;
    refilter();
  };
  $("#fc").onchange = (e) => {
    f.cat = e.target.value;
    refilter();
  };
  $("#ft").onchange = (e) => {
    f.type = e.target.value;
    refilter();
  };
  $("#clearf")?.addEventListener("click", () => {
    state.filter = { q: "", cat: "", month: "", type: "" };
    refilter();
  });

  // — active filter pills
  view.querySelectorAll("[data-clear]").forEach(
    (el) =>
      (el.onclick = () => {
        state.filter[el.dataset.clear] = "";
        refilter();
      }),
  );

  // — add button shortcut
  $("#tx-add").onclick = () => {
    state.editing = null;
    go("add");
  };

  // — edit
  view.querySelectorAll("[data-edit]").forEach(
    (b) =>
      (b.onclick = () => {
        state.editing = state.rows.find((r) => r.id === Number(b.dataset.edit));
        go("add");
      }),
  );

  // — delete with inline confirm replacing browser dialog
  view.querySelectorAll("[data-del]").forEach(
    (b) =>
      (b.onclick = async () => {
        const r = state.rows.find((x) => x.id === Number(b.dataset.del));
        if (!r) return;
        const row = b.closest(".tx-row");
        // swap the row for an inline confirmation
        const orig = row.innerHTML;
        row.innerHTML = `
      <div class="tx-confirm">
        <span>Delete <b>${esc(r.category)}</b> ${money(r.amount)} on ${esc(r.date)}?</span>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button class="btn danger" style="padding:4px 12px;font-size:12px" id="cd-yes">Delete</button>
          <button class="btn ghost"  style="padding:4px 12px;font-size:12px" id="cd-no">Cancel</button>
        </div>
      </div>`;
        row.querySelector("#cd-no").onclick = () => {
          row.innerHTML = orig;
          wireActions();
        };
        row.querySelector("#cd-yes").onclick = async () => {
          row.style.opacity = ".4";
          const done = await withBusy("Deleting", async () => {
            await state.store.remove(r.id);
            await refresh();
          });
          if (done) {
            renderTransactions();
            notice("Entry deleted.", "ok");
          } else row.style.opacity = "";
        };
      }),
  );

  function wireActions() {
    view.querySelectorAll("[data-edit]").forEach(
      (b) =>
        (b.onclick = () => {
          state.editing = state.rows.find(
            (r) => r.id === Number(b.dataset.edit),
          );
          go("add");
        }),
    );
  }
}

/* ==================================================================== BUDGET */
