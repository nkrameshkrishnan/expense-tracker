import {
  CAT_NAMES,
  EXPENSE_CATS,
  CAT_TYPE,
  TYPES,
  PAYMENTS,
  ACCOUNTS,
  MONTHS,
  currentYear,
  UNASSIGNED,
  PERSON_KEY,
  CUSTOM_KEY,
  getIdToken,
  setIdToken,
  NET_WORTH_ACCOUNTS,
  personColorIndex,
  categoryColorIndex,
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
} from "./core.js";
import {
  cardHoverable,
  revealStagger,
  countUp,
  viewTransition,
  exitCollapse,
} from "./motion.js";
import {
  aggregate,
  money,
  pct,
  monthOf,
  exportWorkbook,
  importFile,
  byPersonFilter,
  personBreakdown,
  personSeries,
} from "./xlsxio.js";
import {
  loadCustom,
  addCustom,
  removeCustom,
  listFor,
  selectWithNew,
  wireNewOption,
} from "./categories.js";
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
/** Full-viewport plan picker, shown once between sign-in and the real app
    for a brand-new household's owner - same overlay mechanics as
    showGate() (boot-loading hidden, header stays hidden until a choice is
    made, so there is no flash of an unstyled/unpaid Dashboard first).
    onFree runs when "Continue with Free" is chosen; choosing a paid tier
    redirects straight to Stripe Checkout and never returns here - a
    successful or cancelled checkout both land back on the Billing tab, same
    as every other "Choose <plan>" button in this app (see renderBilling). */
function renderPlanGate(onFree) {
  const bootOverlay = $("#boot-loading");
  if (bootOverlay) bootOverlay.hidden = true;
  const gate = $("#plan-gate");
  gate.hidden = false;
  const plans = state.plans || [];
  gate.innerHTML = `
    <div class="plan-gate-card">
      <div class="plan-gate-mark">&#8214;</div>
      <div class="eyebrow">Choose your plan</div>
      <h1 class="plan-gate-title">How many people will use this ledger?</h1>
      <p class="plan-gate-sub">Pick a starting plan for this household. Nothing here is permanent — change or cancel it anytime from the Billing tab.</p>
      <div class="plan-grid">
        ${
          !state.plans
            ? `<p class="plan-gate-note">Loading plans…</p>`
            : plans.length === 0
              ? `<p class="plan-gate-note">Plans are temporarily unavailable. Try reconnecting from the banner above, then reload.</p>`
              : plans
                  .map((p) => {
                    const copy = planCopy(p.id);
                    return `
        <div class="plan-card${copy.recommended ? " recommended" : ""}">
          ${copy.recommended ? '<div class="plan-badge">Most households</div>' : ""}
          <div class="plan-name">${esc(copy.label)}</div>
          <div class="plan-price"><span class="plan-amount">${esc(formatPlanAmount(p))}</span><span class="plan-period">${esc(formatPlanPeriod(p))}</span></div>
          <div class="plan-seats">${esc(planSeatsLabel(p.seatCap))}</div>
          <p class="plan-blurb">${esc(copy.blurb)}</p>
          <ul class="plan-features">
            ${planFeatureList(p.features)
              .map((f) => `<li>${esc(f)}</li>`)
              .join("")}
          </ul>
          <button class="btn ${p.id === "free" ? "ghost" : ""} plan-cta" data-plan-id="${esc(p.id)}" data-price-id="${esc(p.priceId || "")}">
            ${p.id === "free" ? "Continue with Free" : `Choose ${esc(copy.label)}`}
          </button>
        </div>`;
                  })
                  .join("")
        }
      </div>
      <p class="plan-gate-error" id="plan-gate-error" hidden></p>
      <p class="plan-gate-note">Only the owner sets this. Anyone you invite later joins under whichever plan is active when they accept.</p>
    </div>`;

  // notice()'s #banner sits in normal document flow, behind this overlay's
  // z-index - a checkout failure reported through it would be invisible
  // while the gate is up, so errors are shown inline in the card instead.
  const errEl = $("#plan-gate-error");
  gate.querySelectorAll(".plan-cta").forEach((btn) => {
    btn.addEventListener("click", async () => {
      errEl.hidden = true;
      if (btn.dataset.planId === "free") {
        markPlanGateSeen();
        gate.hidden = true;
        onFree();
        return;
      }
      btn.disabled = true;
      try {
        const base = location.origin + location.pathname;
        const { url } = await state.store.createCheckoutSession(
          btn.dataset.priceId,
          `${base}#billing`,
          `${base}#billing`,
        );
        markPlanGateSeen();
        location.href = url;
      } catch (e) {
        btn.disabled = false;
        errEl.textContent = `Could not start checkout: ${e.message}`;
        errEl.hidden = false;
      }
    });
  });

  // First render shows "Loading plans…" above; once the fetch resolves,
  // silently re-render with the real list - but only if this gate is
  // still the thing on screen (the owner may have already picked a plan
  // and moved on by the time it resolves).
  ensurePlans(() => {
    if (!gate.hidden) renderPlanGate(onFree);
  });
}

/** Colour class for a person swatch/chip/card-fill, derived from a stable
    hash of their name (store.js's personColorIndex) rather than a lookup
    table of specific names - the same reason BUILTIN.person is empty
    above. "Unassigned"/blank is its own neutral case, not hashed into the
    palette, so it never collides with a real person's colour. */
const personColorClass = (p) =>
  p && p !== UNASSIGNED
    ? `person-color-${personColorIndex(p)}`
    : "person-color-none";

/** Colour class for a category chip, derived the same way as
    personColorClass — a stable hash of the category name, not a lookup
    table, so a new category just works without a matching edit here. */
const categoryColorClass = (cat) => `category-color-${categoryColorIndex(cat)}`;

/** Rows for whoever is currently selected. Every page reads through this. */
const scoped = () => byPersonFilter(state.rows, state.person);
const personLabel = () => state.person || "Family";

/* ================================================================= DASHBOARD */
/** Years to offer: every year actually present in the data, plus the real
    current year even if it has nothing yet (so Jan 1 of a new year isn't
    stuck picking a year with zero transactions to select from). */
function availableYears() {
  // ApiStore's cache carries allTxYears straight from the server - every
  // year that actually EXISTS in the database, independent of which years
  // have had their data fetched yet. Scanning state.rows alone would only show
  // years already loaded, which is wrong the moment a year is fetched lazily
  // rather than eagerly. DisconnectedStore has no cache and always returns
  // empty rows, so falling through to scanning state.rows for it is still
  // correct - just always empty until a real connection exists.
  const serverYears = state.store?.cache?.allTxYears;
  const fromData = new Set(
    serverYears?.length
      ? serverYears
      : state.rows
          .map((r) => Number(String(r.date).slice(0, 4)))
          .filter(Boolean),
  );
  fromData.add(currentYear());
  return [...fromData].sort((a, b) => b - a);
}

function periodSelect(value, year) {
  return `
  <label class="f"><span>Year</span><select id="y-sel">
    ${availableYears()
      .map(
        (y) =>
          `<option value="${y}"${y === year ? " selected" : ""}>${y}</option>`,
      )
      .join("")}
  </select></label>
  <label class="f"><span>Period</span><select id="m-sel">
    <option value="0"${value === 0 ? " selected" : ""}>Full year</option>
    ${MONTHS.map((m, i) => `<option value="${i + 1}"${value === i + 1 ? " selected" : ""}>${m}</option>`).join("")}
  </select></label>`;
}

/** Which structural sections would appear affects DOM shape, not just values:
    the dividends panel, the over-budget table, the person-comparison charts,
    the payment "no data" placeholder, and the unattributed note all
    appear/disappear based on data. Two renders can only safely share DOM
    (patch values, update charts in place) when ALL of these agree - anything
    else falls back to the full rebuild, which is the ONLY path that existed
    before this change and remains provably correct for every case. */
function dashboardShape(a, showCompare) {
  return {
    showCompare,
    hasDividends: a.dividends > 0,
    hasOverBudget: a.overBudget.length > 0,
    hasNoPayment: a.byPayment.length === 0,
    hasUnattributed: a.unattributed > 0,
  };
}
function sameShape(x, y) {
  return (
    !!x &&
    !!y &&
    x.showCompare === y.showCompare &&
    x.hasDividends === y.hasDividends &&
    x.hasOverBudget === y.hasOverBudget &&
    x.hasNoPayment === y.hasNoPayment &&
    x.hasUnattributed === y.hasUnattributed
  );
}

/** Cash Flow tab's own data shaping — deliberately NOT built on the shared
    aggregate() (xlsxio.js), since that function's contract (catRows keyed
    to the fixed EXPENSE_CATS list, a single income total with no
    per-category breakdown) is exactly what every other tab already
    depends on unchanged. Income-by-category has no other consumer today,
    so it's computed locally here instead of growing aggregate()'s return
    shape for one caller. */
function cashFlowData(rows, month, year) {
  const inScope = rows.filter(
    (r) =>
      Number(String(r.date).slice(0, 4)) === year &&
      (month === 0 || monthOf(r) === month),
  );
  const sumBy = (type) => {
    const byCategory = {};
    for (const r of inScope.filter((r) => r.type === type)) {
      byCategory[r.category] = (byCategory[r.category] || 0) + r.amount;
    }
    return byCategory;
  };
  const incomeByCat = sumBy("Income");
  const expenseByCat = sumBy("Expense");
  const income = Object.values(incomeByCat).reduce((a, v) => a + v, 0);
  const expense = Object.values(expenseByCat).reduce((a, v) => a + v, 0);
  const net = income - expense;

  const flows = [];
  for (const [cat, amt] of Object.entries(incomeByCat)) {
    if (amt > 0) flows.push({ from: cat, to: "Income", flow: amt });
  }
  const expenseEntries = Object.entries(expenseByCat)
    .filter(([, amt]) => amt > 0)
    .sort((a, b) => b[1] - a[1]);
  const top = expenseEntries.slice(0, 8);
  const rest = expenseEntries.slice(8);
  for (const [cat, amt] of top)
    flows.push({ from: "Income", to: cat, flow: amt });
  const otherTotal = rest.reduce((a, [, amt]) => a + amt, 0);
  // Namespaced so a real user category named "Savings" or "Other" can't
  // collide with these synthetic node labels (see cashFlowData's guard
  // below for the remaining "Income" self-loop case).
  if (otherTotal > 0)
    flows.push({ from: "Income", to: "Other expenses", flow: otherTotal });
  if (net > 0) flows.push({ from: "Income", to: "→ Savings", flow: net });

  // A user-entered category can legitimately be used for both an Income-type
  // and an Expense-type row in the same period (the Add form doesn't filter
  // the category select by type), producing both {from:X,to:"Income"} and
  // {from:"Income",to:X} - a cycle the Sankey library can't render. A
  // category literally named "Income" produces a direct self-loop. Drop any
  // flow whose from/to are identical rather than let either crash the chart.
  const dedupedFlows = flows.filter((f) => f.from !== f.to);

  return {
    income,
    expense,
    net,
    flows: dedupedFlows,
    hasData: dedupedFlows.length > 0,
  };
}

