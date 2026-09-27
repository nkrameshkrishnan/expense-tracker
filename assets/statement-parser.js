/* Programmatic (no AI, no network call) extraction of transactions from raw
   statement text - the deterministic replacement for the earlier
   Claude-based transform. Runs entirely client-side, on the text
   pdfio.js's extractPdfText() already reconstructed line-by-line.

   The rule: a line counts as a transaction only if it starts with something
   that parses as a date and, after that, ends with something that parses as
   a dollar amount. Everything between the two is taken as the description.
   Every other line (headers, page numbers, running balances) is silently
   skipped rather than guessed at.

   What this CANNOT do that the AI version could: recognise which of the
   household's own categories/payment methods/accounts/people a line
   belongs to, or read a statement whose layout doesn't put a date at the
   start of the line and an amount at the end. Those fields are left blank
   (normalise() defaults an empty category to "Miscellaneous") for the
   review table's existing dropdowns to fill in by hand - the same
   nothing-is-written-until-you-confirm safety net CSV/XLSX imports and the
   old AI path both already went through. */
import { normalise, inferTypeFromSignAndDescription } from "./store.js";

function pad(n) {
  return String(n).padStart(2, "0");
}

const MONTH_INDEX = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Date patterns, tried in order, each anchored to the START of the
    (already-trimmed) line. `toIso` gets the regex match plus a fallback
    year to use when the line itself has no year of its own. Returns null
    from `toIso` to mean "matched the shape but not a real date" (e.g. a
    month name pdf.js mangled), so the caller moves on to the next pattern
    rather than treating it as a match. */
const DATE_PATTERNS = [
  {
    // 2026-09-15 or 2026/09/15
    re: /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\b/,
    toIso: (m) => `${m[1]}-${pad(m[2])}-${pad(m[3])}`,
  },
  {
    // 09/15/2026 or 09-15-2026 - the common North American statement format
    re: /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})\b/,
    toIso: (m) => `${m[3]}-${pad(m[1])}-${pad(m[2])}`,
  },
  {
    // Sep 15, 2026 / Sep 15 2026 / September 15 2026
    re: /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/,
    toIso: (m) => {
      const mo = MONTH_INDEX[m[1].toLowerCase().slice(0, 3)];
      return mo ? `${m[3]}-${pad(mo)}-${pad(m[2])}` : null;
    },
  },
  {
    // 09/15 with no year at all - falls back to the statement's own year
    re: /^(\d{1,2})[-\/](\d{1,2})\b(?!\d)/,
    toIso: (m, year) => `${year}-${pad(m[1])}-${pad(m[2])}`,
  },
];

// A trailing dollar amount: optional leading minus (ASCII "-" or the Unicode
// minus sign U+2212 "−", which is what CIBC's own online-banking pages
// use for a credit instead of a plain hyphen) or "$", thousands separators,
// exactly two decimals, and an optional trailing "-"/"CR"/"DR" marker some
// statements use instead of a leading minus sign for a credit.
const AMOUNT_RE = /([-−])?\$?\s?([\d,]+\.\d{2})\s*(CR|DR|-)?\s*$/i;

const SKIP_LINE_RE =
  /\b(previous balance|new balance|opening balance|closing balance|minimum payment|statement period|page \d+ of \d+|subtotal|available credit)\b/i;

/** Best-effort year for a date pattern that has none of its own - the first
    explicit 4-digit year (20xx) found anywhere in the statement, falling
    back to the current year if the text never states one. */
function inferFallbackYear(lines) {
  for (const line of lines) {
    const m = line.match(/\b(20\d{2})\b/);
    if (m) return Number(m[1]);
  }
  return new Date().getFullYear();
}

/** Parses raw statement text into rows shaped like the staged-import review
    table expects - {rows, skipped, reasons} matching importFile()'s shape
    in xlsxio.js, so pages/data.js can treat a PDF exactly like a CSV/XLSX
    import from this point on. */
export function parseStatementText(text) {
  const allLines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const fallbackYear = inferFallbackYear(allLines);

  const rows = [];
  let skipped = 0;

  for (const line of allLines) {
    if (SKIP_LINE_RE.test(line)) {
      skipped++;
      continue;
    }

    let iso = null;
    let rest = null;
    for (const pattern of DATE_PATTERNS) {
      const m = line.match(pattern.re);
      if (!m) continue;
      const candidate = pattern.toIso(m, fallbackYear);
      if (candidate) {
        iso = candidate;
        rest = line.slice(m[0].length).trim();
        break;
      }
    }
    if (!iso) continue; // doesn't start with a date - not a transaction line

    const amtMatch = rest.match(AMOUNT_RE);
    if (!amtMatch) {
      skipped++;
      continue; // has a date but no trailing amount either
    }
    const description = rest.slice(0, amtMatch.index).replace(/\s{2,}/g, " ").trim();
    if (!description) {
      skipped++;
      continue;
    }

    const amount = Number(amtMatch[2].replace(/,/g, ""));
    if (!amount) {
      skipped++;
      continue;
    }
    const isCredit = Boolean(amtMatch[1]) || /CR|-/.test(amtMatch[3] || "");
    const type = inferTypeFromSignAndDescription(description, isCredit);

    rows.push(
      normalise({
        date: iso,
        type,
        category: "",
        subcategory: "",
        description,
        amount,
        payment: "",
        account: "",
        person: "",
        recurring: "No",
      }),
    );
  }

  return {
    rows,
    skipped,
    reasons: skipped
      ? ["lines that didn't look like a date + description + amount row"]
      : [],
  };
}
