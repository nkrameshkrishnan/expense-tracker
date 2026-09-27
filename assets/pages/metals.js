/* Precious metals tracking: purchase-lot math for the Net Worth page's
   "Precious metals" section. Rendering and store-wiring live in this same
   file (renderMetalsSection/wireMetalsHandlers), added in a later task -
   this file starts with the pure math so it can be checked independently
   of any DOM. */

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