function renderCashFlow() {
  const rows = scoped();
  const cf = cashFlowData(rows, state.month, state.year);
  const label =
    state.month === 0
      ? `Full year ${state.year}`
      : `${MONTHS[state.month - 1]} ${state.year}`;

  view.innerHTML = `
  <div class="head">
    <div><h1>Cash Flow</h1><p class="sub">${esc(personLabel())} &middot; ${esc(label)}</p></div>
    <div class="spacer"></div>${periodSelect(state.month, state.year)}
  </div>

  <div class="kpis">
    ${kpi("Income", money(cf.income), "", "", "cf-income")}
    ${kpi("Expenses", money(cf.expense), "", "", "cf-expense")}
    ${kpi("Net", money(cf.net), cf.net < 0 ? "spending exceeds income" : "", cf.net < 0 ? "neg" : "pos", "cf-net")}
  </div>

  <div class="eyebrow">Flow</div>
  <div class="panel">
    ${cf.hasData ? `<div class="chartbox tall"><canvas id="c-cashflow"></canvas></div>` : `<div class="empty">No income or expenses recorded for this period yet.</div>`}
  </div>

  <div class="eyebrow">Trend</div>
  <div class="panel">
    <h3>Net by month</h3>
    <div class="chartbox"><canvas id="c-net-trend"></canvas></div>
  </div>`;

  $("#m-sel").onchange = (e) => {
    state.month = Number(e.target.value);
    renderCashFlow();
  };
  $("#y-sel").onchange = async (e) => {
    state.year = Number(e.target.value);
    localStorage.setItem(YEAR_KEY, state.year);
    state.month = 0;
    await state.store.ensureYearLoaded?.(state.year);
    state.rows = await state.store.list();
    renderCashFlow();
  };

  view.querySelectorAll(".kpi, .panel").forEach(cardHoverable);
  revealStagger(view.querySelectorAll(".kpi"));
  revealStagger(view.querySelectorAll(".panel"), { delay: 0.35 });

  if (typeof Chart === "undefined") {
    notice(
      "Charts couldn't load. Everything else on this page still works.",
      "bad",
    );
    return;
  }
  if (cf.hasData) {
    try {
      charts.cashFlow(cf.flows);
    } catch (err) {
      console.error("Cash Flow Sankey failed to render:", err);
      const flowPanel = $("#c-cashflow")?.closest(".panel");
      if (flowPanel) {
        flowPanel.innerHTML = `<div class="empty">No income or expenses recorded for this period yet.</div>`;
      }
    }
  }
  const a = aggregate(rows, state.budget, 0, state.year);
  charts.netTrendLine(a.series);
}

function renderSpending() {
  const rows = scoped();
  const a = aggregate(rows, state.budget, state.month, state.year);
  const label =
    state.month === 0
      ? `Full year ${state.year}`
      : `${MONTHS[state.month - 1]} ${state.year}`;

  const spendRows = [...a.catRows]
    .filter((r) => r.actual > 0)
    .sort((x, y) => y.actual - x.actual);
  const top6 = spendRows.slice(0, 6);
  const otherTotal = spendRows.slice(6).reduce((sum, r) => sum + r.actual, 0);
  const donutRows =
    otherTotal > 0
      ? [...top6, { category: "Other", actual: otherTotal }]
      : top6;

  // aggregate()'s catRows only tracks the built-in EXPENSE_CATS, so a
  // custom (user-created) expense category is invisible to spendRows above
  // even though Cash Flow's "Expenses" KPI counts it (it sums r.category
  // with no allowlist). Compute the true period expense total the same way
  // cashFlowData does, and fold anything catRows didn't capture into the
  // "Other" bucket so Spending's total agrees with Cash Flow's instead of
  // silently undercounting.
  const periodRows = rows.filter(
    (r) =>
      Number(String(r.date).slice(0, 4)) === state.year &&
      (state.month === 0 || monthOf(r) === state.month),
  );
  const trueExpenseTotal = periodRows
    .filter((r) => r.type === "Expense")
    .reduce((sum, r) => sum + r.amount, 0);
  const catTotal = spendRows.reduce((sum, r) => sum + r.actual, 0);
  const untracked = trueExpenseTotal - catTotal;
  if (untracked > 0) {
    const existingOther = donutRows.find((r) => r.category === "Other");
    if (existingOther) {
      existingOther.actual += untracked;
    } else {
      donutRows.push({ category: "Other", actual: untracked });
    }
  }
  const totalSpend = trueExpenseTotal;
  const topCategory = spendRows[0]?.category || "—";

  view.innerHTML = `
  <div class="head">
    <div><h1>Spending</h1><p class="sub">${esc(personLabel())} &middot; ${esc(label)}</p></div>
    <div class="spacer"></div>${periodSelect(state.month, state.year)}
  </div>

  <div class="kpis">
    ${kpi("Total spend", money(totalSpend), "", "", "sp-total")}
    ${kpi("Top category", esc(topCategory), "", "", "sp-top")}
    ${kpi("Transactions", String(a.count), "", "", "sp-count")}
  </div>

  <div class="eyebrow">By category</div>
  ${
    donutRows.length === 0
      ? `<div class="panel"><div class="empty">No spending recorded for this period yet.</div></div>`
      : `<div class="grid2">
    <div class="panel"><div class="chartbox tall"><canvas id="c-spend-donut"></canvas></div></div>
    <div class="panel"><div class="spend-list">
      ${donutRows
        .map((r, i) => {
          const pctOfTotal = totalSpend > 0 ? (r.actual / totalSpend) * 100 : 0;
          // Rank-based (position in donutRows), matching spendingDonut()'s
          // slice coloring in charts.js - keeps the list's dots/bars visually
          // matched to the donut now that the donut no longer colors by the
          // global categoryColorIndex hash.
          const colorVar =
            r.category === "Other"
              ? "var(--rule-2)"
              : `var(--cat-color-${i % 12})`;
          return `
        <div class="spend-row" data-cat="${esc(r.category)}">
          <span class="spend-dot" style="background:${colorVar}"></span>
          <div class="spend-row-main">
            <div class="spend-row-label"><span>${esc(r.category)}</span><span class="num">${money(r.actual)}</span></div>
            <div class="spend-bar"><div class="spend-bar-fill" style="width:${pctOfTotal.toFixed(1)}%;background:${colorVar}"></div></div>
          </div>
          <span class="muted num">${pctOfTotal.toFixed(0)}%</span>
        </div>`;
        })
        .join("")}
    </div></div>
  </div>`
  }

  <div class="eyebrow">Trend</div>
  <div class="panel">
    <h3>Spend by month</h3>
    <div class="chartbox"><canvas id="c-spend-trend"></canvas></div>
  </div>`;

  $("#m-sel").onchange = (e) => {
    state.month = Number(e.target.value);
    renderSpending();
  };
  $("#y-sel").onchange = async (e) => {
    state.year = Number(e.target.value);
    localStorage.setItem(YEAR_KEY, state.year);
    state.month = 0;
    await state.store.ensureYearLoaded?.(state.year);
    state.rows = await state.store.list();
    renderSpending();
  };

  wireSpendingList(donutRows);

  view.querySelectorAll(".kpi, .panel").forEach(cardHoverable);
  revealStagger(view.querySelectorAll(".kpi"));
  revealStagger(view.querySelectorAll(".panel"), { delay: 0.35 });

  if (typeof Chart === "undefined") {
    notice(
      "Charts couldn't load. Everything else on this page still works.",
      "bad",
    );
    return;
  }
  if (donutRows.length > 0) {
    charts.spendingDonut(donutRows, (category) => setActiveSpendRow(category));
  }
  const fullYear = aggregate(rows, state.budget, 0, state.year);
  charts.spendTrend(fullYear.series);
}

/** Two-way donut<->list highlight, both directions funnel through this one
    function so there's a single source of truth for "which category is
    active" instead of two independent code paths that could drift apart. */
function setActiveSpendRow(category) {
  view.querySelectorAll(".spend-row").forEach((el) => {
    el.classList.toggle("active", el.dataset.cat === category);
  });
  const rows = Array.from(view.querySelectorAll(".spend-row"));
  const idx = rows.findIndex((el) => el.dataset.cat === category);
  charts.highlightSlice(idx === -1 ? null : idx);
}

function wireSpendingList(donutRows) {
  view.querySelectorAll(".spend-row").forEach((el) => {
    el.onclick = () => setActiveSpendRow(el.dataset.cat);
    el.onmouseenter = () => {
      if (!el.classList.contains("active")) {
        const idx = donutRows.findIndex((r) => r.category === el.dataset.cat);
        charts.highlightSlice(idx === -1 ? null : idx);
      }
    };
    el.onmouseleave = () => {
      const activeEl = view.querySelector(".spend-row.active");
      const idx = activeEl
        ? donutRows.findIndex((r) => r.category === activeEl.dataset.cat)
        : -1;
      charts.highlightSlice(idx === -1 ? null : idx);
    };
  });
}

function renderDashboard() {
  const a = aggregate(scoped(), state.budget, state.month, state.year);
  const label =
    state.month === 0
      ? `Full year ${state.year}`
      : `${MONTHS[state.month - 1]} ${state.year}`;
  // Comparison is always computed across everyone, so it stays meaningful
  // even while the rest of the page is filtered to one person.
  const people = personBreakdown(state.rows, state.month, state.year);
  const pSeries = personSeries(state.rows, state.year);
  const showCompare = people.length > 1;
  const shape = dashboardShape(a, showCompare);

  // Fast path only when the LAST thing rendered into #view was a dashboard
  // shell of this exact shape. Anything else (arriving from a different tab,
  // or the shape changing) takes the full rebuild - which is the original,
  // unmodified code path and stays the default whenever there is any doubt.
  const canPatch =
    view.dataset.shell === "dashboard" && sameShape(shape, state._dashShape);
  if (canPatch) updateDashboardValues(a, label, people, pSeries, showCompare);
  else buildDashboardShell(a, label, people, pSeries, showCompare, shape);
  state._dashShape = shape;

  wireDashboard(showCompare);

  if (typeof Chart === "undefined") {
    notice(
      "Charts couldn't load. Everything else on this page still works.",
      "bad",
    );
    return;
  }
  if (showCompare) {
    charts.personSplit(people);
    charts.personByMonth(pSeries, MONTHS);
  }
  charts.incomeVsExpense(a.series);
  charts.netByMonth(a.series);
  charts.trend(a.series);
  charts.paymentSplit(a.byPayment);
  charts.actualVsBudget(a.catRows);
  charts.topFive(a.top5);
  if (a.dividends > 0) charts.dividendsTrend(a.series);
}

