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

export const METALS = ["Gold", "Silver", "Diamond"];

/** Gold purity options. The daily feed is the 24-karat (pure) spot price, so
    every other karat is valued at karat/24 of it (22K = 91.67%, 18K = 75%). */
export const KARATS = [24, 22, 21, 18, 14, 10];
/** Silver purity is "fineness" in parts per thousand: 999 fine silver, 925
    sterling, and so on. The daily feed is pure (999.9) silver. */
export const FINENESS = [999, 958, 925, 900, 800];
/** Diamonds are bought by the carat; lots are stored in grams like every
    other metal (1 carat = 0.2 g) so the schema stays one shape. */
export const CARAT_GRAMS = 0.2;
export const gramsToCarats = (g) => Number((g / CARAT_GRAMS).toFixed(3));

/** Fraction of a gold lot's weight that is actual gold. Missing/invalid
    purity (rows saved before the column existed) is treated as 24K, which
    is what those rows were already being valued as. */
export function purityFraction(karat) {
  const k = Number(karat);
  return k > 0 && k <= 24 ? k / 24 : 1;
}
export function silverFraction(fineness) {
  const f = Number(fineness);
  return f > 0 && f <= 1000 ? f / 1000 : 0.999;
}
/** Pure-metal fraction of a lot (diamonds have no spot-price purity). */
export function lotFraction(h) {
  if (h.metal === "Silver") return silverFraction(h.purityFineness);
  if (h.metal === "Diamond") return 1;
  return purityFraction(h.purityKarat);
}
export const lotCost = (h) => h.weightGrams * h.pricePerGram;

/** Today's value of one lot. Gold/silver: pure weight x spot price for that
    metal, or null when no price has been fetched yet. Diamonds have no
    market feed, so they use the current value you entered, falling back to
    what you paid (zero gain) when you haven't estimated one. */
export function lotValue(h, prices) {
  if (h.metal === "Diamond")
    return h.currentValue !== null && h.currentValue !== undefined
      ? Number(h.currentValue)
      : lotCost(h);
  const p = prices && prices[h.metal || "Gold"];
  if (!p) return null;
  return h.weightGrams * lotFraction(h) * p.pricePerGramCad;
}

/** Value, average cost, and unrealized gain across lots. `prices` maps metal
    -> {pricePerGramCad}; a bare {pricePerGramCad} (the old single-gold
    shape) or null is also accepted. Lots are purchase transactions, so
    average cost is always derived from them, never a stored running total. */
