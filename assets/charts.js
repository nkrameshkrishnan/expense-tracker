import { chartAnimation } from "./motion.js";
import { swatchVar } from "./icons.js";

/* Chart.js wrappers. Each call destroys the previous instance on that canvas,
   which is what stops the classic "ghost tooltip from the old chart" bug. */
let INK = "#12161c",
  INK3 = "#6b7684",
  RULE = "#ddd5c8",
  CARD = "#ffffff";
// Fixed hues for the person charts only (they mirror the .person-swatch
// chips); every other chart reads the semantic palette `PAL` below.
const TEAL = "#0f766e",
  AMBER = "#b45309",
  BLUE = "#1d4ed8",
  SAND = "#c6bcab";

/* Semantic palette, one meaning per colour across every chart (and the
   tables, via semanticColors()). Re-read from the theme tokens by
   readTheme() on every build, so light/dark follow styles.css:
     income / assets / gain / net saved   = --teal
     expense / liabilities / net overspent = --red, shifted ~28% away from the
                                             teal's lightness (lighter on
                                             light, darker on dark) so the two
                                             also differ in lightness, not just
                                             hue, for colour-blind readers
     over-budget flag (outline, ticks)    = --red, unshifted
     budget / ceiling                     = --amber, always dashed or hatched
     actual                               = --ink
     dividends                            = --purple (not amber: that is budget)
     "Other" / neutral                    = --ink-3
   Fallbacks below are only used if a token is missing. */
const PAL = {
  income: "#0f766e",
  expense: "#b3261e",
  alert: "#b3261e",
  budget: "#b45309",
  dividend: "#7c3aed",
};

const registry = new Map();

/** Re-reads ink / ink-3 / rule from the active theme's CSS variables so
    gridlines, ticks and ink-coloured marks follow light/dark. Called at the
    top of every builder (before its config is assembled), along with the
    semantic palette `PAL`. */
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  INK = v("--ink", INK);
  INK3 = v("--ink-3", INK3);
  RULE = v("--rule", RULE);
  CARD = v("--card-bg", CARD);
  const hexTok = (name, fallback) => {
    const rgb = parseHex(v(name, ""));
    return rgb ? toHex(rgb) : fallback;
  };
  PAL.income = hexTok("--teal", PAL.income);
  PAL.alert = hexTok("--red", PAL.alert);
  PAL.budget = hexTok("--amber", PAL.budget);
  PAL.dividend = hexTok("--purple", PAL.dividend);
  // Light card: lift the red toward white; dark card: sink it toward black.
  const cardRgb = parseHex(CARD) || [255, 255, 255];
  const dark =
    cardRgb[0] * 0.2126 + cardRgb[1] * 0.7152 + cardRgb[2] * 0.0722 < 128;
  PAL.expense = mixHex(PAL.alert, dark ? "#000000" : "#ffffff", 0.28);
  gridY.grid.color = RULE;
  gridX.border.color = RULE;
}
const money0 = (v) =>
  "$" + Number(v).toLocaleString("en-CA", { maximumFractionDigits: 0 });

function parseHex(str) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(str).trim());
  if (!m) return null;
  const h =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : m[1];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (rgb) =>
  "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
