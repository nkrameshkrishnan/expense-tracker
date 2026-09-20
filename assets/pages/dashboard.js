/* Dashboard page: KPI cards, income/expense/net charts, category breakdown,
   the category-by-month Sankey diagram, and the top-N/over-budget panels. */
import { MONTHS, currentYear, UNASSIGNED, PERSON_KEY } from "../store.js";
import {
  aggregate,
  money,
  pct,
  personBreakdown,
  personSeries,
  categorySeries,
} from "../xlsxio.js";
import * as charts from "../charts.js";
import {
  $,
  view,
  esc,
  state,
  scoped,
  personLabel,
  kpi,
  notice,
  YEAR_KEY,
} from "../core.js";
import { go } from "../router.js";

function availableYears() {
  // A backend whose cache exposes allTxYears (every year that actually
  // exists, independent of which years have had their data fetched yet)
  // gets an accurate list even before every year is loaded. Nothing
  // currently populates this for SupabaseStore - it lazy-loads by year the
  // same way the old SheetsStore did, but has no "list distinct years"
  // query wired up yet - so this falls through to scanning state.rows,
  // which is only as complete as whatever years have been fetched so far.
  // LocalStore/MemoryStore never partially load, so scanning state.rows for
  // them is already complete and correct regardless.
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

export function renderDashboard() {
  const a = aggregate(scoped(), state.budget, state.month, state.year);
  const label =
    state.month === 0
      ? `Full year ${state.year}`
      : `${MONTHS[state.month - 1]} ${state.year}`;
  // Comparison is always computed across everyone, so it stays meaningful
  // even while the rest of the page is filtered to one person.
  const people = personBreakdown(state.rows, state.month, state.year);
  const pSeries = personSeries(state.rows, state.year);
  const catSeries = categorySeries(state.rows, state.catMonthYear);
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
      "Chart.js did not load, so charts are unavailable. Everything else works.",
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
  charts.categoryByMonth(
    catSeries,
    MONTHS,
    state.catMonthHighlight,
    state.catMonthOrientation,
  );
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

  // "Category spend by month" panel's own year/filter/orientation controls -
  // deliberately separate state from #y-sel/#m-sel above, and re-renders
  // only this one chart rather than the whole dashboard.
  const refreshCategoryMonthChart = () => {
    const label = $("#dash-catmonth-label");
    if (label) label.textContent = state.catMonthYear;
    charts.categoryByMonth(
      categorySeries(state.rows, state.catMonthYear),
      MONTHS,
      state.catMonthHighlight,
      state.catMonthOrientation,
    );
  };
  $("#cm-y-sel").onchange = async (e) => {
    state.catMonthYear = Number(e.target.value);
    // state.rows only holds years fetched so far (boot loads the current
    // year first, others lazily in the background) - same guard as #y-sel,
    // otherwise picking a not-yet-loaded year would silently draw an
    // all-zero chart instead of that year's real data.
    await state.store.ensureYearLoaded?.(state.catMonthYear);
    state.rows = await state.store.list();
    refreshCategoryMonthChart();
  };
  $("#cm-m-sel").onchange = (e) => {
    state.catMonthHighlight = Number(e.target.value);
    refreshCategoryMonthChart();
  };
  $("#cm-o-sel").onchange = (e) => {
    state.catMonthOrientation = e.target.value;
    refreshCategoryMonthChart();
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
    ${kpi("Avg / day", money(a.avgDaily), label, "", "avgday")}
    ${kpi("Avg / week", money(a.avgWeekly), label, "", "avgweek")}
    ${kpi("Avg / month", money(a.avgMonthly), label, "", "avgmonth")}
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
    <div class="panel wide">
      <div class="panel-head">
        <h3>Category spend by month &mdash; <span id="dash-catmonth-label">${state.catMonthYear}</span></h3>
        <div class="panel-controls">
          <select id="cm-y-sel" title="Year">
            ${availableYears()
              .map(
                (y) =>
                  `<option value="${y}"${y === state.catMonthYear ? " selected" : ""}>${y}</option>`,
              )
              .join("")}
          </select>
          <select id="cm-m-sel" title="Filter to month">
            <option value="0"${state.catMonthHighlight === 0 ? " selected" : ""}>All months</option>
            ${MONTHS.map(
              (m, i) =>
                `<option value="${i + 1}"${state.catMonthHighlight === i + 1 ? " selected" : ""}>${m}</option>`,
            ).join("")}
          </select>
          <select id="cm-o-sel" title="Orientation">
            <option value="horizontal"${state.catMonthOrientation === "horizontal" ? " selected" : ""}>Horizontal</option>
            <option value="vertical"${state.catMonthOrientation === "vertical" ? " selected" : ""}>Vertical</option>
          </select>
        </div>
      </div>
      <div class="chartbox sankey"><canvas id="c-cat-month"></canvas></div>
    </div>
  </div>

  <div class="eyebrow">Category detail &mdash; <span id="dash-catdetail-label">${esc(label)}</span></div>
  <div class="tablewrap"><table><thead><tr><th>Category</th><th class="n">Actual</th><th class="n">Budget</th><th class="n">Variance</th><th class="n">Used</th></tr></thead><tbody id="catdetail-tbody">
    ${catDetailRows(a)}
  </tbody></table></div>`;
  view.dataset.shell = "dashboard";
}

/** Fast path: same shape as last render, so every section that exists now
    existed before too. Patch text/tables/charts in place - no innerHTML
    rebuild, no canvas recreation, no visual flash. */
function updateDashboardValues(a, label, people, pSeries, showCompare) {
  const sub = $("#dash-sub");
  if (sub)
    sub.textContent = `${personLabel()} \u00b7 ${label} \u00b7 ${a.count} transactions`;

  const setKpi = (key, v, m) => {
    const vEl = $(`#kpi-${key}-v`),
      mEl = $(`#kpi-${key}-m`);
    if (vEl) vEl.textContent = v;
    if (mEl) mEl.textContent = m;
  };
  setKpi("income", money(a.income), a.income === 0 ? "no income recorded" : "");
  setKpi("expense", money(a.expense), `${a.count} entries`);
  const netEl = $("#kpi-net");
  if (netEl)
    netEl.className = `kpi card-hoverable ${a.net < 0 ? "neg" : "pos"}`;
  setKpi("net", money(a.net), a.net < 0 ? "spending exceeds income" : "");
  setKpi(
    "savings",
    a.income > 0 ? pct(a.savingsRate) : "\u2014",
    a.income > 0 ? "" : "needs income data",
  );
  const budEl = $("#kpi-budgetused");
  if (budEl)
    budEl.className = `kpi card-hoverable ${a.budgetUsed > 1 ? "neg" : ""}`;
  setKpi(
    "budgetused",
    a.expenseBudget > 0 ? pct(a.budgetUsed) : "\u2014",
    a.expenseBudget > 0
      ? state.person
        ? `of ${money(a.expenseBudget)} household`
        : `of ${money(a.expenseBudget)}`
      : "no budget set",
  );
  setKpi("avgday", money(a.avgDaily), label);
  setKpi("avgweek", money(a.avgWeekly), label);
  setKpi("avgmonth", money(a.avgMonthly), label);

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
  const cm = $("#dash-catmonth-label");
  if (cm) cm.textContent = state.catMonthYear;
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
          <span class="person-swatch" data-p="${esc(b.person)}"></span>
          <span class="person-card-name">${esc(b.person)}</span>
        </div>
        <div class="person-card-val num">${money(b.expense)}</div>
        <div class="person-card-bar"><div class="person-card-fill" data-p="${esc(b.person)}" style="width:${(b.share * 100).toFixed(1)}%"></div></div>
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
