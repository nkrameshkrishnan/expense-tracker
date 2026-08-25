/* Chart.js wrappers. Each call destroys the previous instance on that canvas,
   which is what stops the classic "ghost tooltip from the old chart" bug. */
import { personColorIndex, categoryColorIndex, currentCurrency } from "./store.js";

const INK = "#14151a",
  INK3 = "#8a8d99",
  RULE = "#e7e8ed";
const TEAL = "#00a389",
  AMBER = "#ff6b4a",
  RED = "#e5484d",
  BLUE = "#3b82f6",
  PURPLE = "#a855f7",
  SAND = "#c7cad1";
const CATEGORY_SPECTRUM = [
  "#3b82f6", "#a855f7", "#ec4899", "#f59e0b",
  "#10b981", "#06b6d4", "#f97316", "#8b5cf6",
  "#ef4444", "#14b8a6", "#eab308", "#84cc16",
];

const registry = new Map();
const money0 = (v) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currentCurrency(),
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 0,
  }).format(v);

function mount(id, config) {
  const el = document.getElementById(id);
  if (!el) return;
  const existing = registry.get(id);
  // If the canvas element is the SAME DOM node as last time, Chart.js can
  // update its data/options in place - much cheaper than tearing down and
  // rebuilding the whole chart (no re-layout, no new WebGL/2D context, no
  // visual flash). This only ever fires when a caller has deliberately kept
  // the canvas alive across a re-render; if the canvas was recreated (the
  // normal case today, since most pages rebuild via innerHTML), `existing`
  // will be bound to a DETACHED node and this falls through to the original
  // destroy+recreate path, unchanged.
  if (existing && existing.canvas === el) {
    existing.data = config.data;
    existing.options = config.options;
    if (existing.config.type !== config.type)
      existing.config.type = config.type;
    existing.update();
    return;
  }
  existing?.destroy();
  Chart.defaults.font.family = "'Inter', ui-monospace, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = INK3;
  registry.set(id, new Chart(el, config));
}
export function destroyAll() {
  registry.forEach((c) => c.destroy());
  registry.clear();
}

const gridY = {
  grid: { color: RULE, drawTicks: false },
  border: { display: false },
  ticks: { callback: money0 },
};
const gridX = { grid: { display: false }, border: { color: RULE } };
const legendTop = {
  legend: {
    position: "top",
    align: "end",
    labels: { boxWidth: 10, boxHeight: 10, padding: 14 },
  },
};
const drawIn = { duration: 600, easing: "easeOutQuart", delay: 550 };

export function incomeVsExpense(series) {
  mount("c-ie", {
    type: "bar",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Income",
          data: series.map((s) => s.income),
          backgroundColor: TEAL,
        },
        {
          label: "Expense",
          data: series.map((s) => s.expense),
          backgroundColor: AMBER,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      plugins: legendTop,
      scales: { x: gridX, y: gridY },
    },
  });
}

export function netByMonth(series) {
  mount("c-net", {
    type: "bar",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Net savings",
          data: series.map((s) => s.net),
          backgroundColor: series.map((s) => (s.net < 0 ? RED : TEAL)),
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      plugins: { legend: { display: false } },
      scales: { x: gridX, y: gridY },
    },
  });
}

export function trend(series) {
  mount("c-trend", {
    type: "line",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Actual expense",
          data: series.map((s) => (s.hasData ? s.expense : null)),
          borderColor: INK,
          backgroundColor: INK,
          tension: 0.25,
          spanGaps: true,
          pointRadius: 3,
        },
        {
          label: "Budget ceiling",
          data: series.map((s) => s.budget),
          borderColor: AMBER,
          borderDash: [5, 4],
          pointRadius: 0,
          tension: 0,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      plugins: legendTop,
      scales: { x: gridX, y: gridY },
    },
  });
}

