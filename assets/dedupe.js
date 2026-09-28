/* Duplicate detection for the import review table. Pure functions, zero
   dependencies, so they can be tested directly in Node.

   Why this exists: importing a statement only ever APPENDS rows, so loading
   the same file twice (or two overlapping statements) silently doubles
   spending. Every staged row is compared against what is already stored and
   against the rows above it in the same file, and flagged before anything is
   written:

   - "exact"  same date, same amount, same description (after normalising
              case/punctuation/spacing), and no conflicting account or person.
              This is the re-uploaded-file case. Skipped by default.
   - "likely" same amount and no conflicting account/person, within
              DATE_WINDOW days, with a similar description (or same date).
              This catches a posting date that moved between a PDF and a CSV
              export, or a description the bank truncated differently. Also
              used for an identical row repeated inside the same file.
              Imported by default, just flagged for a look.

   Type is deliberately NOT compared: a row already in the store may have been
   re-typed by hand (Expense -> Refund, say) while the freshly parsed copy
   carries the parser's guess, and it is still the same money.

   Matching is one-to-one. Two identical $4.50 coffees on the same day in the
   file against one already stored flags exactly one of them, never both - a
   real repeat purchase must not be swallowed. Exact matches are claimed
   before likely ones, so a close-but-not-identical row can't steal the stored
   row that another staged row matches exactly. */

export const DATE_WINDOW = 3; // days either side, for "likely"
const SIMILARITY = 0.5; // token overlap needed for a "likely" description

/** Upper-case, punctuation to spaces, collapsed whitespace. */
export function normDesc(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function tokens(s) {
  // Alphabetic words of 2+ letters: store numbers, reference ids and dates
  // vary between exports of the same transaction, the merchant name doesn't.
  return new Set(normDesc(s).match(/[A-Z]{2,}/g) || []);
}

/** Share of the smaller description's words found in the other (0-1).
    Overlap-over-smaller rather than Jaccard, so "LOBLAWS" vs
    "LOBLAWS 1234 TORONTO ON" still counts as the same merchant. */
export function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size);
}

const cents = (x) => Math.round((Number(x) || 0) * 100);

function dayNumber(iso) {
  const [y, m, d] = String(iso || "")
    .slice(0, 10)
    .split("-")
    .map(Number);
  if (!y || !m || !d) return NaN;
  return Date.UTC(y, m - 1, d) / 86400000; // UTC: no DST or timezone drift
}

/** A blank on either side is "unknown", not a conflict: PDF-parsed rows
    arrive with no account or person until filled in during review. */
const compatible = (a, b) =>
  !a || !b || String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

function classify(s, e) {
  if (cents(s.amount) !== cents(e.amount)) return null;
  if (!compatible(s.account, e.account)) return null;
  if (!compatible(s.person, e.person)) return null;
  const gap = Math.abs(dayNumber(s.date) - dayNumber(e.date));
  if (!(gap <= DATE_WINDOW)) return null; // NaN-safe
  const sameDesc = normDesc(s.description) === normDesc(e.description);
  if (gap === 0 && sameDesc) return "exact";
  if (sameDesc || gap === 0 || similarity(s.description, e.description) >= SIMILARITY)
    return "likely";
  return null;
}

/**
 * @param staged   rows parsed from the file, in file order
 * @param existing rows already in the store
 * @returns one entry per staged row: null, or
 *          { kind: "exact"|"likely", source: "stored"|"file", match }
 *          where `match` is the stored row, or the earlier staged row it
 *          repeats (source "file").
 */
export function findDuplicates(staged, existing) {
  const result = staged.map(() => null);
  const claimed = new Set(); // indexes into `existing`

  // Pass 1 and 2: against stored rows - exact first, then likely.
  for (const want of ["exact", "likely"]) {
    staged.forEach((s, i) => {
      if (result[i]) return;
      for (let j = 0; j < existing.length; j++) {
        if (claimed.has(j)) continue;
        if (classify(s, existing[j]) === want) {
          claimed.add(j);
          result[i] = { kind: want, source: "stored", match: existing[j] };
          return;
        }
      }
    });
  }

  // Pass 3: identical rows inside the file itself, only for rows not already
  // explained by a stored match. Reported as "likely", never "exact": two
  // same-day same-amount rows in one statement are usually two real
  // purchases, so they stay included and are only pointed out.
  staged.forEach((s, i) => {
    if (result[i]) return;
    for (let k = 0; k < i; k++) {
      // Pair only with an earlier row that is itself new: one already
      // matched to a stored row is the known copy, not a second purchase.
      if (result[k]) continue;
      if (classify(s, staged[k]) === "exact" && !pairedWith(result, k)) {
        result[i] = { kind: "likely", source: "file", match: staged[k], index: k };
        return;
      }
    }
  });
  return result;
}

function pairedWith(result, k) {
  return result.some((r) => r?.source === "file" && r.index === k);
}