/** Selector/click wiring. Reassigning .onchange/.onclick is idempotent, so
    this runs after EITHER path without needing to know which one ran. */
function wireDashboard(showCompare) {
  $("#m-sel").onchange = (e) => {
    state.month = Number(e.target.value);
    renderDashboard();
  };
  $("#y-sel").onchange = async (e) => {
    state.year = Number(e.target.value);
    localStorage.setItem(YEAR_KEY, state.year);
    state.month = 0; // switching years resets to "full year" - a specific
    // month carried over from a different year is confusing
    // Normally a no-op: the background full-history load kicked off at boot
    // has almost always already finished by the time anyone reaches for the
    // year selector. Only genuinely fetches if that year truly is not in
    // memory yet - switching years faster than the background load can win.
    await state.store.ensureYearLoaded?.(state.year);
    state.rows = await state.store.list();
    // Budget is per-year on the sheet, so changing year needs a fresh fetch,
    // not just a re-render of already-cached data.
    state.budget = await state.store.getBudget(state.year);
    renderDashboard();
  };
  view.querySelectorAll("[data-jump]").forEach(
    (el) =>
      (el.onclick = () => {
        const p = el.dataset.jump;
        state.person = state.person === p ? "" : p;
        localStorage.setItem(PERSON_KEY, state.person);
        go("dashboard");
      }),
  );
}

/** The full rebuild - identical markup/logic to the original renderDashboard,
    now with stable ids on every value the fast path needs to patch later. */
function buildDashboardShell(a, label, people, pSeries, showCompare) {
  view.innerHTML = `
  <div class="head">
    <div><h1>Dashboard</h1><p class="sub" id="dash-sub">${esc(personLabel())} &middot; ${esc(label)} &middot; ${a.count} transactions</p></div>
    <div class="spacer"></div>${periodSelect(state.month, state.year)}
  </div>

  <div class="kpis">
    ${kpi("Income", money(a.income), a.income === 0 ? "no income recorded" : "", "", "income")}
    ${kpi("Expense", money(a.expense), `${a.count} entries`, "", "expense")}
    ${kpi("Net", money(a.net), a.net < 0 ? "spending exceeds income" : "", a.net < 0 ? "neg" : "pos", "net")}
    ${kpi("Savings rate", a.income > 0 ? pct(a.savingsRate) : "\u2014", a.income > 0 ? "" : "needs income data", "", "savings")}
    ${kpi(
      "Budget used",
      a.expenseBudget > 0 ? pct(a.budgetUsed) : "\u2014",
      a.expenseBudget > 0
        ? state.person
          ? `of ${money(a.expenseBudget)} household`
          : `of ${money(a.expenseBudget)}`
        : "no budget set",
      a.budgetUsed > 1 ? "neg" : "",
      "budgetused",
    )}
    ${kpi("Avg / day", money(a.avgDaily), state.month === 0 ? `over ${state.year % 4 === 0 && (state.year % 100 !== 0 || state.year % 400 === 0) ? 366 : 365} days` : `over ${new Date(state.year, state.month, 0).getDate()} days`, "", "avgday")}
  </div>

  ${
    a.dividends > 0
      ? `
  <div class="eyebrow">Dividends &mdash; <span id="dash-div-label">${label}</span></div>
  <div class="div-panel">
    <div class="div-kpi">
      <span class="div-kpi-label">Total this period</span>
      <span class="div-kpi-val num" id="dash-div-total">${money(a.dividends)}</span>
      <span class="div-kpi-note">Tracked separately &mdash; not counted as Income, not counted as spending.</span>
    </div>
    <div class="div-chart"><canvas id="c-dividends"></canvas></div>
  </div>`
      : ""
  }

  ${
    a.overBudget.length
      ? `<div class="eyebrow">Over budget &mdash; <span id="dash-ob-label">${label}</span></div>
  <div class="tablewrap"><table><thead><tr><th>Category</th><th class="n">Actual</th><th class="n">Budget</th><th class="n">Over by</th><th class="n">Used</th></tr></thead><tbody id="overbudget-tbody">
    ${overBudgetRows(a)}
  </tbody></table></div>`
      : ""
  }

  ${
    showCompare
      ? `
  <div class="eyebrow">Who spent what &mdash; <span id="dash-who-label">${esc(label)}</span></div>
  <div class="person-cards" id="person-cards">
    ${personCards(people)}
  </div>`
      : ""
  }

  <div class="eyebrow">Charts</div>
  <div class="grid2">
    ${
      showCompare
        ? `
    <div class="panel"><h3>Spend split by person &mdash; <span id="dash-split-label">${esc(label)}</span></h3><div class="chartbox"><canvas id="c-person-split"></canvas></div></div>
    <div class="panel"><h3>Monthly spend by person</h3><div class="chartbox"><canvas id="c-person-month"></canvas></div></div>`
        : ""
    }
    <div class="panel"><h3>Income vs expense by month</h3><div class="chartbox"><canvas id="c-ie"></canvas></div></div>
    <div class="panel"><h3>Net savings by month</h3><div class="chartbox"><canvas id="c-net"></canvas></div></div>
    <div class="panel"><h3>Expense vs budget ceiling</h3><div class="chartbox"><canvas id="c-trend"></canvas></div></div>
    <div class="panel"><h3>Payment method split &mdash; <span id="dash-pay-label">${esc(label)}</span></h3><div class="chartbox"><canvas id="c-pay"></canvas>
      ${a.byPayment.length === 0 ? `<p class="note" style="position:absolute;inset:0;display:grid;place-content:center;text-align:center">No payment methods recorded.<br>Fill the Payment field when adding entries.</p>` : ""}</div>
      ${a.unattributed > 0 ? `<p class="note" id="dash-unattr-note">${money(a.unattributed)} has no payment method set, so it is excluded here.</p>` : ""}</div>
    <div class="panel"><h3>Actual vs budget by category &mdash; <span id="dash-cat-label">${esc(label)}</span></h3><div class="chartbox tall"><canvas id="c-cat"></canvas></div></div>
    <div class="panel"><h3>Top 5 spend categories &mdash; <span id="dash-top-label">${esc(label)}</span></h3><div class="chartbox tall"><canvas id="c-top"></canvas></div></div>
  </div>

  <div class="eyebrow">Category detail &mdash; <span id="dash-catdetail-label">${esc(label)}</span></div>
  <div class="tablewrap"><table><thead><tr><th>Category</th><th class="n">Actual</th><th class="n">Budget</th><th class="n">Variance</th><th class="n">Used</th></tr></thead><tbody id="catdetail-tbody">
    ${catDetailRows(a)}
  </tbody></table></div>`;
  view.dataset.shell = "dashboard";

  view.querySelectorAll(".kpi, .panel").forEach(cardHoverable);
  const kpiEls = view.querySelectorAll(".kpi");
  const panelEls = view.querySelectorAll(".panel");
  revealStagger(kpiEls);
  const kpiFinish = 0.35 + Math.max(0, kpiEls.length - 1) * 0.04; // duration + stagger tail, matches revealStagger's defaults
  revealStagger(panelEls, { delay: kpiFinish });
  state._dashLastAgg = a;
}

/** Fast path: same shape as last render, so every section that exists now
    existed before too. Patch text/tables/charts in place - no innerHTML
    rebuild, no canvas recreation, no visual flash. */
function updateDashboardValues(a, label, people, pSeries, showCompare) {
  const sub = $("#dash-sub");
  if (sub)
    sub.textContent = `${personLabel()} \u00b7 ${label} \u00b7 ${a.count} transactions`;

  const prev = state._dashLastAgg;

  const setKpiMeta = (key, m) => {
    const mEl = $(`#kpi-${key}-m`);
    if (mEl) mEl.textContent = m;
  };
  const setKpiNumber = (key, from, to, fmt) => {
    const vEl = $(`#kpi-${key}-v`);
    if (!vEl) return;
    if (from === undefined || from === null) {
      vEl.textContent = fmt(to);
      return;
    }
    countUp(vEl, from, to, fmt);
  };
  const setKpiText = (key, text) => {
    const vEl = $(`#kpi-${key}-v`);
    if (vEl) vEl.textContent = text;
  };

  setKpiNumber("income", prev?.income, a.income, money);
  setKpiMeta("income", a.income === 0 ? "no income recorded" : "");

  setKpiNumber("expense", prev?.expense, a.expense, money);
  setKpiMeta("expense", `${a.count} entries`);

  const netEl = $("#kpi-net");
  if (netEl)
    netEl.className = `kpi card-hoverable ${a.net < 0 ? "neg" : "pos"}`;
  setKpiNumber("net", prev?.net, a.net, money);
  setKpiMeta("net", a.net < 0 ? "spending exceeds income" : "");

  if (a.income > 0 && prev?.income > 0) {
    setKpiNumber("savings", prev.savingsRate, a.savingsRate, pct);
  } else {
    setKpiText("savings", a.income > 0 ? pct(a.savingsRate) : "\u2014");
  }
  setKpiMeta("savings", a.income > 0 ? "" : "needs income data");

  const budEl = $("#kpi-budgetused");
  if (budEl)
    budEl.className = `kpi card-hoverable ${a.budgetUsed > 1 ? "neg" : ""}`;
  if (a.expenseBudget > 0 && prev?.expenseBudget > 0) {
    setKpiNumber("budgetused", prev.budgetUsed, a.budgetUsed, pct);
  } else {
    setKpiText(
      "budgetused",
      a.expenseBudget > 0 ? pct(a.budgetUsed) : "\u2014",
    );
  }
  setKpiMeta(
    "budgetused",
    a.expenseBudget > 0
      ? state.person
        ? `of ${money(a.expenseBudget)} household`
        : `of ${money(a.expenseBudget)}`
      : "no budget set",
  );

  setKpiNumber("avgday", prev?.avgDaily, a.avgDaily, money);
  setKpiMeta(
    "avgday",
    state.month === 0
      ? `over ${state.year % 4 === 0 && (state.year % 100 !== 0 || state.year % 400 === 0) ? 366 : 365} days`
      : `over ${new Date(state.year, state.month, 0).getDate()} days`,
  );

  state._dashLastAgg = a;

  if (a.dividends > 0) {
    const t = $("#dash-div-total");
    if (t) t.textContent = money(a.dividends);
    const l = $("#dash-div-label");
    if (l) l.textContent = label;
  }
  if (a.overBudget.length) {
    const tb = $("#overbudget-tbody");
    if (tb) tb.innerHTML = overBudgetRows(a);
    const l = $("#dash-ob-label");
    if (l) l.textContent = label;
  }
  if (showCompare) {
    const pc = $("#person-cards");
    if (pc) pc.innerHTML = personCards(people);
    const l = $("#dash-who-label");
    if (l) l.textContent = esc(label);
    const l2 = $("#dash-split-label");
    if (l2) l2.textContent = esc(label);
  }
  if (a.unattributed > 0) {
    const n = $("#dash-unattr-note");
    if (n)
      n.textContent = `${money(a.unattributed)} has no payment method set, so it is excluded here.`;
  }
  [
    "dash-pay-label",
    "dash-cat-label",
    "dash-top-label",
    "dash-catdetail-label",
  ].forEach((id) => {
    const el = $("#" + id);
    if (el) el.textContent = esc(label);
  });
  const catTb = $("#catdetail-tbody");
  if (catTb) catTb.innerHTML = catDetailRows(a);
}

