/* Client-side PDF text extraction, via pdf.js loaded lazily from a CDN - the
   same lazy-load pattern as loadXLSX() in xlsxio.js and loadSupabaseSdk() in
   store-helpers.js: most sessions never touch a PDF, so there's no reason to
   ship or fetch this library up front. Extraction happens entirely in the
   browser and stays there - statement-parser.js turns the resulting text
   into rows with plain pattern matching, no AI/network call involved. */

const PDFJS_VERSION = "4.0.379";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;

let pdfjsReady = null;

/** pdf.js's modern build ships as an ES module with no UMD/global bundle, so
    a plain lazily-injected <script> tag (the pattern used for xlsx.js and
    the Supabase SDK) won't expose anything on window. A dynamic import()
    of the CDN URL works from ordinary (non-module) calling code and gives
    back the module namespace directly - no extra script tag needed. */
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = import(/* @vite-ignore */ `${PDFJS_BASE}/build/pdf.min.mjs`)
    .then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.min.mjs`;
      window.pdfjsLib = mod;
      return mod;
    })
    .catch((e) => {
      pdfjsReady = null;
      throw new Error(
        "Could not load the PDF reader library. Check your connection and try again.",
      );
    });
  return pdfjsReady;
}

/** Reads a File (a PDF) and returns, per page, every text item's own string
    and position - {str, x, y} for each, y measured bottom-up in PDF points
    (pdf.js's `item.transform` is a 6-value matrix whose last two entries
    are its x/y). This is the raw material both extractPdfText() (line
    reconstruction, for a simple one-line-per-transaction statement) and
    table-statement-parser.js (column reconstruction, for a statement laid
    out as a multi-column table) build on - most callers want the former;
    the latter needs real positions because a table's date/description/
    amount can each land on different visual sub-lines of the same
    logical row. */
export async function extractPdfItems(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] })),
    );
  }
  return pages;
}

/** Groups a page's items (from extractPdfItems()) into visual lines - every
    item whose y is within a couple of points of another's counts as the
    same line (small tolerance for items that are visually aligned but
    differ by a fraction of a point - superscripts, kerning artifacts).
    Returns lines top-to-bottom, each an object {y, items} with its items
    already sorted left-to-right. Shared by extractPdfText() (which just
    joins each line into a string) and bank-table-parser.js (which needs
    the line grouping to find a table's header row, but keeps working with
    individual item positions afterward for the actual columns). */
export function groupItemsIntoLines(items) {
  const rows = [];
  for (const item of items) {
    let row = rows.find((r) => Math.abs(r.y - item.y) < 2);
    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  rows.sort((a, b) => b.y - a.y); // PDF y grows upward - top of page first
  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  return rows;
}

/** Reads a File (a PDF) and returns its text with real line breaks
    reconstructed, one statement row per line - for a statement whose
    layout puts one transaction on one visual line (date, description, and
    amount side by side). A naive `items.map(i => i.str).join(" ")` (what
    this used to do) mashed an entire page into one line, which was fine
    for an AI to read but useless for line-by-line pattern matching. */
export async function extractPdfText(file) {
  const pages = await extractPdfItems(file);
  const pageTexts = pages.map((items) =>
    groupItemsIntoLines(items)
      .map((row) =>
        row.items
          .map((it) => it.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .join("\n"),
  );
  return pageTexts.join("\n\n").trim();
}
