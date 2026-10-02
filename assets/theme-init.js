/* Sets data-theme before the first paint, not just before app.js's module
   graph runs - an ordinary module-script read of the same localStorage key
   would still let the browser paint one light-mode frame first on a
   dark-preferring device. Loaded as a plain classic <script src> (not
   type="module", not defer) in index.html's <head>, before any stylesheet
   link, specifically so it runs synchronously and the attribute is already
   in place by the time styles.css's :root[data-theme="dark"] block has
   anything to match. This duplicates a few lines of assets/prefs.js's own
   applyTheme() on purpose - a CSP script-src of 'self' blocks an inline
   <script> outright (see index.html's CSP), so this one small logic-only
   file is the no-flash equivalent of an inline snippet. prefs.js is still
   the one source of truth for every read/write after this; this file only
   ever sets the attribute once, here, before anything else loads. */
(function () {
  try {
    var t = localStorage.getItem("ledger.theme") || "system";
    var dark =
      t === "dark" ||
      (t === "system" &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  } catch (e) {}
})();
