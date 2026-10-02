/* Precious metals tracking: purchase-lot math for the Net Worth page's
   "Precious metals" section. Rendering and store-wiring live in this same
   file (renderMetalsSection/wireMetalsHandlers), added in a later task -
   this file starts with the pure math so it can be checked independently
   of any DOM. */
import { PEOPLE } from "../constants.js";
import { money, pct } from "../xlsxio.js";
import { $, view, esc, state, kpi, notice, withBusy } from "../core.js";
import { isRemoteStore } from "../auth.js";
import { emptyIcon } from "../icons.js";

/** A purchase receipt usually shows a total amount paid, not a price/gram -
    that division is on you to do by hand, which is exactly the kind of
    arithmetic this app should do instead. Every lot is still STORED as
    pricePerGram (that's what metalsSummary/priceAppreciation and the schema
    already key off, and per-gram is what lets lots of different weights
    average together correctly) - this just accepts a total purchase price
    as an alternative way to arrive at that number. When a total is given,
    it always wins over a manually-typed price/gram, since the receipt's
    total is the more authoritative number (a typed price/gram could be a
    stale or misremembered rate; the total is what was actually paid).
    Returns null if neither a usable price/gram nor a usable total was
    given, so the caller can refuse to save rather than guess. */
export function resolvePricePerGram({ weightGrams, pricePerGram, purchasePrice }) {
  if (!(weightGrams > 0)) return null;
  if (purchasePrice !== null && purchasePrice !== undefined && purchasePrice !== "") {
    const total = Number(purchasePrice);
    return total >= 0 ? total / weightGrams : null;
  }
  if (pricePerGram !== null && pricePerGram !== undefined && pricePerGram !== "") {
    const perGram = Number(pricePerGram);
    return perGram >= 0 ? perGram : null;
  }
  return null;
}

/** Value, average cost, and unrealized gain across all lots, valued at
    latestPrice. Lots are purchase transactions (see supabase/schema.sql's
    precious_metal_holdings comment) - average cost is always the
    weighted average across every lot ever bought, never a stored running
    total, so it can't drift from the lots that produced it. */
export function metalsSummary(holdings, latestPrice) {
  const totalGrams = holdings.reduce((s, h) => s + h.weightGrams, 0);
  const totalCost = holdings.reduce(
    (s, h) => s + h.weightGrams * h.pricePerGram,
    0,
  );
  const avgCostPerGram = totalGrams > 0 ? totalCost / totalGrams : 0;
  const pricePerGram = latestPrice ? latestPrice.pricePerGramCad : 0;
  const value = totalGrams * pricePerGram;
  const unrealizedGain = latestPrice ? value - totalCost : 0;
  const unrealizedGainPct =
    latestPrice && totalCost > 0 ? unrealizedGain / totalCost : 0;
  return {
    totalGrams,
    value,
    avgCostPerGram,
    unrealizedGain,
    unrealizedGainPct,
  };
}

/** How far the market price has moved since your first purchase, using the
    earliest gold_price_history row on/after your first lot's purchase
    date as the baseline - the closest available proxy for "the market
    price on the day you bought", since the daily fetch may not have
    existed yet on that date. Falls back to the single earliest price
    point ever recorded if none exists on/after that date, with sinceLabel
    reflecting which baseline was actually used so the UI can be honest
    about it. */
export function priceAppreciation(holdings, priceHistory, latestPrice) {
  if (!holdings.length || !latestPrice || !priceHistory.length) return null;

  const firstPurchaseDate = holdings.map((h) => h.purchaseDate).sort()[0];

  const sorted = [...priceHistory].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const onOrAfter = sorted.find((p) => p.date >= firstPurchaseDate);
  const baseline = onOrAfter || sorted[0];

  const appreciationPct =
    baseline.pricePerGramCad > 0
      ? (latestPrice.pricePerGramCad - baseline.pricePerGramCad) /
        baseline.pricePerGramCad
      : 0;

  return {
    baselinePrice: baseline.pricePerGramCad,
    baselineDate: baseline.date,
    appreciationPct,
    sinceLabel: onOrAfter
      ? `since your first purchase (${firstPurchaseDate})`
      : `since tracking began (${baseline.date})`,
  };
}