export function actualVsBudget(catRows) {
  const rows = catRows.filter((r) => r.actual > 0 || r.budget > 0);
  mount("c-cat", {
    type: "bar",
    data: {
      labels: rows.map((r) => r.category),
      datasets: [
        {
          label: "Actual",
          data: rows.map((r) => r.actual),
          backgroundColor: rows.map((r) =>
            r.budget > 0 && r.actual > r.budget ? RED : INK,
          ),
        },
        {
          label: "Budget",
          data: rows.map((r) => r.budget),
          backgroundColor: SAND,
        },
      ],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      plugins: legendTop,
      scales: {
        x: { ...gridY },
        y: {
          grid: { display: false },
          border: { color: RULE },
          ticks: { font: { size: 10 } },
        },
      },
    },
  });
}

export function topFive(top5) {
  mount("c-top", {
    type: "bar",
    data: {
      labels: top5.map((t) => t.category),
      datasets: [{ data: top5.map((t) => t.actual), backgroundColor: INK }],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      plugins: { legend: { display: false } },
      scales: { x: { ...gridX, ticks: { font: { size: 10 } } }, y: gridY },
    },
  });
}

export function paymentSplit(byPayment) {
  mount("c-pay", {
    type: "doughnut",
    data: {
      labels: byPayment.map((p) => p.method),
      datasets: [
        {
          data: byPayment.map((p) => p.amount),
          backgroundColor: CATEGORY_SPECTRUM,
          borderColor: "#fff",
          borderWidth: 2,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      cutout: "55%",
      plugins: {
        legend: {
          position: "right",
          labels: { boxWidth: 10, boxHeight: 10, padding: 10 },
        },
      },
    },
  });
}

/* ---- person comparison ---------------------------------------------------- */
// PERSON_PALETTE mirrors store.js's PERSON_PALETTE_SIZE (5 colours) so
// personColorIndex(name) always resolves to a real entry here - a tenant's
// household member names are not known in advance, so colour is assigned
// by a stable hash of the name rather than a lookup table of specific
// names. "Unassigned" is deliberately not hashed into the palette: it is a
// state, not a person, and gets the same neutral SAND it always has.
const PERSON_PALETTE = [TEAL, AMBER, BLUE, RED, PURPLE];
const colorFor = (p) =>
  p && p !== "Unassigned"
    ? PERSON_PALETTE[personColorIndex(p) % PERSON_PALETTE.length]
    : SAND;

export function personSplit(breakdown) {
  mount("c-person-split", {
    type: "doughnut",
    data: {
      labels: breakdown.map((b) => b.person),
      datasets: [
        {
          data: breakdown.map((b) => b.expense),
          backgroundColor: breakdown.map((b) => colorFor(b.person)),
          borderColor: "#fff",
          borderWidth: 2,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      cutout: "55%",
      plugins: {
        legend: {
          position: "right",
          labels: { boxWidth: 10, boxHeight: 10, padding: 10 },
        },
      },
    },
  });
}

export function personByMonth(series, months) {
  mount("c-person-month", {
    type: "bar",
    data: {
      labels: months,
      datasets: series.map((s) => ({
        label: s.person,
        data: s.data,
        backgroundColor: colorFor(s.person),
      })),
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      plugins: legendTop,
      scales: {
        x: { ...gridX, stacked: false },
        y: { ...gridY, stacked: false },
      },
    },
  });
}

export function personVsBudget(rows) {
  mount("c-person-cat", {
    type: "bar",
    data: {
      labels: rows.map((r) => r.category),
      datasets: rows[0]
        ? Object.keys(rows[0].byPerson).map((p) => ({
            label: p,
            data: rows.map((r) => r.byPerson[p] || 0),
            backgroundColor: colorFor(p),
          }))
        : [],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      responsive: true,
      plugins: legendTop,
      scales: {
        x: { ...gridY, stacked: true },
        y: {
          grid: { display: false },
          border: { color: RULE },
          stacked: true,
          ticks: { font: { size: 10 } },
        },
      },
    },
  });
}

/* ---- net worth ------------------------------------------------------------ */
export function netWorthTrend(series) {
  mount("c-nw-trend", {
    type: "line",
    data: {
      labels: series.map((s) => s.date),
      datasets: [
        {
          label: "Net worth",
          data: series.map((s) => s.net),
          borderColor: INK,
          backgroundColor: INK,
          tension: 0.25,
          pointRadius: 4,
        },
        {
          label: "Assets",
          data: series.map((s) => s.assets),
          borderColor: TEAL,
          borderDash: [5, 4],
          pointRadius: 0,
        },
        {
          label: "Liabilities",
          data: series.map((s) => s.liabs),
          borderColor: RED,
          borderDash: [5, 4],
          pointRadius: 0,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: legendTop,
      scales: { x: gridX, y: gridY },
    },
  });
}

export function assetSplit(assets) {
  const rows = assets
    .filter((a) => Number(a.balance) > 0)
    .sort((a, b) => b.balance - a.balance);
  mount("c-nw-split", {
    type: "doughnut",
    data: {
      labels: rows.map((a) => a.account),
      datasets: [
        {
          data: rows.map((a) => Number(a.balance)),
          backgroundColor: CATEGORY_SPECTRUM,
          borderColor: "#fff",
          borderWidth: 2,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      cutout: "55%",
      plugins: {
        legend: {
          position: "right",
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            padding: 8,
            font: { size: 10 },
          },
        },
      },
    },
  });
}

export function dividendsTrend(series) {
  mount("c-dividends", {
    type: "bar",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Dividends",
          data: series.map((s) => s.dividends || 0),
          backgroundColor: AMBER,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      plugins: { legend: { display: false } },
      scales: { x: gridX, y: gridY },
    },
  });
}

export function cashFlow(flows) {
  const flowColorFor = (label) =>
    label === "Income" || label === "Savings"
      ? TEAL
      : CATEGORY_SPECTRUM[categoryColorIndex(label)];
  mount("c-cashflow", {
    type: "sankey",
    data: {
      datasets: [
        {
          data: flows,
          colorFrom: (c) => flowColorFor(c.dataset.data[c.dataIndex].from),
          colorTo: (c) => flowColorFor(c.dataset.data[c.dataIndex].to),
          colorMode: "gradient",
          alpha: 0.85,
        },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, animation: drawIn },
  });
}

export function netTrendLine(series) {
  mount("c-net-trend", {
    type: "line",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Net",
          data: series.map((s) => s.net),
          borderColor: TEAL,
          backgroundColor: (ctx) => {
            const { chart } = ctx;
            const { ctx: c, chartArea } = chart;
            if (!chartArea) return TEAL;
            const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            gradient.addColorStop(0, "rgba(0, 163, 137, 0.25)");
            gradient.addColorStop(1, "rgba(229, 72, 77, 0.15)");
            return gradient;
          },
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: (ctx) =>
            ctx.parsed && ctx.parsed.y < 0 ? RED : TEAL,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      plugins: { legend: { display: false } },
      scales: { x: gridX, y: gridY },
    },
  });
}

export function spendingDonut(rows, onSliceClick) {
  mount("c-spend-donut", {
    type: "doughnut",
    data: {
      labels: rows.map((r) => r.category),
      datasets: [
        {
          data: rows.map((r) => r.actual),
          backgroundColor: rows.map((r) =>
            r.category === "Other" ? RULE : CATEGORY_SPECTRUM[categoryColorIndex(r.category)],
          ),
          borderWidth: 2,
          borderColor: "#ffffff",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: drawIn,
      cutout: "62%",
      plugins: { legend: { display: false } },
      onClick: (evt, elements) => {
        if (elements.length) onSliceClick(rows[elements[0].index].category);
      },
    },
  });
}

export function spendTrend(series) {
  mount("c-spend-trend", {
    type: "bar",
    data: {
      labels: series.map((s) => s.month),
      datasets: [{ label: "Spend", data: series.map((s) => s.expense), backgroundColor: AMBER }],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      animation: drawIn,
      plugins: { legend: { display: false } },
      scales: { x: gridX, y: gridY },
    },
  });
}

export function highlightSlice(index) {
  const chart = registry.get("c-spend-donut");
  if (!chart) return;
  chart.setActiveElements(
    index === null ? [] : [{ datasetIndex: 0, index }],
  );
  chart.update();
}