function overBudgetRows(a) {
  return a.overBudget
    .map(
      (r) =>
        `<tr><td>${esc(r.category)}</td><td class="n num">${money(r.actual)}</td><td class="n num">${money(r.budget)}</td><td class="n num over">${money(-r.variance)}</td><td class="n num over">${pct(r.used)}</td></tr>`,
    )
    .join("");
}
function personCards(people) {
  return people
    .map(
      (b) => `
      <div class="person-card${state.person === (b.person === UNASSIGNED ? UNASSIGNED : b.person) ? " on" : ""}" data-jump="${esc(b.person)}">
        <div class="person-card-head">
          <span class="person-swatch ${personColorClass(b.person)}" data-p="${esc(b.person)}"></span>
          <span class="person-card-name">${esc(b.person)}</span>
        </div>
        <div class="person-card-val num">${money(b.expense)}</div>
        <div class="person-card-bar"><div class="person-card-fill ${personColorClass(b.person)}" data-p="${esc(b.person)}" style="width:${(b.share * 100).toFixed(1)}%"></div></div>
        <div class="person-card-meta">
          <span class="muted">${pct(b.share)} of spend</span>
          ${b.income > 0 ? `<span class="tx-income num">+${money(b.income)}</span>` : `<span class="muted num">${b.count} entries</span>`}
        </div>
      </div>`,
    )
    .join("");
}
function catDetailRows(a) {
  return (
    a.catRows
      .filter((r) => r.actual > 0 || r.budget > 0)
      .map(
        (r) => `<tr>
      <td>${esc(r.category)}</td><td class="n num">${money(r.actual)}</td><td class="n num">${money(r.budget)}</td>
      <td class="n num ${r.variance < 0 ? "over" : "under"}">${money(r.variance)}</td>
      <td class="n num ${r.used > 1 ? "over" : ""}">${r.budget > 0 ? pct(r.used) : "\u2014"}</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="5" class="muted">Nothing recorded yet.</td></tr>'
  );
}

const kpi = (k, v, m = "", cls = "", key = "") =>
  `<div class="kpi ${cls}"${key ? ` id="kpi-${key}"` : ""}><div class="k">${k}</div><div class="v"${key ? ` id="kpi-${key}-v"` : ""}>${v}</div><div class="m"${key ? ` id="kpi-${key}-m"` : ""}>${esc(m)}</div></div>`;

/* ======================================================================= ADD */
function renderAdd() {
  const e = state.editing;
  const today = new Date().toISOString().slice(0, 10);
  const selType = e?.type || "Expense";
  const selCat = e?.category || "Groceries";
  // Default to whoever is selected in the header, so a run of one person's
  // receipts does not need the field touched on every entry. No fallback
  // to a specific name - that name is not known in advance. Excludes
  // UNASSIGNED specifically: that's a header FILTER meaning "show only
  // unassigned rows", not a real person to default a new entry's person
  // to - a new entry should start blank, same as if nothing were selected.
  const selPerson =
    e?.person || (state.person !== UNASSIGNED ? state.person : "") || "";

  const curMonth = new Date().getMonth() + 1;
  const ctxActual = scoped()
    // Expense only - a transfer into this category is not spending against budget
    .filter(
      (r) =>
        r.type === "Expense" &&
        r.category === selCat &&
        monthOf(r) === curMonth &&
        Number(String(r.date).slice(0, 4)) === currentYear(),
    )
    .reduce((a, r) => a + r.amount, 0);
  const ctxBudget = Number(state.budget[selCat]?.[curMonth]) || 0;
  const ctxOver = ctxBudget > 0 && ctxActual > ctxBudget;
  const recent = scoped()
    .filter((r) => r.category === selCat)
    .slice(0, 5);
  const allSubs = [
    ...new Set(state.rows.map((r) => r.subcategory).filter(Boolean)),
  ];

  const opt = (list, sel, blank) =>
    (blank ? `<option value=""></option>` : "") +
    list
      .map((o) => `<option${o === sel ? " selected" : ""}>${esc(o)}</option>`)
      .join("");

  const dayName = (d) => {
    try {
      return new Date(d + "T12:00:00").toLocaleDateString("en-CA", {
        weekday: "long",
      });
    } catch {
      return "";
    }
  };

  view.innerHTML = `
  <div class="head">
    <div>
      <h1>${e ? "Edit entry" : "Add entry"}</h1>
      <p class="sub">${e ? `Editing #${e.id} \u2014 ${esc(e.category)} ${money(e.amount)}` : "Amount is always positive \u2014 Type carries the sign."}</p>
    </div>
    ${e ? `<div class="spacer"></div><button class="btn ghost" id="cancel">\u2190 Back</button>` : ""}
  </div>

  <div class="add-layout">
    <div class="add-main">

      <div class="add-type-row">
        ${TYPES.map((t) => `<button type="button" class="add-type-btn${t === selType ? " on" : ""}" data-type="${t}">${t}</button>`).join("")}
      </div>

      <div class="add-person-row">
        <span class="add-label" style="margin-right:4px">Whose</span>
        ${listFor("person")
          .map(
            (pp) =>
              `<button type="button" class="add-person-btn${pp === selPerson ? " on" : ""}" data-person="${esc(pp)}"><span class="person-swatch ${personColorClass(pp)}" data-p="${esc(pp)}"></span>${esc(pp)}</button>`,
          )
          .join("")}
        <button type="button" class="add-person-btn" id="add-person-new">+ New</button>
      </div>

      <form id="f" autocomplete="off">
        <input type="hidden" name="type" id="type-hidden" value="${selType}">
        <input type="hidden" name="person" id="person-hidden" value="${esc(selPerson)}">

        <div class="add-amount-wrap">
          <span class="add-currency">${esc(state.tenant?.currency || "CAD")}</span>
          <input class="add-amount num" type="number" name="amount" step="0.01" min="0.01"
            value="${e?.amount ?? ""}" placeholder="0.00" inputmode="decimal"
            autocomplete="off" id="amount-input">
          <span class="add-currency-code">${esc(state.tenant?.currency || "CAD")}</span>
        </div>
        <div class="err" id="err"></div>

        <div class="add-primary">
          <div class="add-field">
            <label for="f-date" class="add-label">Date</label>
            <input id="f-date" type="date" name="date" value="${esc(e?.date || today)}" required>
            <span class="add-field-hint muted" id="day-name">${dayName(e?.date || today)}</span>
          </div>
          <div class="add-field">
            <label for="f-cat" class="add-label">Category</label>
            ${selectWithNew("f-cat", "category", selCat)}
            <span class="add-field-hint ${ctxOver ? "over" : "muted"}" id="cat-hint">
              ${
                ctxBudget > 0
                  ? `${MONTHS[curMonth - 1]}: ${money(ctxActual)} of ${money(ctxBudget)}${ctxOver ? " \u2014 over" : ""}`
                  : ctxActual > 0
                    ? `${MONTHS[curMonth - 1]}: ${money(ctxActual)} spent`
                    : "no budget set"
              }
            </span>
          </div>
        </div>

        <div class="add-field add-field-full">
          <label for="f-desc" class="add-label">Description</label>
          <input id="f-desc" name="description" value="${esc(e?.description || "")}"
            placeholder="What was it?" list="subs-dl">
          <datalist id="subs-dl">
            ${[
              ...new Set(
                state.rows
                  .filter((r) => r.category === selCat)
                  .map((r) => r.description)
                  .filter(Boolean),
              ),
            ]
              .map((s) => `<option>${esc(s)}</option>`)
              .join("")}
          </datalist>
        </div>

        <details class="add-details" ${e && (e.subcategory || e.payment || e.account || e.notes) ? "open" : ""}>
          <summary class="add-details-toggle">More details <span class="muted">(subcategory, payment, account, notes)</span></summary>
          <div class="add-secondary">
            <div class="add-field">
              <label for="f-sub" class="add-label">Subcategory</label>
              ${selectWithNew("f-sub", "subcategory", e?.subcategory || "", { blank: true, forCategory: selCat })}
              <span class="add-field-hint muted" id="sub-hint">options for ${esc(selCat)}</span>
            </div>
            <div class="add-field">
              <label for="f-pay" class="add-label">Payment method</label>
              ${selectWithNew("f-pay", "payment", e?.payment || "", { blank: true })}
            </div>
            <div class="add-field">
              <label for="f-acc" class="add-label">Account</label>
              ${selectWithNew("f-acc", "account", e?.account || "", { blank: true })}
            </div>
            <div class="add-field">
              <label for="f-rec" class="add-label">Recurring?</label>
              <select id="f-rec" name="recurring">${opt(["No", "Yes"], e?.recurring || "No")}</select>
            </div>
            <div class="add-field add-field-wide">
              <label for="f-notes" class="add-label">Notes</label>
              <input id="f-notes" name="notes" value="${esc(e?.notes || "")}" placeholder="Anything else\u2026">
            </div>
          </div>
        </details>

        <div class="add-submit-row">
          <button class="btn add-submit" type="submit" id="sub-btn">${e ? "Save changes" : "Add entry"}</button>
          ${
            e
              ? `<button class="btn ghost" type="button" id="cancel2">Cancel</button>`
              : `<button class="btn ghost" type="reset">Clear</button>`
          }
          <span class="add-hint num muted" id="hint"></span>
        </div>
      </form>
    </div>

    <div class="add-context" id="ctx-panel">
      <div class="add-ctx-section">
        <div class="add-ctx-head" id="ctx-cat-name">${esc(selCat)}</div>
        <div class="add-ctx-stats" id="ctx-stats">
          ${
            ctxBudget > 0
              ? `
            <div class="add-ctx-bar-wrap">
              <div class="add-ctx-bar-track">
                <div class="add-ctx-bar-fill ${ctxOver ? "over" : ""}"
                  style="width:${Math.min((ctxActual / ctxBudget) * 100, 100).toFixed(1)}%"></div>
              </div>
            </div>
            <div class="add-ctx-row"><span class="muted">Spent ${MONTHS[curMonth - 1]}</span><span class="num ${ctxOver ? "over" : ""}">${money(ctxActual)}</span></div>
            <div class="add-ctx-row"><span class="muted">Budget</span><span class="num">${money(ctxBudget)}</span></div>
            <div class="add-ctx-row"><span class="muted">Remaining</span><span class="num ${ctxOver ? "over" : "tx-income"}">${money(ctxBudget - ctxActual)}</span></div>`
              : `<p class="muted" style="font-size:12px;margin:0">No budget set. <a href="#budget" id="go-budget" style="color:var(--ink)">Set one \u2192</a></p>`
          }
        </div>
      </div>
      ${
        recent.length
          ? `
      <div class="add-ctx-section">
        <div class="add-ctx-subhead">Recent in this category</div>
        ${recent
          .map(
            (r) => `
          <div class="add-recent-row">
            <div class="add-recent-body">
              <span class="add-recent-desc">${esc(r.description || r.subcategory || "\u2014")}</span>
              <span class="add-recent-date num muted">${esc(r.date)}</span>
            </div>
            <span class="add-recent-amt num">${money(r.amount)}</span>
          </div>`,
          )
          .join("")}
      </div>`
          : ""
      }
    </div>
  </div>`;

  // selectWithNew() builds plain selects; FormData needs name attributes.
  [
    ["f-cat", "category"],
    ["f-sub", "subcategory"],
    ["f-pay", "payment"],
    ["f-acc", "account"],
  ].forEach(([id, name]) => {
    const el = $("#" + id);
    if (el) el.name = name;
  });

  wireNewOption("f-sub", "subcategory");
  wireNewOption("f-pay", "payment");
  wireNewOption("f-acc", "account");

  view.querySelectorAll(".add-type-btn").forEach((btn) => {
    btn.onclick = () => {
      view
        .querySelectorAll(".add-type-btn")
        .forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      $("#type-hidden").value = btn.dataset.type;
    };
  });

  const selectPerson = (name) => {
    view
      .querySelectorAll(".add-person-btn[data-person]")
      .forEach((b) => b.classList.toggle("on", b.dataset.person === name));
    $("#person-hidden").value = name;
  };
  view.querySelectorAll(".add-person-btn[data-person]").forEach((btn) => {
    btn.onclick = () => selectPerson(btn.dataset.person);
  });

  // "+ New" - same inline-add pattern as selectWithNew()'s .newopt, but
  // this picker is a row of buttons rather than a <select>, so it gets its
  // own small handler instead of reusing wireNewOption() directly.
  $("#add-person-new").onclick = () => {
    const addBtn = $("#add-person-new");
    const wrap = document.createElement("span");
    wrap.className = "newopt";
    wrap.innerHTML = `<input class="newopt-input" placeholder="New person…" autocomplete="off">
      <button type="button" class="newopt-ok">Add</button>
      <button type="button" class="newopt-cancel">✕</button>`;
    addBtn.style.display = "none";
    addBtn.after(wrap);
    const input = wrap.querySelector(".newopt-input");
    input.focus();
    const close = (value) => {
      wrap.remove();
      addBtn.style.display = "";
      if (!value) return;
      addCustom("person", value);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "add-person-btn";
      b.dataset.person = value;
      b.innerHTML = `<span class="person-swatch ${personColorClass(value)}" data-p="${esc(value)}"></span>${esc(value)}`;
      b.onclick = () => selectPerson(value);
      addBtn.before(b);
      selectPerson(value);
    };
    wrap.querySelector(".newopt-ok").onclick = () => close(input.value.trim());
    wrap.querySelector(".newopt-cancel").onclick = () => close(null);
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        close(input.value.trim());
      }
      if (ev.key === "Escape") close(null);
    };
  };

  $("#f-date").oninput = (ev) => {
    $("#day-name").textContent = dayName(ev.target.value);
  };

  wireNewOption("f-cat", "category", () => refreshSubOptions());

  /* Subcategories are scoped to the chosen category, so switching category has
     to rebuild that list. Keeps the current value if it still applies. */
  function refreshSubOptions() {
    const cat = $("#f-cat").value;
    const sub = $("#f-sub");
    if (!sub || cat === "__new__") return;
    const keep = sub.value;
    const opts = listFor("subcategory", cat);
    sub.innerHTML =
      '<option value=""></option>' +
      opts
        .map(
          (o) => `<option${o === keep ? " selected" : ""}>${esc(o)}</option>`,
        )
        .join("") +
      (keep && !opts.includes(keep)
        ? `<option selected>${esc(keep)}</option>`
        : "") +
      '<option value="__new__">+ New\u2026</option>';
    sub.name = "subcategory";
    sub.dataset.prev = sub.value;
    wireNewOption("f-sub", "subcategory");
    const hint = $("#sub-hint");
    if (hint)
      hint.textContent = opts.length
        ? `${opts.length} option${opts.length > 1 ? "s" : ""} for ${cat}`
        : `no subcategories yet for ${cat}`;
  }

  $("#f-cat").addEventListener("change", () => {
    const cat = $("#f-cat").value;
    if (cat === "__new__") return;
    const act = scoped()
      .filter(
        (r) =>
          r.type === "Expense" &&
          r.category === cat &&
          monthOf(r) === curMonth &&
          Number(String(r.date).slice(0, 4)) === currentYear(),
      )
      .reduce((a, r) => a + r.amount, 0);
    const bud = Number(state.budget[cat]?.[curMonth]) || 0;
    const over = bud > 0 && act > bud;
    const hint = $("#cat-hint");
    if (hint) {
      hint.textContent =
        bud > 0
          ? `${MONTHS[curMonth - 1]}: ${money(act)} of ${money(bud)}${over ? " — over" : ""}`
          : act > 0
            ? `${MONTHS[curMonth - 1]}: ${money(act)} spent`
            : "no budget set";
      hint.className = `add-field-hint ${over ? "over" : "muted"}`;
    }
    refreshSubOptions();
    const head = $("#ctx-cat-name");
    if (head) head.textContent = cat;
    const stats = $("#ctx-stats");
    if (stats) {
      if (bud > 0) {
        stats.innerHTML = `<div class="add-ctx-bar-wrap"><div class="add-ctx-bar-track"><div class="add-ctx-bar-fill ${over ? "over" : ""}" style="width:${Math.min((act / bud) * 100, 100).toFixed(1)}%"></div></div></div>
          <div class="add-ctx-row"><span class="muted">Spent ${MONTHS[curMonth - 1]}</span><span class="num ${over ? "over" : ""}">${money(act)}</span></div>
          <div class="add-ctx-row"><span class="muted">Budget</span><span class="num">${money(bud)}</span></div>
          <div class="add-ctx-row"><span class="muted">Remaining</span><span class="num ${over ? "over" : "tx-income"}">${money(bud - act)}</span></div>`;
      } else {
        stats.innerHTML = `<p class="muted" style="font-size:12px;margin:0">No budget set. <a href="#budget" id="go-budget" style="color:var(--ink)">Set one \u2192</a></p>`;
        $("#go-budget")?.addEventListener("click", (ev) => {
          ev.preventDefault();
          go("budget");
        });
      }
    }
  });

  refreshSubOptions();

  $("#cancel")?.addEventListener("click", () => {
    state.editing = null;
    go("transactions");
  });
  $("#cancel2")?.addEventListener("click", () => {
    state.editing = null;
    go("transactions");
  });
  $("#go-budget")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    go("budget");
  });

  setTimeout(() => {
    $("#amount-input")?.focus();
  }, 50);

  $("#f").onsubmit = async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(ev.target));
    const amount = Number(d.amount);
    const errEl = $("#err");
    errEl.textContent = "";

    if (!d.date) {
      errEl.textContent = "Pick a date.";
      return;
    }
    if (!(amount > 0)) {
      errEl.textContent = "Amount must be greater than zero.";
      $("#amount-input").focus();
      return;
    }

    // Every year works correctly now - this is purely an FYI, not a warning,
    // for the one case where it might be surprising: adding a date that
    // falls under a DIFFERENT year than whatever the Dashboard currently has
    // selected means it will not show up on THIS screen without switching
    // the year selector - which was never a bug, that is what "per year"
    // scoping means, but worth a nudge rather than a silent surprise.
    const entryYear = Number(d.date.slice(0, 4));
    const yearNote =
      entryYear !== state.year
        ? ` Switch the year selector to ${entryYear} to see it on the Dashboard.`
        : "";

    const btn = $("#sub-btn");
    btn.disabled = true;

    if (state.editing) {
      const done = await withBusy("Updating", async () => {
        await state.store.update(state.editing.id, { ...d, amount });
        state.editing = null;
        await refresh();
      });
      btn.disabled = false;
      if (done) {
        notice("Entry updated." + yearNote, "ok");
        go("transactions");
      }
    } else {
      const done = await withBusy("Saving", async () => {
        await state.store.add({ ...d, amount });
        await refresh();
      });
      btn.disabled = false;
      if (done) {
        notice(`${money(amount)} saved.` + yearNote, "ok");
        $("#hint").textContent = `${state.rows.length} total`;
        ev.target.reset();
        $("#type-hidden").value = d.type;
        $("#person-hidden").value = d.person;
        view
          .querySelectorAll(".add-type-btn")
          .forEach((b) => b.classList.toggle("on", b.dataset.type === d.type));
        view
          .querySelectorAll(".add-person-btn[data-person]")
          .forEach((b) =>
            b.classList.toggle("on", b.dataset.person === d.person),
          );
        $("#f-date").value = d.date;
        $("#f-cat").value = d.category;
        setTimeout(() => {
          $("#amount-input").focus();
        }, 50);
      }
    }
  };
}

/* ============================================================== TRANSACTIONS */
// Persists across re-renders (filtering, editing, deleting) so collapsing a
// month doesn't spring back open every time the list redraws.
const txCollapsed = new Set();
/* Tracks which month groups have already played their entrance
   animation (row stagger + header subtotal count-up), by group key.
   renderTransactions() fully replaces view.innerHTML on every call (no
   patch path here, unlike Dashboard's canPatch), so DOM node identity
   can't tell "already animated" from "newly revealed" — this Set is the
   substitute. Same lifetime as txCollapsed: never explicitly cleared,
   lives for as long as the page does. */
const txRevealed = new Set();
/* Snapshot of the filter state as of the last renderTransactions() call,
   used to tell "a filter pill that's newly active" (animate in) from "a
   pill that was already showing" (leave alone) across a full-rebuild
   re-render triggered by typing in the search box. */
let txPrevFilter = { q: "", cat: "", type: "", month: "" };

function renderTransactions() {
  const f = state.filter;
  const prevFilter = txPrevFilter;
  txPrevFilter = { q: f.q, cat: f.cat, type: f.type, month: f.month };
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
          ${!state.person ? `<span class="person-chip ${personColorClass(r.person || UNASSIGNED)}" data-p="${esc(r.person || UNASSIGNED)}">${esc(r.person || UNASSIGNED)}</span>` : ""}
          <span class="tx-cat"><span class="category-chip ${categoryColorClass(r.category)}">${esc(r.category)}</span>${r.subcategory ? " · " + esc(r.subcategory) : ""}</span>
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
                ${g.income > 0 ? `<span class="tx-income" id="tx-g-inc-${g.key}">+${money(g.income)}</span>` : ""}
                ${g.income > 0 && g.expense > 0 ? '<span class="tx-sep">·</span>' : ""}
                ${g.expense > 0 ? `<span id="tx-g-exp-${g.key}">${money(g.expense)}</span>` : ""}
              </span>
            </button>
            <div class="tx-group-body">${g.rows.map(txRow).join("")}</div>
          </div>`;
            })
            .join("")
    }
  </div>`;

  groups.forEach((g) => {
    if (txRevealed.has(g.key)) return;
    txRevealed.add(g.key);

    if (g.income > 0) {
      const el = document.getElementById(`tx-g-inc-${g.key}`);
      if (el) countUp(el, 0, g.income, (v) => `+${money(v)}`);
    }
    if (g.expense > 0) {
      const el = document.getElementById(`tx-g-exp-${g.key}`);
      if (el) countUp(el, 0, g.expense, money);
    }

    if (!txCollapsed.has(g.key)) {
      const groupEl = view.querySelector(`.tx-group[data-month="${g.key}"]`);
      if (groupEl) revealStagger(groupEl.querySelectorAll(".tx-row"));
    }
  });

  ["q", "cat", "type", "month"].forEach((k) => {
    if (!prevFilter[k] && f[k]) {
      const el = view.querySelector(`.fpill[data-clear="${k}"]`);
      if (el) revealStagger([el], { stagger: 0 });
    }
  });

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
      (el.onclick = async () => {
        await exitCollapse(el);
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
            row.style.opacity = "";
            await exitCollapse(row);
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
function renderBudget() {
  // Includes user-created categories, not just the built-in list.
  const allCats = listFor("category");
  // Budget is deliberately household-level: one ceiling for the two of you.
  // The bars therefore always show combined spend, whoever is selected above.
  const actuals = {};
  for (const c of listFor("category")) {
    actuals[c] = {};
    for (let m = 1; m <= 12; m++) {
      actuals[c][m] = state.rows
        // type === 'Expense' is essential, not cosmetic. Without it a credit-card
        // payment, a CIBC->Wealthsimple move, or a transfer between Ramesh and
        // Surya all counted as spending. That inflated "spent so far" from
        // $69,317 to $480,533 - it was adding $411,216 of money that only ever
        // moved between the household's own accounts.
        .filter(
          (r) =>
            r.type === "Expense" &&
            r.category === c &&
            monthOf(r) === m &&
            Number(String(r.date).slice(0, 4)) === state.year,
        )
        .reduce((a, r) => a + r.amount, 0);
    }
  }

  // Summary numbers for the header strip
  const totalBudget = EXPENSE_CATS.reduce((a, c) => {
    return (
      a +
      Object.values(state.budget[c] || {}).reduce(
        (s, v) => s + (Number(v) || 0),
        0,
      )
    );
  }, 0);
  const totalSpent = EXPENSE_CATS.reduce(
    (a, c) => a + Object.values(actuals[c] || {}).reduce((s, v) => s + v, 0),
    0,
  );
  const budgetedCats = CAT_NAMES.filter((c) =>
    Object.values(state.budget[c] || {}).some((v) => Number(v) > 0),
  ).length;

  const renderCard = (c) => {
    const type = CAT_TYPE[c];
    const vals = Array.from(
      { length: 12 },
      (_, i) => Number(state.budget[c]?.[i + 1]) || 0,
    );
    const uniform = vals.every((v) => v === vals[0]);
    const annualBudget = vals.reduce((a, v) => a + v, 0);
    const annualActual = Object.values(actuals[c]).reduce((a, v) => a + v, 0);
    const isOver = annualBudget > 0 && annualActual > annualBudget;
    const pct = annualBudget > 0 ? Math.min(annualActual / annualBudget, 1) : 0;
    const hasBudget = annualBudget > 0;
    const hasActual = annualActual > 0;

    return `<div class="bcard" data-cat="${esc(c)}">
      <div class="bcard-head">
        <div class="bcard-name">
          <span class="bcard-dot ${type === "Income" ? "income" : ""}"></span>
          ${esc(c)}
        </div>
        <div class="bcard-annual">
          <span class="bcard-total num" data-annual>${hasBudget ? money(annualBudget) : '<span class="muted">—</span>'}</span>
          <span class="bcard-label">/yr</span>
        </div>
      </div>

      ${
        hasActual || hasBudget
          ? `<div class="bcard-bar-wrap">
        <div class="bcard-bar-track">
          <div class="bcard-bar-fill ${isOver ? "over" : ""}" style="width:${(pct * 100).toFixed(1)}%"></div>
        </div>
        <span class="bcard-bar-label num ${isOver ? "over" : "muted"}">${hasBudget ? (pct * 100).toFixed(0) + "%" : ""}</span>
      </div>
      <div class="bcard-context">
        ${hasActual ? `<span class="num muted" style="font-size:11px">spent ${money(annualActual)}</span>` : '<span class="muted" style="font-size:11px">no spend yet</span>'}
      </div>`
          : `<div style="height:8px"></div>`
      }

      <div class="bcard-mode">
        <label class="bcard-toggle">
          <input type="checkbox" class="uniform-check" ${uniform ? "checked" : ""}>
          <span>Same every month</span>
        </label>
      </div>

      <div class="bcard-uniform" style="${uniform ? "" : "display:none"}">
        <div class="bcard-uniform-row">
          <span class="bcard-uniform-label">Monthly</span>
          <input class="num bcard-flat-input" type="number" step="1" min="0"
            data-flat value="${vals[0]}" placeholder="0">
          <span class="bcard-uniform-label muted">× 12</span>
        </div>
      </div>

      <div class="bcard-months" style="${uniform ? "display:none" : ""}">
        ${MONTHS.map((m, i) => {
          const a = actuals[c][i + 1];
          const b = vals[i];
          const mo = b > 0 && a > b;
          return `<div class="bmonth">
            <span class="bmonth-label">${m}</span>
            <input class="num bmonth-input ${mo ? "over" : ""}" type="number" step="1" min="0"
              data-m="${i + 1}" value="${b}" placeholder="0">
            ${a > 0 ? `<span class="bmonth-actual num ${mo ? "over" : "muted"}">${money(a)}</span>` : '<span class="bmonth-actual"></span>'}
          </div>`;
        }).join("")}
      </div>
    </div>`;
  };

  view.innerHTML = `
  <div class="head">
    <div><h1>Budget</h1><p class="sub">One shared household ceiling per category. Bars show <b>combined</b> spend for both of you, regardless of who is selected above. Zero means "not budgeted".</p></div>
    <div class="spacer"></div>
    <div class="actions">
      <button class="btn ghost" id="b-clear-all">Clear all</button>
      <button class="btn" id="b-save">Save budget</button>
    </div>
  </div>

  <div class="b-summary">
    <div class="b-sum-item">
      <span class="b-sum-val num">${money(totalBudget)}</span>
      <span class="b-sum-key">annual expense budget</span>
    </div>
    <div class="b-sum-item">
      <span class="b-sum-val num ${totalSpent > totalBudget && totalBudget > 0 ? "over" : ""}">${money(totalSpent)}</span>
      <span class="b-sum-key">spent so far ${state.year}</span>
    </div>
    <div class="b-sum-item">
      <span class="b-sum-val num">${budgetedCats}</span>
      <span class="b-sum-key">categories budgeted</span>
    </div>
  </div>

  <div class="eyebrow">Income</div>
  <div class="bcards">
    ${allCats
      .filter((c) => CAT_TYPE[c] === "Income")
      .map(renderCard)
      .join("")}
  </div>

  <div class="eyebrow">Expenses</div>
  <div class="bcards">
    ${allCats
      .filter((c) => CAT_TYPE[c] !== "Income")
      .map(renderCard)
      .join("")}
  </div>

  <p class="note" style="margin-top:18px">Bar shows actual spend vs this year's budget. Red = over. Nothing saves until you click <b>Save budget</b>.</p>`;

  // --- wire up each card
  view.querySelectorAll(".bcard").forEach((card) => {
    const cat = card.dataset.cat;

    const getAnnual = () => {
      const uniformEl = card.querySelector(".bcard-flat-input");
      if (!card.querySelector(".bcard-uniform-row").parentElement.hidden) {
        const v = Number(uniformEl?.value) || 0;
        return v * 12;
      }
      return [...card.querySelectorAll("[data-m]")].reduce(
        (a, i) => a + (Number(i.value) || 0),
        0,
      );
    };

    const updateAnnual = () => {
      const a = getAnnual();
      card.querySelector("[data-annual]").innerHTML =
        a > 0 ? money(a) : '<span class="muted">—</span>';
    };

    // toggle uniform ↔ monthly
    card.querySelector(".uniform-check").onchange = (e) => {
      const uniformDiv = card.querySelector(".bcard-uniform");
      const monthsDiv = card.querySelector(".bcard-months");
      const isUniform = e.target.checked;
      uniformDiv.style.display = isUniform ? "" : "none";
      monthsDiv.style.display = isUniform ? "none" : "";
      if (isUniform) {
        // sync flat input to first month value
        const first = Number(card.querySelector('[data-m="1"]')?.value) || 0;
        card.querySelector(".bcard-flat-input").value = first;
      } else {
        // spread flat value to all months
        const flat =
          Number(card.querySelector(".bcard-flat-input")?.value) || 0;
        card.querySelectorAll("[data-m]").forEach((i) => {
          i.value = flat;
        });
      }
      updateAnnual();
    };

    // flat input changes
    card
      .querySelector(".bcard-flat-input")
      ?.addEventListener("input", updateAnnual);

    // monthly inputs
    card.querySelectorAll("[data-m]").forEach((inp) =>
      inp.addEventListener("input", () => {
        updateAnnual();
        // colour the input red if actual > budget for that month
        const m = Number(inp.dataset.m);
        const b = Number(inp.value) || 0;
        const a = actuals[cat][m] || 0;
        inp.classList.toggle("over", b > 0 && a > b);
      }),
    );

    updateAnnual();
  });

  // save
  $("#b-save").onclick = async () => {
    const b = {};
    view.querySelectorAll(".bcard").forEach((card) => {
      const c = card.dataset.cat;
      b[c] = {};
      const isUniform = card.querySelector(".uniform-check").checked;
      if (isUniform) {
        const flat =
          Number(card.querySelector(".bcard-flat-input")?.value) || 0;
        for (let m = 1; m <= 12; m++) b[c][m] = flat;
      } else {
        card.querySelectorAll("[data-m]").forEach((i) => {
          b[c][Number(i.dataset.m)] = Number(i.value) || 0;
        });
      }
    });
    const done = await withBusy("Saving the budget", async () => {
      await state.store.setBudget(b, state.year);
      await refresh();
    });
    if (done) {
      notice("Budget saved.", "ok");
      renderBudget();
    }
  };

  // clear all
  $("#b-clear-all").onclick = () => {
    if (!confirm("Reset every budget amount to zero?")) return;
    view.querySelectorAll("input[type=number]").forEach((i) => {
      i.value = 0;
    });
    view.querySelectorAll("[data-annual]").forEach((el) => {
      el.innerHTML = '<span class="muted">—</span>';
    });
    view.querySelectorAll(".b-sum-val").forEach((el, i) => {
      if (i < 2) el.textContent = money(0);
    });
    view.querySelector(".b-sum-item:nth-child(3) .b-sum-val").textContent = "0";
  };
}

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
function debtSummary(debts) {
  const agreements = debts.filter((d) => d.kind !== "Payment");
  return agreements.map((a) => {
    const payments = debts
      .filter(
        (d) => d.kind === "Payment" && Number(d.parentId) === Number(a.id),
      )
      .sort((x, y) => (x.date < y.date ? 1 : -1));
    const paid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
    const principal = Number(a.amount || 0);
    const outstanding = Math.max(0, principal - paid);
    return {
      ...a,
      payments,
      paid,
      principal,
      outstanding,
      settled: outstanding < 0.005,
      overpaid: paid - principal > 0.005,
      pct: principal > 0 ? Math.min(paid / principal, 1) : 0,
    };
  });
}

