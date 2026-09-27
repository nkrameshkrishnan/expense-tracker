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

/** Reads a File (a PDF) and returns its text with real line breaks
    reconstructed, one statement row per line.

    pdf.js's getTextContent() hands back individual text runs with no line
    structure of their own - a naive `items.map(i => i.str).join(" ")` (what
    this used to do) mashes an entire page into one line, which was fine
    when an AI model was reading the result but is useless for line-by-line
    pattern matching. Instead, each item carries its own position via
    `transform` (a 6-value matrix whose last two entries are its x/y in PDF
    points, y measured bottom-up) - grouping items whose y is within a
    couple of points of each other reconstructs the rows a human would see,
    and sorting each row's items by x puts them back in reading order. */
export async function extractPdfText(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const pageTexts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const rows = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const y = item.transform[5];
      // Small tolerance for items that are visually on the same line but
      // differ by a fraction of a point (superscripts, kerning artifacts).
      let row = rows.find((r) => Math.abs(r.y - y) < 2);
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push(item);
    }
    rows.sort((a, b) => b.y - a.y); // PDF y grows upward - top of page first
    const lines = rows.map((row) =>
      row.items
        .sort((a, b) => a.transform[4] - b.transform[4]) // left to right
        .map((it) => it.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    pageTexts.push(lines.join("\n"));
  }
  return pageTexts.join("\n\n").trim();
}