/** "Precious metals" section on the Net Worth page: 4 KPI tiles, a lots
    table, and an add-lot form. Mirrors renderDebtSection/wireDebtHandlers
    in debts.js - a returned HTML string plus a separate wiring function
    called once that HTML is actually in the DOM. */
export function renderMetalsSection(scopeOwner) {
  if (!isRemoteStore(state.store)) {
    return `
    <div class="eyebrow">Precious metals</div>
    <div class="nw-warn">
      <b>Not connected to Supabase.</b> Precious metals tracking needs a
      Supabase backend for the daily price feed. Connect under
      <b>Data &rarr; Supabase</b> to use this section.
    </div>`;
  }

  const holdings = (state.metalHoldings || []).filter(
    (h) => !scopeOwner || h.owner === scopeOwner,
  );
  const latestPrice = state.goldPrice || null;
  const summary = metalsSummary(holdings, latestPrice);
  const appreciation = priceAppreciation(
    holdings,
    state.goldPriceHistory || [],
    latestPrice,
  );

  const tiles = !latestPrice
    ? `<div class="kpis">
      ${kpi("Value", "—", "no price data yet")}
      ${kpi("Avg cost/gram", "—", "no price data yet")}
      ${kpi("Unrealized gain", "—", "no price data yet")}
      ${kpi("Price appreciation", "—", "no price data yet")}
    </div>
    <p class="note">No price data yet &mdash; the daily price fetch hasn't run.</p>`
    : `<div class="kpis">
      ${kpi("Value", money(summary.value), `${summary.totalGrams.toFixed(1)}g @ ${money(latestPrice.pricePerGramCad)}/g`)}
      ${kpi("Avg cost/gram", money(summary.avgCostPerGram), `${holdings.length} lot${holdings.length === 1 ? "" : "s"}`)}
      ${kpi(
        "Unrealized gain",
        (summary.unrealizedGain >= 0 ? "+" : "") +
          money(summary.unrealizedGain),
        pct(summary.unrealizedGainPct),
        summary.unrealizedGain < 0 ? "neg" : "pos",
      )}
      ${
        appreciation
          ? kpi(
              "Price appreciation",
              (appreciation.appreciationPct >= 0 ? "+" : "") +
                pct(appreciation.appreciationPct),
              appreciation.sinceLabel,
              appreciation.appreciationPct < 0 ? "neg" : "pos",
            )
          : kpi("Price appreciation", "—", "not enough data")
      }
    </div>`;

  const rows = holdings
    .map((h) => {
      const valueToday = latestPrice
        ? h.weightGrams * latestPrice.pricePerGramCad
        : null;
      return `<tr>
        <td class="num">${esc(h.purchaseDate)}</td>
        <td>${esc(h.metal)}</td>
        <td><span class="person-chip" data-p="${esc(h.owner)}">${esc(h.owner)}</span></td>
        <td class="n num">${h.weightGrams}g</td>
        <td class="n num">${money(h.pricePerGram)}</td>
        <td class="n num muted">${money(h.weightGrams * h.pricePerGram)}</td>
        <td class="n num">${valueToday === null ? "—" : money(valueToday)}</td>
        <td><button class="rowbtn" data-delmetal="${h.id}" title="Delete this lot">✕</button></td>
      </tr>`;
    })
    .join("");

  return `
  <div class="eyebrow">Precious metals</div>
  ${tiles}
  ${
    holdings.length
      ? `<div class="tablewrap"><table><thead><tr>
      <th>Date</th><th>Metal</th><th>Owner</th><th class="n">Weight</th>
      <th class="n">Price paid/g</th><th class="n">Total paid</th><th class="n">Value today</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty">${emptyIcon()}<span>No precious metal holdings recorded. Add a purchase lot below.</span></div>`
  }

  <div class="panel" style="margin-top:12px">
    <form id="metal-add-form" class="nw-add-row" autocomplete="off">
      <label class="f"><span>Metal</span>
        <select name="metal"><option>Gold</option></select></label>
      <label class="f"><span>Weight (grams)</span>
        <input type="number" name="weightGrams" id="metal-weight" step="0.001" min="0.001" required placeholder="e.g. 10"></label>
      <label class="f"><span>Purchase price (total)</span>
        <input type="number" name="purchasePrice" id="metal-total" step="0.01" min="0" placeholder="e.g. 850.00"></label>
      <label class="f"><span>Price paid/gram</span>
        <input type="number" name="pricePerGram" id="metal-pergram" step="0.01" min="0" placeholder="or enter this instead"></label>
      <label class="f"><span>Purchase date</span>
        <input type="date" name="purchaseDate" value="${new Date().toISOString().slice(0, 10)}" required></label>
      <label class="f"><span>Owner</span>
        <select name="owner">${PEOPLE.map((p) => `<option>${esc(p)}</option>`).join("")}</select></label>
      <button class="btn" type="submit">Add lot</button>
    </form>
    <p class="note" id="metal-calc-hint" style="margin:8px 0 0"></p>
    <div class="err" id="metal-err"></div>
  </div>
  <p class="note">Value updates automatically from the daily gold price &mdash;
    you never need to re-enter it. This is separate from the by-account
    table above; it does not use a manual balance entry.</p>`;
}

export function wireMetalsHandlers() {
  const reload = async () => {
    state.metalHoldings = (await state.store.listMetalHoldings?.()) || [];
    const { renderNetWorth } = await import("./networth.js");
    renderNetWorth();
  };

  // Live calculator: as soon as there's enough to compute a price/gram
  // (weight + either field), show what will actually get saved, so a typo
  // in the total is caught before submitting rather than after.
  const updateCalcHint = () => {
    const hint = $("#metal-calc-hint");
    if (!hint) return;
    const weightGrams = Number($("#metal-weight")?.value);
    const purchasePrice = $("#metal-total")?.value ?? "";
    const pricePerGramInput = $("#metal-pergram")?.value ?? "";
    const resolved = resolvePricePerGram({
      weightGrams,
      pricePerGram: pricePerGramInput,
      purchasePrice,
    });
    if (resolved === null) {
      hint.textContent = "";
      return;
    }
    hint.textContent =
      purchasePrice !== ""
        ? `= ${money(resolved)}/gram (from ${money(Number(purchasePrice))} ÷ ${weightGrams}g)`
        : `= ${money(resolved * weightGrams)} total (${weightGrams}g × ${money(resolved)}/g)`;
  };
  ["metal-weight", "metal-total", "metal-pergram"].forEach((id) =>
    $("#" + id)?.addEventListener("input", updateCalcHint),
  );

  $("#metal-add-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    const weightGrams = Number(f.weightGrams);
    if (!(weightGrams > 0))
      return ($("#metal-err").textContent =
        "Weight must be greater than zero.");
    const pricePerGram = resolvePricePerGram({
      weightGrams,
      pricePerGram: f.pricePerGram,
      purchasePrice: f.purchasePrice,
    });
    if (pricePerGram === null)
      return ($("#metal-err").textContent =
        "Enter either the total purchase price or the price paid per gram (not negative).");
    const done = await withBusy("Adding lot", async () => {
      await state.store.addMetalHolding({
        metal: f.metal,
        weightGrams,
        pricePerGram,
        purchaseDate: f.purchaseDate,
        owner: f.owner,
        notes: "",
      });
    });
    if (done) {
      await reload();
      notice(`Added ${weightGrams}g of ${f.metal}.`, "ok");
    }
  });

  view.querySelectorAll("[data-delmetal]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm("Delete this precious metal lot?")) return;
        const done = await withBusy("Deleting lot", async () => {
          await state.store.deleteMetalHolding(Number(b.dataset.delmetal));
        });
        if (done) {
          await reload();
          notice("Lot deleted.", "ok");
        }
      }),
  );
}