/** Debts feed net worth directly - no manual balance entry needed. */
function debtNetWorth(debts, owner) {
  const rows = debtSummary(debts).filter((d) => !owner || d.owner === owner);
  return {
    liability: rows
      .filter((d) => d.direction === "Owed")
      .reduce((s, d) => s + d.outstanding, 0),
    receivable: rows
      .filter((d) => d.direction === "Lent")
      .reduce((s, d) => s + d.outstanding, 0),
  };
}

/** Transactions that look like they involve this counterparty. */
function relatedTransactions(counterparty) {
  const needle = String(counterparty || "")
    .toLowerCase()
    .trim();
  if (needle.length < 3) return [];
  return state.rows.filter((r) =>
    (r.description + " " + r.subcategory + " " + r.notes)
      .toLowerCase()
      .includes(needle),
  );
}

function renderNetWorth() {
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

function wireDebtHandlers() {
  const reload = async () => {
    state.debts = await state.store.getDebts();
    renderNetWorth();
  };

  $("#debt-add")?.addEventListener("click", () => debtDialog(null));

  $("#debt-import")?.addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const out = $("#debt-import-out");
    try {
      const text = await file.text();
      let recs;
      if (file.name.toLowerCase().endsWith(".json")) recs = JSON.parse(text);
      else {
        const lines = text.trim().split(/\r?\n/);
        // quoted fields matter here: notes carry commas
        const split = (l) => {
          const o = [];
          let cur = "",
            q = false;
          for (const ch of l) {
            if (ch === '"') q = !q;
            else if (ch === "," && !q) {
              o.push(cur);
              cur = "";
            } else cur += ch;
          }
          o.push(cur);
          return o.map((x) => x.trim());
        };
        const head = split(lines[0]).map((h) => h.toLowerCase());
        recs = lines
          .slice(1)
          .filter(Boolean)
          .map((l) => {
            const c = split(l);
            const g = (k) =>
              head.indexOf(k) === -1 ? "" : (c[head.indexOf(k)] ?? "").trim();
            return {
              kind: g("kind"),
              parentId: g("parentid"),
              counterparty: g("counterparty"),
              direction: g("direction"),
              description: g("description"),
              date: g("date"),
              amount: Number(String(g("amount")).replace(/[$,\s]/g, "")),
              owner: g("owner"),
              notes: g("notes"),
            };
          });
      }
      const debts = recs.filter(
        (r) =>
          r.kind !== "Payment" &&
          /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
          r.amount > 0,
      );
      const pays = recs.filter(
        (r) =>
          r.kind === "Payment" &&
          /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
          r.amount > 0,
      );
      if (!debts.length) {
        out.innerHTML =
          '<b class="over">No debt rows found. Need a row with kind=Debt.</b>';
        return;
      }
      const principal = debts.reduce((a, r) => a + r.amount, 0),
        repaid = pays.reduce((a, r) => a + r.amount, 0);
      if (
        !confirm(
          `Import ${debts.length} agreement(s) and ${pays.length} payment(s)?\n\n` +
            `Principal ${money(principal)}\nRepaid ${money(repaid)}\n` +
            `Outstanding ${money(Math.max(0, principal - repaid))}`,
        )
      ) {
        out.textContent = "Cancelled.";
        return;
      }

      // Every debt and payment goes in ONE request, not one per row. A prior
      // version looped addDebt() per row - 33 sequential network calls for a
      // 32-payment ledger - and anything that interrupted the loop partway
      // (a network blip, a backgrounded tab) left the sheet holding whichever
      // rows had already landed and silently dropped the rest, with the wrong
      // total showing and no error. A single batch either fully lands or fully
      // fails; there is no partial state to land in.
      debts.forEach((d, i) => {
        d.fileRef = String(i + 1);
      });
      pays.forEach((p) => {
        p.parentFileRef = String(p.parentId || "1");
      });
      const batch = [
        ...debts.map((d) => ({ ...d, kind: "Debt" })),
        ...pays.map((p) => ({ ...p, kind: "Payment" })),
      ];

      const done = await withBusy(
        `Importing ${recs.length} rows in one batch`,
        async () => {
          const res = await state.store.importDebts(batch);
          state.debts = await state.store.getDebts();
          return res;
        },
      );
      if (done) {
        notice(
          `Imported ${debts.length} agreement(s), ${pays.length} payment(s) in a single write.`,
          "ok",
        );
        renderNetWorth();
      }
    } catch (err) {
      out.innerHTML = `<b class="over">${esc(err.message)}</b>`;
    }
  });
  view
    .querySelectorAll("[data-editdebt]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          debtDialog(
            (state.debts || []).find(
              (d) => Number(d.id) === Number(b.dataset.editdebt),
            ),
          )),
    );

  view
    .querySelectorAll("[data-pay]")
    .forEach((b) => (b.onclick = () => paymentDialog(Number(b.dataset.pay))));

  // Repair path for the sequential-import bug: a debt whose payments sum to
  // less than what its own notes/description implies is very likely a partial
  // import from before batching existed. Surface a one-click fix rather than
  // making the person work out what happened themselves.
  view.querySelectorAll("[data-fixpartial]").forEach(
    (b) =>
      (b.onclick = async () => {
        const id = Number(b.dataset.fixpartial);
        const d = debtSummary(state.debts || []).find((x) => x.id === id);
        if (!d) return;
        if (
          !confirm(
            `Delete "${d.counterparty}" and its ${d.payments.length} payment(s), so you can ` +
              `re-import the full ledger cleanly?\n\nThis cannot be undone.`,
          )
        )
          return;
        if (
          await withBusy("Removing the partial import", async () => {
            await state.store.deleteDebt(id);
          })
        ) {
          state.debts = await state.store.getDebts();
          notice("Removed. Re-import your ledger file now.", "ok");
          renderNetWorth();
        }
      }),
  );

  view.querySelectorAll("[data-deldebt]").forEach(
    (b) =>
      (b.onclick = async () => {
        const d = debtSummary(state.debts || []).find(
          (x) => Number(x.id) === Number(b.dataset.deldebt),
        );
        if (!d) return;
        const extra = d.payments.length
          ? `\n\nIts ${d.payments.length} recorded payment(s) will be deleted too.`
          : "";
        if (
          !confirm(
            `Delete "${d.counterparty}" (${money(d.principal)})?${extra}\n\nTransactions are not affected.`,
          )
        )
          return;
        if (
          await withBusy("Deleting", async () => {
            await state.store.deleteDebt(d.id);
          })
        ) {
          await reload();
          notice("Deleted.", "ok");
        }
      }),
  );

  view.querySelectorAll("[data-delpay]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          !confirm(
            "Delete this payment? The outstanding balance will go back up.",
          )
        )
          return;
        if (
          await withBusy("Deleting payment", async () => {
            await state.store.deleteDebt(Number(b.dataset.delpay));
          })
        ) {
          await reload();
          notice("Payment removed.", "ok");
        }
      }),
  );
}

