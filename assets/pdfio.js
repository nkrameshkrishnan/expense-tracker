/* Client-side PDF text extraction, via pdf.js loaded lazily from a CDN - the
   same lazy-load pattern as loadXLSX() in xlsxio.js and loadSupabaseSdk() in
   store-helpers.js: most sessions never touch a PDF, so there's no reason to
   ship or fetch this library up front. Extraction happens entirely in the
   browser; only the resulting plain text is ever sent anywhere (to the
   import-transform Edge Function, from import-ai.js). */

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

/** Reads a File (a PDF) and returns its concatenated text, page by page,
    with a blank line between pages so statement rows on different pages
    don't accidentally run together. */
export async function extractPdfText(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str).join(" "));
  }
  return pages.join("\n\n").trim();
}
