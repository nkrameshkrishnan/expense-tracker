/* Column-aware transaction extraction for a PDF whose statement is a real
   multi-column table with a labelled header row (DATE / TRANSACTIONS /
   DEBIT / CREDIT / RUNNING BALANCE, or TRANSACTION DATE / DETAILS /
   AMOUNT, etc.) - the shape CIBC's own "Online Banking" pages export to
   PDF when you print them. statement-parser.js's line-based approach
   can't handle these: a single logical transaction routinely spans 2-5
   different visual lines (a wrapped description, a date split across two
   lines, an amount that lands on whichever sub-line happens to be
   vertically level with it), so "date starts the line, amount ends it" -
   the rule that works for a normal one-line-per-transaction statement -
   simply isn't true here.

   The approach: find the header row and the x-position of each column
   label pdf.js reports. A transaction's date/description/amount is then
   whatever text is positioned in each column's x-range, but the RECORD
   BOUNDARIES (where one transaction ends and the next begins) can't be
   read off the date column, because date text itself can wrap across
   lines that don't line up with the amount. Instead, every record has
   exactly one dollar amount (that's what makes it a transaction row at
   all), so amounts are used as anchors: find every dollar-shaped item in
   an amount column, sort top-to-bottom, and the midpoint between two
   consecutive amounts is the boundary between their records. Every other
   item on the page is then assigned to whichever record's y-range it
   falls in, and to a column within that record by nearest x to a known
   column header - nearest-x rather than a fixed left/right cutoff, because
   a right-aligned number shifts further left the more digits it has
   ($1,904.13 starts well left of $6.55), so a fixed boundary tuned for one
   would misclassify the other. */
import { normalise, inferTypeFromSignAndDescription } from "./store.js";
import { groupItemsIntoLines } from "./pdfio.js";

const DATE_KEYWORDS = ["date", "transaction date", "trans date"];
const DESC_KEYWORDS = ["transactions", "details", "description", "merchant"];
const DEBIT_KEYWORDS = ["debit", "withdrawal", "withdrawals"];
const CREDIT_KEYWORDS = ["credit", "deposit", "deposits"];
const AMOUNT_KEYWORDS = ["amount"];
const BALANCE_KEYWORDS = ["balance"]; // matched via .includes(), e.g. "running balance"

// A dollar amount that is its OWN item, not embedded in a longer line -
// pdf.js reports these as clean standalone tokens ("$217.04", "-$1,904.13").
const MONEY_RE = /^[-−]?\$[\d,]+\.\d{2}$/;

const MONTH_INDEX = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
function pad(n) {
  return String(n).padStart(2, "0");
}

/** Parses a date built by concatenating a column's text top-to-bottom - so
    this must handle both a date that was already whole ("Sep 8, 2026") and
    one whose day/year split across two lines and got joined back with a
    space ("Sep 21, 2026" - originally "Sep 21," + "2026"). Returns "" (not
    a guess) for anything unrecognised. */
function parseColumnDate(text, fallbackYear) {
  const s = text.replace(/\s+/g, " ").trim();
  let m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTH_INDEX[m[1].toLowerCase().slice(0, 3)];
    return mo ? `${m[3]}-${pad(mo)}-${pad(m[2])}` : "";
  }
  m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})$/); // no year on this page at all
  if (m && fallbackYear) {
    const mo = MONTH_INDEX[m[1].toLowerCase().slice(0, 3)];
    return mo ? `${fallbackYear}-${pad(mo)}-${pad(m[2])}` : "";
  }
  return "";
}

/** Strips the noise that's part of the PAGE, not the transaction - a
    masked card number CIBC repeats on every row, and bare status words
    that landed in the description bucket only because they're not a
    dollar amount and happen to sit to the right of the real description
    text (see the module comment: nearest-x classification, not a strict
    boundary, is what puts them there). Purely cosmetic - leaving them in
    wouldn't break anything, since the review table lets you edit any
    field before confirming. */