function debtDialog(existing) {
  const d = existing || {};
  const today = new Date().toISOString().slice(0, 10);
  const known = [
    ...new Set((state.debts || []).map((x) => x.counterparty).filter(Boolean)),
  ];
  view.innerHTML = `
  <div class="head">
    <div><h1>${existing ? "Edit" : "Add"} debt or loan</h1>
      <p class="sub">Records a balance-sheet position. It does not create a transaction.</p></div>
    <div class="spacer"></div><button class="btn ghost" id="debt-back">&larr; Back</button>
  </div>
  <form id="debt-form" class="formgrid" autocomplete="off">
    <label class="f"><span>Who *</span>
      <input name="counterparty" value="${esc(d.counterparty || "")}" list="debt-names" placeholder="e.g. Varun" required></label>
    <datalist id="debt-names">${known.map((k) => `<option>${esc(k)}</option>`).join("")}</datalist>
    <label class="f"><span>Direction *</span>
      <select name="direction">
        <option value="Lent"${d.direction === "Lent" ? " selected" : ""}>They owe me (I lent money)</option>
        <option value="Owed"${d.direction === "Owed" ? " selected" : ""}>I owe them</option>
      </select></label>
    <label class="f"><span>Principal amount *</span>
      <input type="number" name="amount" step="0.01" min="0.01" value="${d.amount ?? ""}" required placeholder="0.00"></label>
    <label class="f"><span>Whose *</span>
      <input name="owner" value="${esc(d.owner || "")}" list="owner-names" placeholder="e.g. ${esc(listFor("person")[0] || "your name")}" required></label>
    <datalist id="owner-names">${listFor("person")
      .map((p) => `<option>${esc(p)}</option>`)
      .join("")}</datalist>
    <label class="f"><span>Date opened *</span>
      <input type="date" name="date" value="${esc(d.date || today)}" required></label>
    <label class="f wide"><span>Description</span>
      <input name="description" value="${esc(d.description || "")}" placeholder="What was it for?"></label>
    <div class="full">
      <div class="err" id="debt-err"></div>
      <div class="actions">
        <button class="btn" type="submit">${existing ? "Save changes" : "Add"}</button>
        <button class="btn ghost" type="button" id="debt-cancel">Cancel</button>
      </div>
    </div>
  </form>
  <p class="note">Money you <b>lend</b> becomes an asset (they owe you). Money you <b>owe</b> becomes a
    liability. Either way it updates net worth, and record repayments against it as they happen.</p>`;

  $("#debt-back").onclick = () => renderNetWorth();
  $("#debt-cancel").onclick = () => renderNetWorth();
  $("#debt-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    if (!(Number(f.amount) > 0))
      return ($("#debt-err").textContent =
        "Principal must be greater than zero.");
    if (!f.counterparty.trim())
      return ($("#debt-err").textContent = "Who is this with?");
    const rec = {
      kind: "Debt",
      parentId: null,
      counterparty: f.counterparty.trim(),
      direction: f.direction,
      description: f.description,
      date: f.date,
      amount: Number(f.amount),
      owner: f.owner,
      notes: "",
    };
    const done = await withBusy(existing ? "Saving" : "Adding", async () => {
      if (existing) await state.store.updateDebt(existing.id, rec);
      else await state.store.addDebt(rec);
      state.debts = await state.store.getDebts();
    });
    if (done) {
      notice(existing ? "Updated." : `Added ${f.counterparty.trim()}.`, "ok");
      renderNetWorth();
    }
  };
}