/** `hex` mixed toward `target` by `amt` (0-1), as #rrggbb. */
function mixHex(hex, target, amt) {
  const a = parseHex(hex),
    b = parseHex(target);
  return toHex(a.map((c, i) => Math.round(c + (b[i] - c) * amt)));
}
/** `hex` as an rgba() string. */
export function withAlpha(hex, alpha) {
  const [r, g, b] = parseHex(hex) || [0, 0, 0];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The semantic palette (see PAL) as resolved hex for the active theme, for
    callers outside this file (tables, chips) that need the same meanings.
    Also returns the matching CSS variable per meaning where one exists. */
export function semanticColors() {
  readTheme();
  return { ...PAL, neutral: INK3, actual: INK };
}

/** Mixes a hex colour toward white by `amt` (0-1) - the bar/line equivalent
    of the doughnut's hoverOffset "pop": since a bar can't push outward the
    way an arc slice can, hovering it instead brightens its fill toward a
    lighter tint of the same hue, which reads as the same "this one's lifted
    toward you" cue. backgroundColor is one of Chart.js's default animated
    colour properties, so this transitions over the same 200ms as everything
    else rather than snapping instantly. */
function lighten(hex, amt) {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const num = parseInt(full, 16);
  const mix = (channel) => Math.round(channel + (255 - channel) * amt);
  const r = mix((num >> 16) & 255);
  const g = mix((num >> 8) & 255);
  const b = mix(num & 255);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Concrete value of --cat-color-<tok>. Canvas can't resolve var(), so this
    reads the computed value on every chart build. Every token is >= 3.7:1 on
    the dark card and >= 4.5:1 on the light card, so no per-theme nudge. */
function tokenHex(tok) {
  const hex = getComputedStyle(document.documentElement)
    .getPropertyValue(`--cat-color-${tok}`)
    .trim();
  return /^#[0-9a-f]{3,6}$/i.test(hex) ? hex : SAND;
}

/** Perceptual families of the 12 --cat-color tokens (several are near
    duplicates), and the order unused families are handed out in (chosen so
    neighbours in a stack contrast: blue, orange, pink, green, violet, cyan,
    ochre, red). */
const COLOR_FAMILY = {
  0: 0,
  1: 4,
  7: 4,
  2: 2,
  3: 6,
  10: 6,
  4: 3,
  11: 3,
  5: 5,
  9: 5,
  6: 1,
  8: 7,
};
const FAMILY_FIRST_TOKEN = [0, 6, 2, 4, 1, 5, 3, 8];

/** One colour per name within a single view. Each name tries its own app
    colour - the hashed --cat-color-N the Transactions chips use (when `seed`
    is set the hash input is `seed:name`, to give a dimension its own
    palette); if that colour's family is already taken it gets the first
    unused family instead. Past 8 names the families run out, so the rest keep
    their own colour. Deterministic.
    Options: `pins` {name: token 0-11} fixes known names first (they never
    shift); `neutral` [names] get the grey "Other" colour and use no family;
    `stable` resolves collisions in alphabetical rather than input order, so
    re-ranking the same names (amounts changing) never changes a colour.
    `names` should be in rank order (largest first) unless `stable`.
    Returns Map(name -> { css: "var(...)", hex }) in `names` order. */
export function distinctColors(
  names,
  { seed = "", pins = {}, neutral = [], stable = false } = {},
) {
  const taken = new Set();
  const picked = new Map();
  const tokOf = (name) =>
    seed
      ? Number(/--cat-color-(\d+)/.exec(swatchVar(`${seed}:${name}`))[1])
      : Number(/--cat-color-(\d+)/.exec(swatchVar(name))[1]);
  const rest = [];
  for (const name of names) {
    if (neutral.includes(name)) picked.set(name, null);
    else if (pins[name] !== undefined) {
      picked.set(name, pins[name]);
      taken.add(COLOR_FAMILY[pins[name]]);
    } else rest.push(name);
  }
  for (const name of stable ? [...rest].sort() : rest) {
    const own = tokOf(name);
    let tok = own;
    if (taken.has(COLOR_FAMILY[own])) {
      const free = FAMILY_FIRST_TOKEN.find((t) => !taken.has(COLOR_FAMILY[t]));
      if (free !== undefined) tok = free;
    }
    if (!taken.has(COLOR_FAMILY[tok])) taken.add(COLOR_FAMILY[tok]);
    picked.set(name, tok);
  }
  const out = new Map();
  for (const name of names) {
    const tok = picked.get(name);
    out.set(
      name,
      tok === null
        ? { css: "var(--ink-3)", hex: INK3 }
        : { css: `var(--cat-color-${tok})`, hex: tokenHex(tok) },
    );
  }
  return out;
}

/** Category colours: the ranked-names form of distinctColors (largest spend
    first), shared by Top 5, Category share, Actual vs budget and the Sankey
    so one category is one colour across the dashboard. */
export function distinctCategoryColors(names) {
  return distinctColors(names);
}

/** The Actual-vs-budget assignment as a Map(category -> {css, hex}): ranked by
    actual over the rows the chart shows (actual or budget > 0). The Dashboard
    category tables call this too, so a category's dot matches its bars. */
export function budgetCategoryColors(catRows) {
  const ranked = catRows
    .filter((r) => r.actual > 0 || r.budget > 0)
    .sort((a, b) => b.actual - a.actual)
    .map((r) => r.category);
  return distinctCategoryColors(ranked);
}

/** Known payment methods get a fixed family so they look the same in every
    chart and table; unknown (custom) names fall back to their hashed colour.
    Tokens: 1 violet, 0 blue, 4 green, 5 cyan, 6 orange. "Other" is grey. */
const PAYMENT_PINS = {
  "Credit Card": 1,
  "Debit Card": 0,
  Cash: 4,
  "e-Transfer": 5,
  "Pre-authorized Debit": 6,
};
export function paymentColors(methods) {
  return distinctColors(methods, {
    seed: "payment",
    pins: PAYMENT_PINS,
    neutral: ["Other"],
    stable: true,
  });
}

/** Diagonal-hatch fill (stripes of `hex` over a faint tint of it) - the
    "planned / budget" counterpart of a solid bar in the same hue, readable
    without relying on colour. Falls back to a flat tint with no 2D context. */
function hatch(hex) {
  const dpr = window.devicePixelRatio || 1;
  const c = document.createElement("canvas");
  c.width = c.height = 8 * dpr;
  const g = c.getContext("2d");
  if (!g) return withAlpha(hex, 0.35);
  g.scale(dpr, dpr);
  g.fillStyle = withAlpha(hex, 0.18);
  g.fillRect(0, 0, 8, 8);
  g.strokeStyle = hex;
  g.lineWidth = 2;
  g.beginPath();
  for (const o of [-8, 0, 8]) {
    g.moveTo(o, 8);
    g.lineTo(o + 8, 0);
  }
  g.stroke();
  const pat = g.createPattern(c, "repeat");
  pat?.setTransform?.(new DOMMatrix().scale(1 / dpr));
  return pat || withAlpha(hex, 0.35);
}

function mount(id, config, stillOnUpdate = false) {
  const el = document.getElementById(id);
  if (!el) return;
  config.options = config.options || {};
  config.options.animation = chartAnimation();
  const existing = registry.get(id);
  // A selector/person change redraws the same live canvas; `stillOnUpdate`
  // charts snap to the new data there (filters never animate). A fresh canvas
  // (page entrance) still gets the shared draw-in above.
  if (stillOnUpdate && existing && existing.canvas === el)
    config.options.animation = { duration: 0 };
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
  // The app's UI face (Inter, from styles.css --disp). Canvas text can't
  // resolve CSS variables, so read the computed stack; system-ui if unset.
  Chart.defaults.font.family =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--disp")
      .trim() || "system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = INK3;
  // Chart.js re-animates an element whenever it becomes "active" (hovered),
  // separately from its initial-render animation - this is that transition's
  // duration/easing, set once here rather than per-chart so every chart
  // feels the same when you hover it. Kept short and ease-out, in the same
  // restrained spirit as this app's own --motion-fast/--ease-out CSS tokens,
  // even though Chart.js's animation system is a separate (canvas-based)
  // mechanism from the CSS transitions those tokens drive.
  Chart.defaults.transitions.active.animation.duration = 200;
  Chart.defaults.transitions.active.animation.easing = "easeOutQuad";
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

export function incomeVsExpense(series) {
  readTheme();
  mount("c-ie", {
    type: "bar",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Income",
          data: series.map((s) => s.income),
          backgroundColor: PAL.income,
          hoverBackgroundColor: lighten(PAL.income, 0.3),
          hoverBorderColor: CARD,
          hoverBorderWidth: 2,
        },
        {
          label: "Expense",
          data: series.map((s) => s.expense),
          backgroundColor: PAL.expense,
          hoverBackgroundColor: lighten(PAL.expense, 0.3),
          hoverBorderColor: CARD,
          hoverBorderWidth: 2,
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

export function netByMonth(series) {
  readTheme();
  mount("c-net", {
    type: "bar",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Net savings",
          data: series.map((s) => s.net),
          backgroundColor: series.map((s) =>
            s.net < 0 ? PAL.expense : PAL.income,
          ),
          hoverBackgroundColor: series.map((s) =>
            lighten(s.net < 0 ? PAL.expense : PAL.income, 0.3),
          ),
          hoverBorderColor: CARD,
          hoverBorderWidth: 2,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            // Sign and wording as well as colour, so a negative month is
            // legible without telling teal from red.
            label: (item) =>
              item.raw < 0
                ? `Net: -${money0(-item.raw)} (overspent)`
                : `Net: +${money0(item.raw)} (saved)`,
          },
        },
      },
      scales: { x: gridX, y: gridY },
    },
  });
}

export function trend(series) {
  readTheme();
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
          // Hovered point grows into a filled ring rather than just a bigger
          // dot - same "white border on the accent colour" language as the
          // doughnut/bar hover states above, so every chart in the dashboard
          // pops its highlighted element the same way.
          pointHoverRadius: 6,
          pointHoverBackgroundColor: CARD,
          pointHoverBorderColor: INK,
          pointHoverBorderWidth: 2,
        },
        {
          label: "Budget ceiling",
          data: series.map((s) => s.budget),
          borderColor: PAL.budget,
          backgroundColor: PAL.budget,
          borderDash: [5, 4],
          tension: 0,
          // Same dots and hover ring as "Actual expense" above, in the
          // line's own colour, so each month's ceiling can be read and
          // compared point-for-point against that month's actual spend.
          pointRadius: 3,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: CARD,
          pointHoverBorderColor: PAL.budget,
          pointHoverBorderWidth: 2,
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

/** Each category keeps its colour (the same ranking-by-actual assignment as
    Top 5 and Category share); Actual is the solid bar and Budget the hatched
    bar in the same hue. Over budget is flagged without colour alone and
    without swapping the fill (a red fill would be indistinguishable from the
    red-family categories): a 3px red border on the bar, a "\u25b2" and red
    bold tick label, and "+N% over" in the tooltip. */
export function actualVsBudget(catRows) {
  readTheme();
  const rows = catRows.filter((r) => r.actual > 0 || r.budget > 0);
  const over = rows.map((r) => r.budget > 0 && r.actual > r.budget);
  const colors = budgetCategoryColors(catRows);
  const hex = rows.map((r) => colors.get(r.category).hex);
  const pct = (i) => Math.round((rows[i].actual / rows[i].budget - 1) * 100);
  mount("c-cat", {
    type: "bar",
    data: {
      labels: rows.map((r) => r.category),
      datasets: [
        {
          label: "Actual",
          data: rows.map((r) => r.actual),
          backgroundColor: hex,
          hoverBackgroundColor: hex.map((h) => lighten(h, 0.3)),
          borderColor: PAL.alert,
          borderWidth: over.map((o) => (o ? 3 : 0)),
          borderSkipped: false,
          hoverBorderColor: over.map((o) => (o ? PAL.alert : CARD)),
          hoverBorderWidth: over.map((o) => (o ? 3 : 2)),
        },
        {
          label: "Budget",
          data: rows.map((r) => r.budget),
          backgroundColor: hex.map((h) => hatch(h)),
          borderColor: hex,
          borderWidth: 1,
          hoverBackgroundColor: hex.map((h) => withAlpha(h, 0.45)),
          hoverBorderColor: hex,
          hoverBorderWidth: 1,
        },
      ],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      responsive: true,
      plugins: {
        legend: {
          ...legendTop.legend,
          labels: {
            ...legendTop.legend.labels,
            // Bars carry per-category colours, so the legend swatches are
            // neutral: solid = actual, hatched = budget, red outline = over.
            generateLabels: () => [
              {
                text: "Actual",
                fillStyle: INK3,
                strokeStyle: INK3,
                lineWidth: 0,
                datasetIndex: 0,
              },
              {
                text: "Budget",
                fillStyle: hatch(INK3),
                strokeStyle: INK3,
                lineWidth: 1,
                datasetIndex: 1,
              },
              {
                text: "\u25b2 Over budget",
                fillStyle: "transparent",
                strokeStyle: PAL.alert,
                lineWidth: 3,
              },
            ],
          },
          onClick: (e, item, legend) => {
            if (item.datasetIndex !== undefined)
              Chart.defaults.plugins.legend.onClick(e, item, legend);
          },
        },
        tooltip: {
          callbacks: {
            label: (item) =>
              item.datasetIndex === 0 && over[item.dataIndex]
                ? [
                    `Actual: ${money0(item.raw)}`,
                    `\u25b2 +${pct(item.dataIndex)}% over budget (${money0(item.raw - rows[item.dataIndex].budget)})`,
                  ]
                : `${item.dataset.label}: ${money0(item.raw)}`,
          },
        },
      },
      scales: {
        x: { ...gridY },
        y: {
          grid: { display: false },
          border: { color: RULE },
          ticks: {
            font: (ctx) => ({
              size: 10,
              weight: over[ctx.tick?.value] ? "700" : "400",
            }),
            color: (ctx) => (over[ctx.tick?.value] ? PAL.alert : INK3),
            callback: (value) =>
              (over[value] ? "\u25b2 " : "") + (rows[value]?.category ?? ""),
          },
        },
      },
    },
  });
}

/** `total` is the period's total net expense (aggregate().expense - the same
    figure as the Expense KPI and the "Spend by category" Total row), so each
    share is of ALL spend that period, not of the top five alone. */
export function topFive(top5, total = 0) {
  readTheme();
  const share = (v) => (total > 0 ? ((v / total) * 100).toFixed(1) + "%" : "");
  const colors = distinctCategoryColors(top5.map((t) => t.category));
  mount(
    "c-top",
    {
      type: "bar",
      data: {
        // Two-line tick: the name, then its share of total spend.
        labels: top5.map((t) => [t.category, share(t.actual)]),
        datasets: [
          {
            data: top5.map((t) => t.actual),
            backgroundColor: top5.map((t) => colors.get(t.category).hex),
            hoverBackgroundColor: top5.map((t) =>
              lighten(colors.get(t.category).hex, 0.3),
            ),
            hoverBorderColor: CARD,
            hoverBorderWidth: 2,
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => top5[items[0].dataIndex]?.category || "",
              label: (item) =>
                `${money0(item.raw)}` +
                (total > 0 ? ` \u00b7 ${share(item.raw)}` : ""),
              footer: () =>
                total > 0 ? `% of total spend (${money0(total)})` : "",
            },
          },
        },
        scales: { x: { ...gridX, ticks: { font: { size: 10 } } }, y: gridY },
      },
    },
    true,
  );
}

/** 100%-stacked share of spend by month (+ a separated Year column). `model`
    is xlsxio.categoryShare(): rows[] of {category, amounts[13], shares[13]}
    where index 12 is the full year. Column 12 of the chart is a blank gap so
    Year reads as its own bar. */
export function categoryShare(model, months) {
  readTheme();
  const narrow = window.matchMedia("(max-width: 640px)").matches;
  const GAP = 12;
  const colors = distinctCategoryColors(
    model.rows.filter((r) => !r.other).map((r) => r.category),
  );
  const pad = (a) => [...a.slice(0, 12), null, a[12]];
  mount(
    "c-cat-share",
    {
      type: "bar",
      data: {
        labels: [...months, "", "Year"],
        datasets: model.rows.map((r) => {
          const base = r.other ? INK3 : colors.get(r.category).hex;
          return {
            label: r.category,
            data: pad(r.shares.map((v) => (v === null ? null : v * 100))),
            amounts: pad(r.amounts),
            backgroundColor: base,
            hoverBackgroundColor: lighten(base, 0.3),
            borderColor: CARD,
            borderWidth: 1,
            hoverBorderColor: CARD,
            hoverBorderWidth: 2,
            borderSkipped: false,
          };
        }),
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        interaction: { mode: "nearest", intersect: true },
        plugins: {
          legend: {
            ...legendTop.legend,
            labels: {
              boxWidth: narrow ? 8 : 10,
              boxHeight: narrow ? 8 : 10,
              padding: narrow ? 8 : 14,
              font: { size: narrow ? 10 : 11 },
            },
          },
          tooltip: {
            callbacks: {
              title: (items) => items[0].label,
              label: (item) =>
                `${item.dataset.label}: ${money0(item.dataset.amounts[item.dataIndex])} \u00b7 ${item.parsed.y.toFixed(1)}%`,
              footer: (items) => {
                const i = items[0].dataIndex;
                if (i === GAP) return "";
                const t = model.totals[i === 13 ? 12 : i];
                return `Total spend ${money0(t)} (= 100%)`;
              },
            },
          },
        },
        scales: {
          x: {
            ...gridX,
            stacked: true,
            ticks: { font: { size: narrow ? 9 : 10 }, autoSkip: false },
          },
          y: {
            ...gridY,
            stacked: true,
            min: 0,
            max: 100,
            ticks: { callback: (v) => v + "%", stepSize: narrow ? 50 : 25 },
          },
        },
      },
    },
    true,
  );
}

export function paymentSplit(byPayment) {
  readTheme();
  const colors = paymentColors(byPayment.map((p) => p.method));
  mount("c-pay", {
    type: "doughnut",
    data: {
      labels: byPayment.map((p) => p.method),
      datasets: [
        {
          data: byPayment.map((p) => p.amount),
          backgroundColor: byPayment.map((p) => colors.get(p.method).hex),
          borderColor: CARD,
          borderWidth: 2,
          // The hovered slice pushes outward by this many px - Chart.js's
          // built-in doughnut/pie hover affordance, not a custom animation;
          // the 200ms ease-out transition set in mount() is what makes that
          // push feel smooth rather than an instant jump.
          hoverOffset: 14,
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
          labels: { boxWidth: 10, boxHeight: 10, padding: 10 },
        },
      },
    },
  });
}

/* ---- person comparison ---------------------------------------------------- */
const PERSON_COLORS = {
  Ramesh: TEAL,
  Surya: BLUE,
  Family: AMBER,
  Unassigned: SAND,
};
const colorFor = (p) => PERSON_COLORS[p] || SAND;

export function personSplit(breakdown) {
  readTheme();
  mount("c-person-split", {
    type: "doughnut",
    data: {
      labels: breakdown.map((b) => b.person),
      datasets: [
        {
          data: breakdown.map((b) => b.expense),
          backgroundColor: breakdown.map((b) => colorFor(b.person)),
          borderColor: CARD,
          borderWidth: 2,
          hoverOffset: 14,
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
          labels: { boxWidth: 10, boxHeight: 10, padding: 10 },
        },
      },
    },
  });
}

export function personByMonth(series, months) {
  readTheme();
  mount("c-person-month", {
    type: "bar",
    data: {
      labels: months,
      datasets: series.map((s) => ({
        label: s.person,
        data: s.data,
        backgroundColor: colorFor(s.person),
        hoverBackgroundColor: lighten(colorFor(s.person), 0.3),
        hoverBorderColor: CARD,
        hoverBorderWidth: 2,
      })),
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: legendTop,
      scales: {
        x: { ...gridX, stacked: false },
        y: { ...gridY, stacked: false },
      },
    },
  });
}

export function categoryByMonth(
  series,
  months,
  filterMonth = 0,
  orientation = "horizontal",
) {
  readTheme();
  // Sankey needs flat {from, to, flow} triples rather than the per-category
  // monthly-array shape the rest of the dashboard uses, and skips exact
  // zeros (a zero-flow link still draws as a visible sliver in this plugin).
  // A month picked in the dropdown scopes the diagram down to just that
  // month's flows entirely, rather than dimming the others - with a whole
  // year's flows removed, what's left is one month feeding straight into
  // its categories.
  const flows = [];
  for (const s of series)
    for (let i = 0; i < s.data.length; i++)
      if (s.data[i] > 0 && (filterMonth === 0 || i + 1 === filterMonth))
        flows.push({ from: months[i], to: s.category, flow: s.data[i] });

  // Coloured by category (the "to" side), so each category reads as one
  // consistent colour everywhere it appears - the same category is always
  // the same colour whichever month it flowed from, and the same colour as
  // in Top 5 / Category share (ranked here by the year's spend).
  const yearTotal = (s) => s.data.reduce((a, v) => a + (v > 0 ? v : 0), 0);
  const catColors = distinctCategoryColors(
    series
      .filter((s) => yearTotal(s) > 0)
      .sort((a, b) => yearTotal(b) - yearTotal(a))
      .map((s) => s.category),
  );
  const flowColor = (cat) => catColors.get(cat)?.hex ?? INK3;

  // Left/top-column nodes (months) default to being stacked by value,
  // largest first - not calendar order. `priority` overrides that per node
  // key. Verified empirically (rendered both orientations and read the
  // actual output) rather than trusting the docs: LOWER priority sorts
  // earlier - toward the top in horizontal mode, toward the left in
  // vertical mode - so Jan needs the lowest number and Dec the highest for
  // Jan...Dec to read in the natural direction either way. Only month keys
  // need an entry here - categories (the "to" side) are left on their
  // default value-sorted order, which is the more useful ordering there.
  const monthPriority = {};
  months.forEach((m, i) => (monthPriority[m] = i));

  mount("c-cat-month", {
    type: "sankey",
    data: {
      datasets: [
        {
          label: "Category spend by month",
          data: flows,
          // Chart.js's sankey controller calls colorFrom/colorTo at least
          // once during its internal label-building pass even when `flows`
          // is empty (a brand-new account with zero transactions, or a
          // month-filtered view where that month has nothing) - with no
          // data point at that index, c.dataset.data[c.dataIndex] is
          // undefined, and reading .to off that threw an uncaught
          // TypeError that broke the chart entirely instead of just
          // rendering empty. Falling back to a neutral colour for that case
          // costs nothing visible (there's nothing to colour) and avoids
          // the crash regardless of why Chart.js asks for a colour with no
          // matching data.
          colorFrom: (c) => {
            const f = c.dataset.data[c.dataIndex];
            return f ? flowColor(f.to) : INK3;
          },
          colorTo: (c) => {
            const f = c.dataset.data[c.dataIndex];
            return f ? flowColor(f.to) : INK3;
          },
          colorMode: "to",
          alpha: 0.75,
          color: INK,
          font: { size: 10 },
          orientation: orientation === "vertical" ? "vertical" : "horizontal",
          priority: monthPriority,
          // Vertical gap between nodes stacked in the same column - the
          // library's default is tight enough that adjacent category labels
          // in a full-year, ~18-category diagram can visually run together.
          nodePadding: 14,
          // Node labels sit right where flow ribbons converge, so on a busy
          // multi-colour diagram (18 categories x 12 months) plain text
          // reads as illegible noise against the ribbons behind it. A solid
          // background chip behind each label keeps it readable regardless
          // of what colour ribbon happens to pass underneath.
          labels: {
            backgroundColor: "rgba(255, 255, 255, 0.9)",
            borderRadius: 3,
            padding: 4,
            // Fixed dark ink: the chip stays light in both themes.
            color: "#12161c",
            font: { size: 11, weight: "600" },
          },
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) =>
              `${item.raw.from} \u2192 ${item.raw.to}: ${money0(item.raw.flow)}`,
          },
        },
      },
    },
  });
}

