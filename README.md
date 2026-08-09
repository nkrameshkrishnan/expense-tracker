# Ledger — Expense Tracker 2026

Add expenses through a UI, see the dashboard and charts in the browser, export a
Google-Sheets-compatible `.xlsx`. Ships pre-loaded with the 230 rows carried over
from `Expense.xlsx` (Jan / Mar / Apr / Jul 2026).

No build step. No bundler. Push it to GitHub and turn on Pages.

---

## Read this first: GitHub Pages cannot host a backend

This is the one hard constraint on the whole design. **GitHub Pages serves static
files only** — no server processes, no database, no API. So "host the UI on Pages"
and "run a DB backend" cannot be the same deployment.

The app resolves this with two interchangeable storage adapters behind one interface:

| | Where data lives | Works on Pages | Follows you across devices |
|---|---|---|---|
| **Browser storage** (default) | IndexedDB, in that browser | Yes | No |
| **Local backend** (optional) | SQLite on your machine | UI yes, API only while running | No |

Pick browser storage unless you specifically want SQL. Export regularly either way.

### The Safari caveat

An `https://` page calling `http://localhost` is mixed content. Chrome, Edge and
Firefox exempt loopback addresses and allow it. **Safari does not.** If you want the
backend, use one of the first three — or serve the frontend locally over `http://`,
where the question doesn't arise.

---

## Deploy to GitHub Pages

```bash
git init && git add . && git commit -m "Ledger expense tracker"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)` → Save**.

Live at `https://<you>.github.io/<repo>/` in a minute or two. Nothing to build —
paths are relative, so it works under a subpath without configuration.

> Making the repo public makes your expense data public too. **Use a private repo**;
> Pages works from private repos on paid plans. On a free plan, either accept that
> the seed data is visible or delete `data/seed.json` before the first push and
> import your figures through the UI instead.

### Running it locally

ES modules need a real HTTP origin — opening `index.html` from disk will fail on CORS.

```bash
python3 -m http.server 8080     # then open http://localhost:8080
```

---

## The optional backend

```bash
cd backend
./run.sh                        # creates a venv, installs deps, serves 127.0.0.1:8000
```

In the app: **Data → Storage backend →** enter `http://127.0.0.1:8000` → **Connect**.
The indicator in the header turns teal and reads `backend`.

Bound to loopback, so it is not reachable from your network — which is also why it
has no authentication. **Add auth before you change the host.** CORS accepts any
`*.github.io` origin plus the usual localhost dev ports; tighten
`ALLOWED_ORIGIN_REGEX` in `app/main.py` to just your own once you have deployed.

### API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | Connection probe |
| `GET` | `/api/transactions` | Newest first |
| `POST` | `/api/transactions` | 422 if amount ≤ 0 |
| `POST` | `/api/transactions/bulk` | Single commit; capped at 5000 |
| `PATCH` | `/api/transactions/{id}` | |
| `DELETE` | `/api/transactions/{id}` | |
| `DELETE` | `/api/transactions` | Wipes transactions and budget |
| `GET` `PUT` | `/api/budget` | `{category: {month: amount}}` |
| `GET` | `/api/export/xlsx` | **Full workbook with native charts** |

Interactive docs at `http://127.0.0.1:8000/docs`.

---

## Exports: two kinds, and why

**Browser export** (Data → Download .xlsx) writes Transactions, Budget, and a Pivot
cross-tab of live `SUMIFS` formulas. Verified: the formulas recalculate to
`$23,592.39`, matching the source. Classic functions only, so Google Sheets handles
them identically to Excel. **No charts** — SheetJS cannot write chart objects.

**Backend export** (`/api/export/xlsx`) uses openpyxl and produces the same sheets
**plus a Dashboard with four native charts**. This is the only route to a charted
workbook, and the only reason the backend earns its keep if you don't want SQL.

---

## Data model

One row per transaction. **Amount is always positive** — `type` carries the sign.
This is what keeps `SUMIFS` clean in the exported workbook, and it's enforced in
three places: the form, `normalise()`, and a SQLite `CHECK` constraint.

```
date  type  category  subcategory  description  amount  payment  account  recurring  notes
```

Budget is `{category: {1..12: amount}}`. **Zero means "not budgeted"** and is excluded
from Budget Used — that's why Travel doesn't flag as over budget despite July's $7,288.

---

## Known gaps

- **No payment methods in the seed data**, because the source file never recorded
  them. The payment-split doughnut is empty until you fill that field. The dashboard
  tells you how much spend is unattributed rather than quietly dropping it.
- **No income rows**, so Net reads negative and Savings Rate shows `—`.
  Add salary entries with Type = Income and both correct themselves.
- **Import expects a flat table** with `Date` and `Amount` columns. The original
  month-per-tab layout is not auto-detected; that data is already in `data/seed.json`.
- **Single year (2026).** `YEAR` in `assets/store.js` and `xlsx_export.py`.
- Browser storage is per-browser and per-device. It is not a backup. Export.

---

## Layout

```
index.html              app shell
assets/store.js         storage adapters (IndexedDB / REST / memory) + constants
assets/xlsxio.js        aggregation, xlsx export, import with header aliasing
assets/charts.js        Chart.js builders
assets/app.js           routing, views, forms
data/seed.json          230 transactions from Expense.xlsx
data/seed-budget.json   budgets derived from medians of your own actuals
backend/app/main.py     FastAPI routes + CORS
backend/app/repository.py   all SQL
backend/app/xlsx_export.py  openpyxl charted workbook
```

Third-party, all from CDN, no npm install: Chart.js 4.4.1, SheetJS 0.20.3,
Space Grotesk + JetBrains Mono.