function paymentDialog(debtId) {
  const d = debtSummary(state.debts || []).find(
    (x) => Number(x.id) === Number(debtId),
  );
  if (!d) return;
  const today = new Date().toISOString().slice(0, 10);
  view.innerHTML = `
  <div class="head">
    <div><h1>Record payment</h1>
      <p class="sub">${esc(d.counterparty)} &middot; ${money(d.outstanding)} outstanding of ${money(d.principal)}</p></div>
    <div class="spacer"></div><button class="btn ghost" id="pay-back">&larr; Back</button>
  </div>
  <form id="pay-form" class="formgrid" autocomplete="off">
    <label class="f"><span>Amount *</span>
      <input type="number" name="amount" step="0.01" min="0.01" value="" required placeholder="0.00" id="pay-amt"></label>
    <label class="f"><span>Date *</span><input type="date" name="date" value="${today}" required></label>
    <label class="f wide"><span>Note</span><input name="description" placeholder="e.g. e-transfer"></label>
    <div class="full">
      <div class="actions" style="margin-bottom:10px">
        <button class="btn ghost" type="button" id="pay-full">Pay full ${money(d.outstanding)}</button>
        <button class="btn ghost" type="button" id="pay-half">Half</button>
      </div>
      <div class="err" id="pay-err"></div>
      <div class="actions">
        <button class="btn" type="submit">Record payment</button>
        <button class="btn ghost" type="button" id="pay-cancel">Cancel</button>
      </div>
    </div>
  </form>
  <p class="note">This reduces the outstanding balance and appears in the payment history.
    It does <b>not</b> create a transaction &mdash; if the cash movement also needs recording,
    add it under <b>Add</b> as a <b>Transfer</b> so it does not count as spending.</p>`;

  $("#pay-back").onclick = () => renderNetWorth();
  $("#pay-cancel").onclick = () => renderNetWorth();
  $("#pay-full").onclick = () => {
    $("#pay-amt").value = d.outstanding.toFixed(2);
  };
  $("#pay-half").onclick = () => {
    $("#pay-amt").value = (d.outstanding / 2).toFixed(2);
  };

  $("#pay-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    const amt = Number(f.amount);
    if (!(amt > 0))
      return ($("#pay-err").textContent = "Amount must be greater than zero.");
    if (
      amt - d.outstanding > 0.005 &&
      !confirm(
        `${money(amt)} is more than the ${money(d.outstanding)} outstanding. Record it anyway?`,
      )
    )
      return;
    const rec = {
      kind: "Payment",
      parentId: d.id,
      counterparty: d.counterparty,
      direction: d.direction,
      description: f.description,
      date: f.date,
      amount: amt,
      owner: d.owner,
      notes: "",
    };
    const done = await withBusy("Recording payment", async () => {
      await state.store.addDebt(rec);
      state.debts = await state.store.getDebts();
    });
    if (done) {
      const left = Math.max(0, d.outstanding - amt);
      notice(
        left < 0.005
          ? `${d.counterparty} fully settled.`
          : `${money(left)} still outstanding.`,
        "ok",
      );
      renderNetWorth();
    }
  };
}