export function personVsBudget(rows) {
  readTheme();
  mount("c-person-cat", {
    type: "bar",
    data: {
      labels: rows.map((r) => r.category),
      datasets: rows[0]
        ? Object.keys(rows[0].byPerson).map((p) => ({
            label: p,
            data: rows.map((r) => r.byPerson[p] || 0),
            backgroundColor: colorFor(p),
            hoverBackgroundColor: lighten(colorFor(p), 0.3),
            hoverBorderColor: CARD,
            hoverBorderWidth: 2,
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
  readTheme();
  mount("c-nw-trend", {
    type: "line",
    data: {
      labels: series.map((s) => s.date),
      datasets: [
        {
          label: "Net worth",
          data: series.map((s) => s.net),
          borderColor: INK,
          backgroundColor: withAlpha(INK, 0.08),
          borderWidth: 3,
          fill: "origin",
          tension: 0.25,
          pointRadius: 4,
          pointHoverRadius: 7,
          pointHoverBackgroundColor: CARD,
          pointHoverBorderColor: INK,
          pointHoverBorderWidth: 2,
        },
        // Assets / liabilities differ in dash and point shape as well as
        // colour (teal triangles, dashed / red diamonds, dotted).
        {
          label: "Assets",
          data: series.map((s) => s.assets),
          borderColor: PAL.income,
          backgroundColor: PAL.income,
          borderDash: [6, 4],
          pointStyle: "triangle",
          pointRadius: 3,
          pointHoverRadius: 5,
        },
        {
          label: "Liabilities",
          data: series.map((s) => s.liabs),
          borderColor: PAL.expense,
          backgroundColor: PAL.expense,
          borderDash: [2, 3],
          pointStyle: "rectRot",
          pointRadius: 3,
          pointHoverRadius: 5,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: {
        legend: {
          ...legendTop.legend,
          labels: { ...legendTop.legend.labels, usePointStyle: true },
        },
      },
      scales: { x: gridX, y: gridY },
    },
  });
}

export function assetSplit(assets) {
  readTheme();
  const rows = assets
    .filter((a) => Number(a.balance) > 0)
    .sort((a, b) => b.balance - a.balance);
  // Same name -> same colour as the account's icon badge elsewhere; beyond 8
  // accounts the families run out and the rest keep their own colour.
  const colors = distinctColors(
    rows.map((a) => a.account),
    { stable: true },
  );
  mount("c-nw-split", {
    type: "doughnut",
    data: {
      labels: rows.map((a) => a.account),
      datasets: [
        {
          data: rows.map((a) => Number(a.balance)),
          backgroundColor: rows.map((a) => colors.get(a.account).hex),
          borderColor: CARD,
          borderWidth: 2,
          hoverOffset: 14,
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
  readTheme();
  mount("c-dividends", {
    type: "bar",
    data: {
      labels: series.map((s) => s.month),
      datasets: [
        {
          label: "Dividends",
          data: series.map((s) => s.dividends || 0),
          backgroundColor: PAL.dividend,
          hoverBackgroundColor: lighten(PAL.dividend, 0.3),
          hoverBorderColor: CARD,
          hoverBorderWidth: 2,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { x: gridX, y: gridY },
    },
  });
}