export function metalsSummary(holdings, prices) {
  if (prices && prices.pricePerGramCad !== undefined) prices = { Gold: prices };
  const weighed = holdings.filter((h) => h.metal !== "Diamond");
  const totalGrams = weighed.reduce((s, h) => s + h.weightGrams, 0);
  const weighedCost = weighed.reduce((s, h) => s + lotCost(h), 0);
  const avgCostPerGram = totalGrams > 0 ? weighedCost / totalGrams : 0;
  const fineGrams = weighed.reduce(
    (s, h) => s + h.weightGrams * lotFraction(h),
    0,
  );
  const totalCost = holdings.reduce((s, h) => s + lotCost(h), 0);
  let value = 0;
  let valuedCost = 0;
  for (const h of holdings) {
    const v = lotValue(h, prices);
    if (v === null) continue;
    value += v;
    valuedCost += lotCost(h);
  }
  const unrealizedGain = value - valuedCost;
  return {
    totalGrams,
    fineGrams,
    value,
    totalCost,
    avgCostPerGram,
    unrealizedGain,
    unrealizedGainPct: valuedCost > 0 ? unrealizedGain / valuedCost : 0,
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

/** Id of the lot currently loaded into the form for editing, or null when
    the form is adding a new lot. Module state, so it survives the
    re-render that follows Edit/Cancel. */
let editingLotId = null;
/** "All" or one metal: which lots the tiles and table show. */
let metalFilter = "All";

const rerenderNetWorth = async () => {
  const { renderNetWorth } = await import("./networth.js");
  renderNetWorth();
};
const sel = (cond) => (cond ? " selected" : "");

/** "Precious metals" section on the Net Worth page: KPI tiles, a lots table,
    and an add/edit-lot form. Mirrors renderDebtSection/wireDebtHandlers in
    debts.js - a returned HTML string plus a separate wiring function called
    once that HTML is actually in the DOM. */
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

  const owned = (state.metalHoldings || []).filter(
    (h) => !scopeOwner || h.owner === scopeOwner,
  );
  const editing = owned.find((h) => h.id === editingLotId) || null;
  if (!editing) editingLotId = null;
  const holdings = owned.filter(
    (h) => metalFilter === "All" || h.metal === metalFilter,
  );
  const prices = state.metalPrices || { Gold: state.goldPrice || null };
  const history = state.metalPriceHistory || {
    Gold: state.goldPriceHistory || [],
  };
  const summary = metalsSummary(holdings, prices);
  const single = metalFilter === "Gold" || metalFilter === "Silver";
  const latestPrice = single ? prices[metalFilter] || null : null;
  const appreciation = single
    ? priceAppreciation(holdings, history[metalFilter] || [], latestPrice)
    : null;
  const needsFeed = holdings.some((h) => h.metal !== "Diamond");
  const missingFeed = single && !latestPrice;

  const gainTile = kpi(
    "Unrealized gain",
    (summary.unrealizedGain >= 0 ? "+" : "") + money(summary.unrealizedGain),
    pct(summary.unrealizedGainPct),
    summary.unrealizedGain < 0 ? "neg" : "pos",
  );
  const lotsLabel = `${holdings.length} lot${holdings.length === 1 ? "" : "s"}`;
  const valueSub = single
    ? latestPrice
      ? `${summary.totalGrams.toFixed(1)}g (${summary.fineGrams.toFixed(1)}g pure) @ ${money(latestPrice.pricePerGramCad)}/g pure`
      : "no price data yet"
    : lotsLabel;
  const tiles = missingFeed
    ? `<div class="kpis">
      ${kpi("Value", "—", "no price data yet")}
      ${kpi("Avg cost/gram", "—", "no price data yet")}
      ${kpi("Unrealized gain", "—", "no price data yet")}
      ${kpi("Price appreciation", "—", "no price data yet")}
    </div>
    <p class="note">No ${esc(metalFilter.toLowerCase())} price data yet &mdash; the daily price fetch hasn't run.</p>`
    : `<div class="kpis">
      ${kpi("Value", money(summary.value), valueSub)}
      ${
        single
          ? kpi("Avg cost/gram", money(summary.avgCostPerGram), lotsLabel)
          : kpi("Total paid", money(summary.totalCost), lotsLabel)
      }
      ${gainTile}
      ${
        single
          ? appreciation
            ? kpi(
                "Price appreciation",
                (appreciation.appreciationPct >= 0 ? "+" : "") +
                  pct(appreciation.appreciationPct),
                appreciation.sinceLabel,
                appreciation.appreciationPct < 0 ? "neg" : "pos",
              )
            : kpi("Price appreciation", "—", "not enough data")
          : ""
      }
    </div>
    ${
      !single && needsFeed && Object.values(prices).every((p) => !p)
        ? `<p class="note">No price data yet &mdash; the daily price fetch hasn't run.</p>`
        : ""
    }`;

  const rows = holdings
    .map((h) => {
      const dia = h.metal === "Diamond";
      const v = lotValue(h, prices);
      const purity = dia
        ? "—"
        : h.metal === "Silver"
          ? `${esc(h.purityFineness || 999)}`
          : `${esc(h.purityKarat || 24)}K`;
      const estimated = dia && (h.currentValue === null || h.currentValue === undefined);
      return `<tr>
        <td class="num">${esc(h.purchaseDate)}</td>
        <td>${esc(h.metal)}</td>
        <td class="num">${purity}</td>
        <td>${h.placeOfPurchase ? esc(h.placeOfPurchase) : '<span class="muted">—</span>'}</td>
        <td><span class="person-chip" data-p="${esc(h.owner)}">${esc(h.owner)}</span></td>
        <td class="n num">${dia ? `${gramsToCarats(h.weightGrams)} ct` : `${h.weightGrams}g`}</td>
        <td class="n num">${dia ? "—" : money(h.pricePerGram)}</td>
        <td class="n num muted">${money(lotCost(h))}</td>
        <td class="n num">${v === null ? "—" : money(v)}${estimated ? ' <span class="muted" title="No current value entered - showing what you paid">(at cost)</span>' : ""}</td>
        <td class="nowrap"><button class="rowbtn" data-editmetal="${h.id}" title="Edit this lot">Edit</button>
          <button class="rowbtn" data-delmetal="${h.id}" title="Delete this lot">✕</button></td>
      </tr>`;
    })
    .join("");

  const fm = editing ? editing.metal : "Gold";
  const show = (m) => (fm === m ? "" : " hidden");
  const showNot = (m) => (fm !== m ? "" : " hidden");
  const editWeight = editing
    ? editing.metal === "Diamond"
      ? gramsToCarats(editing.weightGrams)
      : editing.weightGrams
    : "";
  return `
  <div class="eyebrow">Precious metals</div>
  <label class="f" style="max-width:200px;margin-bottom:10px"><span>Show</span>
    <select id="metal-filter">${["All", ...METALS]
      .map((m) => `<option value="${m}"${sel(metalFilter === m)}>${m === "All" ? "All metals" : m}</option>`)
      .join("")}</select></label>
  ${tiles}
  ${
    holdings.length
      ? `<div class="tablewrap"><table><thead><tr>
      <th>Date</th><th>Metal</th><th>Purity</th><th>Purchased at</th><th>Owner</th><th class="n">Weight</th>
      <th class="n">Price paid/g</th><th class="n">Total paid</th><th class="n">Value today</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty">${emptyIcon()}<span>No ${metalFilter === "All" ? "precious metal" : esc(metalFilter.toLowerCase())} holdings recorded. Add a purchase lot below.</span></div>`
  }

  <div class="panel" style="margin-top:12px">
    <form id="metal-add-form" class="nw-add-row" autocomplete="off">
      <label class="f"><span>Metal</span>
        <select name="metal" id="metal-kind">${METALS.map((m) => `<option${sel(fm === m)}>${m}</option>`).join("")}</select></label>
      <label class="f" data-for="Gold"${show("Gold")}><span>Purity (karat)</span>
        <select name="purityKarat">${KARATS.map((k) => `<option value="${k}"${sel((editing && editing.metal === "Gold" ? Number(editing.purityKarat) : 24) === k)}>${k}K</option>`).join("")}</select></label>
      <label class="f" data-for="Silver"${show("Silver")}><span>Purity (fineness)</span>
        <select name="purityFineness">${FINENESS.map((k) => `<option value="${k}"${sel((editing && editing.metal === "Silver" ? Number(editing.purityFineness) : 999) === k)}>${k}${k === 925 ? " (sterling)" : ""}</option>`).join("")}</select></label>
      <label class="f"><span id="metal-weight-label">${fm === "Diamond" ? "Weight (carats)" : "Weight (grams)"}</span>
        <input type="number" name="weightGrams" id="metal-weight" step="0.001" min="0.001" required placeholder="e.g. 10"${editing ? ` value="${editWeight}"` : ""}></label>
      <label class="f"><span>Purchase price (total)</span>
        <input type="number" name="purchasePrice" id="metal-total" step="0.01" min="0" placeholder="e.g. 850.00"></label>
      <label class="f" data-for-not="Diamond"${showNot("Diamond")}><span>Price paid/gram</span>
        <input type="number" name="pricePerGram" id="metal-pergram" step="0.01" min="0" placeholder="or enter this instead"${editing && editing.metal !== "Diamond" ? ` value="${Number(editing.pricePerGram.toFixed(2))}"` : ""}></label>
      <label class="f" data-for="Diamond"${show("Diamond")}><span>Current value (estimate)</span>
        <input type="number" name="currentValue" step="0.01" min="0" placeholder="appraisal or your estimate"${editing && editing.currentValue !== null && editing.currentValue !== undefined ? ` value="${editing.currentValue}"` : ""}></label>
      <label class="f"><span>Place of purchase</span>
        <input type="text" name="placeOfPurchase" maxlength="120" placeholder="e.g. Costco, jeweller name"${editing ? ` value="${esc(editing.placeOfPurchase || "")}"` : ""}></label>
      <label class="f"><span>Purchase date</span>
        <input type="date" name="purchaseDate" value="${editing ? esc(editing.purchaseDate) : new Date().toISOString().slice(0, 10)}" required></label>
      <label class="f"><span>Owner</span>
        <select name="owner">${PEOPLE.map((p) => `<option${sel(editing && editing.owner === p)}>${esc(p)}</option>`).join("")}</select></label>
      <button class="btn" type="submit">${editing ? "Save changes" : "Add lot"}</button>
      ${editing ? '<button class="btn ghost" type="button" id="metal-cancel-edit">Cancel</button>' : ""}
    </form>
    ${editing ? `<p class="note" style="margin:8px 0 0"><b>Editing the ${esc(editing.purchaseDate)} ${esc(editing.metal.toLowerCase())} lot.</b> ${editing.metal === "Diamond" ? "" : "Price/gram is pre-filled; enter a total price to override it."}</p>` : ""}
    <p class="note" id="metal-calc-hint" style="margin:8px 0 0"></p>
    <div class="err" id="metal-err"></div>
  </div>
  <p class="note">Gold and silver update automatically from the daily spot price
    (24K gold, pure silver), scaled by each lot's purity (e.g. 22K = 22/24,
    sterling = 92.5%) &mdash; you never need to re-enter it. Diamonds have no
    market feed: enter a current value (appraisal or estimate) and update it
    when it changes; until then they count at what you paid.</p>`;
}

export function wireMetalsHandlers() {
  const reload = async () => {
    state.metalHoldings = (await state.store.listMetalHoldings?.()) || [];
    await rerenderNetWorth();
  };
  const form = $("#metal-add-form");

  // Show only the fields that apply to the chosen metal.
  const applyMetal = () => {
    if (!form) return;
    const m = form.elements["metal"].value;
    form.querySelectorAll("[data-for]").forEach((el) => {
      el.hidden = el.dataset.for !== m;
    });
    form.querySelectorAll("[data-for-not]").forEach((el) => {
      el.hidden = el.dataset.forNot === m;
    });
    const lbl = $("#metal-weight-label");
    if (lbl) lbl.textContent = m === "Diamond" ? "Weight (carats)" : "Weight (grams)";
    updateCalcHint();
  };

  // Live calculator: as soon as there's enough to compute a price/gram
  // (weight + either field), show what will actually get saved, so a typo
  // in the total is caught before submitting rather than after.
  function updateCalcHint() {
    const hint = $("#metal-calc-hint");
    if (!hint) return;
    if (form?.elements["metal"].value === "Diamond") {
      hint.textContent = "";
      return;
    }
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
  }
  ["metal-weight", "metal-total", "metal-pergram"].forEach((id) =>
    $("#" + id)?.addEventListener("input", updateCalcHint),
  );
  $("#metal-kind")?.addEventListener("change", applyMetal);
  applyMetal();

  $("#metal-filter")?.addEventListener("change", async (ev) => {
    metalFilter = ev.target.value;
    await rerenderNetWorth();
  });

  form?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    const err = (m) => ($("#metal-err").textContent = m);
    const dia = f.metal === "Diamond";
    const entered = Number(f.weightGrams);
    if (!(entered > 0))
      return err(`${dia ? "Weight (carats)" : "Weight"} must be greater than zero.`);
    const weightGrams = dia ? Number((entered * CARAT_GRAMS).toFixed(3)) : entered;
    if (!(weightGrams > 0)) return err("That weight is too small to record.");
    let pricePerGram;
    let currentValue = null;
    if (dia) {
      if (f.purchasePrice === "" || !(Number(f.purchasePrice) >= 0))
        return err("Enter the total price paid for the diamond.");
      pricePerGram = resolvePricePerGram({
        weightGrams,
        purchasePrice: f.purchasePrice,
      });
      if (f.currentValue !== "" && f.currentValue !== undefined) {
        currentValue = Number(f.currentValue);
        if (!(currentValue >= 0)) return err("Current value can't be negative.");
      }
    } else {
      pricePerGram = resolvePricePerGram({
        weightGrams,
        pricePerGram: f.pricePerGram,
        purchasePrice: f.purchasePrice,
      });
      if (pricePerGram === null)
        return err(
          "Enter either the total purchase price or the price paid per gram (not negative).",
        );
    }
    const lot = {
      metal: f.metal,
      weightGrams,
      pricePerGram,
      purityKarat: f.metal === "Gold" ? Number(f.purityKarat) || 24 : 24,
      purityFineness:
        f.metal === "Silver" ? Number(f.purityFineness) || 999 : null,
      currentValue,
      placeOfPurchase: (f.placeOfPurchase || "").trim(),
      purchaseDate: f.purchaseDate,
      owner: f.owner,
    };
    const wasEditing = editingLotId;
    const done = await withBusy(wasEditing ? "Saving lot" : "Adding lot", async () => {
      if (wasEditing) await state.store.updateMetalHolding(wasEditing, lot);
      else await state.store.addMetalHolding({ ...lot, notes: "" });
    });
    if (done) {
      editingLotId = null;
      await reload();
      notice(
        wasEditing
          ? "Lot updated."
          : `Added ${entered}${dia ? " ct" : "g"} of ${f.metal.toLowerCase()}.`,
        "ok",
      );
    }
  });

  view.querySelectorAll("[data-editmetal]").forEach(
    (b) =>
      (b.onclick = async () => {
        editingLotId = Number(b.dataset.editmetal);
        await rerenderNetWorth();
        $("#metal-add-form")?.scrollIntoView({ block: "center" });
      }),
  );
  $("#metal-cancel-edit")?.addEventListener("click", async () => {
    editingLotId = null;
    await rerenderNetWorth();
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