/** Debts & loans section: one card per agreement, with repayment history. */
function renderDebtSection(scopeOwner) {
  const rows = debtSummary(state.debts || [])
    .filter((d) => !scopeOwner || d.owner === scopeOwner)
    .sort((a, b) =>
      a.settled === b.settled
        ? b.outstanding - a.outstanding
        : a.settled
          ? 1
          : -1,
    );

  const owedTotal = rows
    .filter((d) => d.direction === "Owed" && !d.settled)
    .reduce((s, d) => s + d.outstanding, 0);
  const lentTotal = rows
    .filter((d) => d.direction === "Lent" && !d.settled)
    .reduce((s, d) => s + d.outstanding, 0);

  const card = (d) => {
    const rel = relatedTransactions(d.counterparty);
    const relTotal = rel.reduce((s, r) => s + r.amount, 0);
    // If cash moved but no payment was recorded (or vice versa), say so rather
    // than let the two views quietly disagree.
    const mismatch = rel.length > 0 && Math.abs(relTotal - d.paid) > 0.005;
    return `
    <div class="debt-card ${d.settled ? "settled" : ""}" data-debt="${d.id}">
      <div class="debt-head">
        <div>
          <span class="debt-name">${esc(d.counterparty)}</span>
          <span class="tag ${d.direction === "Owed" ? "tag-liab" : ""}">${d.direction === "Owed" ? "You owe" : "Owed to you"}</span>
          ${d.settled ? '<span class="tag debt-settled-tag">Settled</span>' : ""}
          ${d.owner ? `<span class="person-chip ${personColorClass(d.owner)}" data-p="${esc(d.owner)}">${esc(d.owner)}</span>` : ""}
          ${d.description ? `<div class="debt-desc">${esc(d.description)}</div>` : ""}
        </div>
        <div class="debt-amounts">
          <span class="debt-outstanding num ${d.direction === "Owed" ? "tx-over" : "tx-income"}">${money(d.outstanding)}</span>
          <span class="debt-sub">outstanding of ${money(d.principal)}</span>
        </div>
      </div>

      <div class="debt-bar-track"><div class="debt-bar-fill ${d.settled ? "done" : ""}" style="width:${(d.pct * 100).toFixed(1)}%"></div></div>
      <div class="debt-meta">
        <span class="muted">${money(d.paid)} repaid \u00b7 ${(d.pct * 100).toFixed(0)}%</span>
        <span class="muted">${d.payments.length} payment${d.payments.length === 1 ? "" : "s"} \u00b7 opened ${esc(d.date)}</span>
      </div>

      ${
        d.overpaid
          ? `<div class="debt-warn">Payments exceed the principal by
        ${money(d.paid - d.principal)}. Outstanding is floored at zero.</div>`
          : ""
      }
      ${
        d.notes &&
        /\$[\d,]+\.\d{2}/.test(d.notes) &&
        d.payments.length > 0 &&
        d.payments.length < 20
          ? `<div class="debt-warn">This looks like it might be a partial import from before batch import
           existed \u2014 only ${d.payments.length} payment(s) are recorded. If you imported a longer
           ledger and expected more, <button class="rowbtn" style="display:inline" data-fixpartial="${d.id}">remove this and re-import</button>.</div>`
          : ""
      }
      ${
        mismatch
          ? `<div class="debt-warn">Transactions mentioning &ldquo;${esc(d.counterparty)}&rdquo;
        total ${money(relTotal)}, but ${money(d.paid)} is recorded here.
        ${relTotal > d.paid ? "Some cash movement has no matching payment." : "Some payments have no matching transaction."}</div>`
          : ""
      }

      ${
        d.payments.length
          ? `<details class="debt-history">
        <summary>Payment history</summary>
        <table class="debt-table"><tbody>
          ${d.payments
            .map(
              (p) => `<tr>
            <td class="num">${esc(p.date)}</td>
            <td>${esc(p.description) || '<span class="muted">\u2014</span>'}</td>
            <td class="n num">${money(p.amount)}</td>
            <td><button class="rowbtn" data-delpay="${p.id}" title="Delete this payment">\u2715</button></td>
          </tr>`,
            )
            .join("")}
        </tbody></table>
      </details>`
          : ""
      }

      ${
        rel.length
          ? `<details class="debt-history">
        <summary>${rel.length} matching transaction${rel.length === 1 ? "" : "s"} (${money(relTotal)})</summary>
        <table class="debt-table"><tbody>
          ${rel
            .slice(0, 10)
            .map(
              (r) => `<tr>
            <td class="num">${esc(r.date)}</td>
            <td>${esc(r.description).slice(0, 44)}</td>
            <td><span class="tag">${esc(r.type)}</span></td>
            <td class="n num">${money(r.amount)}</td>
          </tr>`,
            )
            .join("")}
        </tbody></table>
        <p class="note" style="margin:8px 0 0">These come from your Transactions tab. They are shown for
          cross-checking only &mdash; recording a payment here does not create or alter a transaction.</p>
      </details>`
          : ""
      }

      <div class="debt-actions">
        <button class="btn ghost debt-pay" data-pay="${d.id}">Record payment</button>
        <button class="btn ghost" data-editdebt="${d.id}">Edit</button>
        <button class="rowbtn" data-deldebt="${d.id}" title="Delete this agreement and its payments">\u2715</button>
      </div>
    </div>`;
  };

  return `
  <div class="eyebrow">Debts &amp; loans</div>
  ${
    rows.length
      ? `<div class="debt-summary">
    <div><span class="debt-sum-label">You owe</span><span class="debt-sum-val num tx-over">${money(owedTotal)}</span></div>
    <div><span class="debt-sum-label">Owed to you</span><span class="debt-sum-val num tx-income">${money(lentTotal)}</span></div>
    <div><span class="debt-sum-label">Net position</span><span class="debt-sum-val num ${lentTotal - owedTotal < 0 ? "tx-over" : "tx-income"}">${money(lentTotal - owedTotal)}</span></div>
  </div>`
      : ""
  }

  <div class="debt-list">
    ${
      rows.length
        ? rows.map(card).join("")
        : `<div class="empty">No debts or loans recorded. Use <b>Add debt or loan</b> to track money you owe,
         or money you have lent out.</div>`
    }
  </div>

  <div class="actions" style="margin:12px 0 8px">
    <button class="btn" id="debt-add">Add debt or loan</button>
    <label class="btn ghost nw-import-btn" for="debt-import">Import ledger\u2026</label>
    <input type="file" id="debt-import" accept=".csv,.json" hidden>
    <span class="muted">Outstanding balances flow into the net-worth totals above automatically.</span>
  </div>
  <div id="debt-import-out" class="note" style="margin:0 0 24px"></div>`;
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
