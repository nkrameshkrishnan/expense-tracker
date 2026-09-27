/* Wealthsimple's own "activities export" CSV — a very different shape from
   this app's own transaction table (which importFile()/HEADER_ALIASES in
   xlsxio.js already handles): one row per *brokerage activity*, not per
   spending transaction, with columns like activity_type/activity_sub_type/
   net_cash_amount rather than date/amount. Feeding it through the generic
   importer finds no recognised date/amount columns at all and throws.

   Per the user's own choice (a "no preference" answer to which rows should
   count, so this is the maintainer's stated default rather than a guess
   made silently): only cash movements are imported, since a Trade or Tax
   row does not represent real household income or spending -
     - MoneyMovement (deposits, e-Transfers, EFTs in/out of the account) and
       Interest both become a Transfer/Income-shaped row - money crossing
       the account boundary, not new spending.
     - Dividend rows become this app's existing "Dividends" type, so they
       still show up in the Dashboard's dividends total.
     - Trade (buying/selling a holding) and Tax (non-resident withholding)
       are skipped entirely - a $140 BUY is money moving from cash to a
       security the household already owns, not an expense, and importing
       it as one would overstate real spending for the month. */

const CASH_MOVEMENT = "cash movements (deposits, e-Transfers, EFTs, interest)";
const SKIPPED_KINDS = new Set(["Trade", "Tax"]);

/** True only for a Wealthsimple activities-export header row - checked
    before the generic date/amount column scan in xlsxio.js's importFile()
    so a Wealthsimple file is routed here instead of failing with "No sheet
    had both a Date and an Amount column." */
export function looksLikeWealthsimpleCsv(headerRow) {
  const h = new Set(
    (headerRow || []).map((c) =>
      String(c ?? "")
        .trim()
        .toLowerCase(),
    ),
  );
  return (
    h.has("effective_date") &&
    h.has("activity_type") &&
    h.has("net_cash_amount")
  );
}

// SheetJS auto-detects an ISO-shaped date string ("2026-09-01") even when
// reading a plain CSV and silently converts it to an Excel serial number
// (cellDates:false only controls Date-object vs serial, not whether the
// conversion happens at all) - so effective_date/settlement_date arrive as
// numbers, not the strings this file's own export shows. Duplicated here
// (rather than imported from xlsxio.js) to avoid a circular import, since
// xlsxio.js imports this module.
function excelSerialToISO(v) {
  const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
  return d.toISOString().slice(0, 10);
}

function typeFor(activityType) {
  if (activityType === "Dividend") return "Dividends";
  if (activityType === "Interest") return "Income";
  return "Transfer"; // MoneyMovement (deposit, e-Transfer, EFT, ...)
}

/** aoa is a raw array-of-arrays (XLSX.utils.sheet_to_json(..., {header:1})
    result) whose first row is the Wealthsimple header. Returns the same
    {rows, skipped, reasons} shape every other importer in this app returns,
    ready to feed straight into the staged-review table. */
export function parseWealthsimpleCsv(aoa, normalise) {
  const header = (aoa[0] || []).map((c) =>
    String(c ?? "")
      .trim()
      .toLowerCase(),
  );
  const idx = {};
  header.forEach((h, i) => (idx[h] = i));
  const get = (raw, key) => (idx[key] === undefined ? "" : raw[idx[key]]);

  const rows = [];
  let skipped = 0;
  let tradesAndTaxSkipped = 0;

  for (let i = 1; i < aoa.length; i++) {
    const raw = aoa[i] || [];
    if (!raw.some((c) => c !== "" && c != null)) continue;

    const activityType = String(get(raw, "activity_type") || "").trim();
    if (SKIPPED_KINDS.has(activityType)) {
      tradesAndTaxSkipped++;
      continue;
    }

    const rawDate = get(raw, "effective_date");
    const date =
      typeof rawDate === "number"
        ? excelSerialToISO(rawDate)
        : String(rawDate || "")
            .trim()
            .slice(0, 10);
    const amount = Number(get(raw, "net_cash_amount"));
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !isFinite(amount) ||
      amount === 0
    ) {
      skipped++;
      continue;
    }

    const description = String(get(raw, "description") || "").trim();
    const account = String(get(raw, "account_type") || "").trim();

    rows.push(
      normalise({
        date,
        type: typeFor(activityType),
        category: "",
        subcategory:
          activityType === "Dividend" ? String(get(raw, "symbol") || "") : "",
        description: description || activityType,
        amount,
        payment: "",
        account,
        recurring: "No",
        notes: "",
        person: "",
      }),
    );
  }

  const reasons = [];
  if (skipped) reasons.push("rows with no readable date or amount");
  if (tradesAndTaxSkipped)
    reasons.push(
      `${tradesAndTaxSkipped} trade/tax activit${tradesAndTaxSkipped === 1 ? "y" : "ies"} (not ${CASH_MOVEMENT}, skipped on purpose)`,
    );

  return { rows, skipped: skipped + tradesAndTaxSkipped, reasons };
}