function cleanDescription(text) {
  return text
    .replace(/\b\d{4}\*{4,}\d{2,4}\b/g, "")
    .replace(/\b(Pending|Posted|Credit|Debit)\b$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function findHeader(lines) {
  for (const line of lines) {
    const found = {};
    for (const it of line.items) {
      const t = it.str.trim().toLowerCase();
      if (DATE_KEYWORDS.includes(t) && found.date === undefined)
        found.date = it.x;
      else if (DESC_KEYWORDS.includes(t) && found.desc === undefined)
        found.desc = it.x;
      else if (DEBIT_KEYWORDS.includes(t) && found.debit === undefined)
        found.debit = it.x;
      else if (CREDIT_KEYWORDS.includes(t) && found.credit === undefined)
        found.credit = it.x;
      else if (AMOUNT_KEYWORDS.includes(t) && found.amount === undefined)
        found.amount = it.x;
      else if (
        found.balance === undefined &&
        BALANCE_KEYWORDS.some((k) => t.includes(k))
      )
        found.balance = it.x;
    }
    const hasAmountCol =
      found.debit !== undefined ||
      found.credit !== undefined ||
      found.amount !== undefined;
    if (found.date !== undefined && found.desc !== undefined && hasAmountCol)
      return { y: line.y, ...found };
  }
  return null;
}

/** Distance from x to a labelled column position, or Infinity if that
    column doesn't exist on this page (e.g. no RUNNING BALANCE column). */
function dist(x, colX) {
  return colX === undefined ? Infinity : Math.abs(x - colX);
}

const FOOTER_CUTOFF_Y = 20; // below this is page-number/URL chrome, never table content

// How far below its own anchor the LAST record on a page is allowed to
// reach, and how far above its own anchor the FIRST one is (the latter
// only matters when the page has no header row of its own - see below).
// Every OTHER record's bound is the midpoint to the next/previous anchor -
// a real, tight boundary - but the first and last have no such neighbour
// on this page, so without a cap they'd otherwise swallow everything down
// to FOOTER_CUTOFF_Y or up to the page top, including disclaimer
// paragraphs, fine print, or (on a continuation page) the browser's own
// printed page title. Seen in practice: a real CIBC export's own
// continuation lines for a record never ran past ~20pt from its anchor.
const RECORD_EDGE_MARGIN = 30;

/** Parses one page's items against a known column layout - `cols` is
    {date, desc, debit, credit, amount, balance} x-positions. `headerY` is
    that page's own header row's y if it has one, or null for a
    continuation page that relies on the previous page's header (CIBC's
    own multi-page export doesn't always repeat the header on every
    page) - in which case the first record's upper bound is capped by
    RECORD_EDGE_MARGIN rather than a real header boundary. */
function parsePage(items, cols, headerY) {
  const inTable = (y) =>
    (headerY === null || y < headerY - 1) && y > FOOTER_CUTOFF_Y;

  // Every dollar-shaped item is a candidate anchor - one per real
  // transaction row - EXCEPT one that's actually the running-balance
  // column, which also looks like money but isn't a transaction amount.
  const anchors = [];
  for (const it of items) {
    if (!inTable(it.y) || !MONEY_RE.test(it.str.trim())) continue;
    const distances = [
      { kind: "debit", d: dist(it.x, cols.debit) },
      { kind: "credit", d: dist(it.x, cols.credit) },
      { kind: "amount", d: dist(it.x, cols.amount) },
      { kind: "balance", d: dist(it.x, cols.balance) },
    ].filter((c) => isFinite(c.d));
    if (!distances.length) continue;
    distances.sort((a, b) => a.d - b.d);
    const nearest = distances[0].kind;
    if (nearest === "balance") continue; // a running balance, not a transaction
    anchors.push({ y: it.y, str: it.str.trim(), kind: nearest });
  }
  anchors.sort((a, b) => b.y - a.y); // top to bottom
  if (!anchors.length) return { rows: [], skipped: 0 };

  // Every non-anchor item, classified into a record's y-window (via the
  // midpoint between consecutive amount anchors) and then into DATE vs
  // DESCRIPTION by nearest column - not a fixed x cutoff, since a
  // right-aligned number shifts left with more digits but ordinary text
  // always starts at its column's fixed left edge, so nearest-x is stable
  // for text even where it would be unsafe for amounts.
  const minTableX = cols.date - 10; // excludes page margin notes/disclaimers
  const records = anchors.map((a, i) => ({
    anchor: a,
    upperY:
      i === 0
        ? headerY !== null
          ? headerY
          : a.y + RECORD_EDGE_MARGIN
        : (anchors[i - 1].y + a.y) / 2,
    lowerY:
      i === anchors.length - 1
        ? Math.max(FOOTER_CUTOFF_Y, a.y - RECORD_EDGE_MARGIN)
        : (a.y + anchors[i + 1].y) / 2,
    dateParts: [],
    descParts: [],
  }));

  for (const it of items) {
    if (!inTable(it.y) || it.x < minTableX) continue;
    if (MONEY_RE.test(it.str.trim())) continue; // already handled as an anchor (or a balance)
    const rec = records.find((r) => it.y > r.lowerY && it.y <= r.upperY);
    if (!rec) continue;
    const toDate = dist(it.x, cols.date);
    const toDesc = dist(it.x, cols.desc);
    (toDate <= toDesc ? rec.dateParts : rec.descParts).push(it);
  }

  const rows = [];
  let skipped = 0;
  let fallbackYear = null;
  for (const rec of records) {
    const dateText = rec.dateParts
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .map((it) => it.str)
      .join(" ");
    const iso = parseColumnDate(dateText, fallbackYear);
    if (iso) fallbackYear = Number(iso.slice(0, 4));
    if (!iso) {
      skipped++;
      continue;
    }
    const description = cleanDescription(
      rec.descParts
        .sort((a, b) => b.y - a.y || a.x - b.x)
        .map((it) => it.str)
        .join(" "),
    );
    const amount = Number(rec.anchor.str.replace(/[^\d.]/g, ""));
    if (!description || !amount) {
      skipped++;
      continue;
    }
    const isCredit =
      rec.anchor.kind === "credit" || /^[-−]/.test(rec.anchor.str);
    rows.push(
      normalise({
        date: iso,
        type: inferTypeFromSignAndDescription(description, isCredit),
        category: "",
        subcategory: "",
        description,
        amount,
        payment: "",
        account: "",
        recurring: "No",
        person: "",
      }),
    );
  }
  return { rows, skipped };
}

/** Tries to read `pages` (extractPdfItems()'s result) as a labelled table.
    Returns null if no page ever shows a recognisable header row - the
    caller should fall back to statement-parser.js's line-based parser in
    that case, since this only applies to a statement laid out as an
    actual multi-column table.

    A multi-page export doesn't necessarily repeat the header on every
    page (a real CIBC export puts it on pages 1-2 of a 3-page credit-card
    statement but not page 3), so once a header has been seen, its column
    x-positions carry forward to any later page that lacks its own -
    parsePage() then treats that page as one continuous table with no
    header-row cutoff at the top, capped instead by RECORD_EDGE_MARGIN. */
export function parseBankTablePdf(pages) {
  let lastCols = null;
  const rows = [];
  let skipped = 0;
  for (const items of pages) {
    const header = findHeader(groupItemsIntoLines(items));
    const cols = header || lastCols;
    if (!cols) continue; // no header seen yet on any prior page either
    if (header) lastCols = header;
    const page = parsePage(items, cols, header ? header.y : null);
    rows.push(...page.rows);
    skipped += page.skipped;
  }
  if (!lastCols) return null;
  return {
    rows,
    skipped,
    reasons: skipped
      ? ["table rows whose date or amount couldn't be read"]
      : [],
  };
}
