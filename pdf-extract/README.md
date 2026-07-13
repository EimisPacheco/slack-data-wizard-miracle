# pdf-extract

Turns a **scanned PDF** (image-only, no text layer) into structured rows using **OpenAI
vision**. A module imported by Data Wizard — not a standalone app.

```
scanned PDF
  └─ rasterize.js  pdftoppm → one PNG per page (220 DPI, capped at 20 pages)
  └─ vision.js     each PNG → OpenAI vision → {columns, rows}
  └─ extract.js    reconcile pages → one table → CSV text
        └─ handed to Data Wizard's existing CSV → Databricks table path
```

Because the output is CSV text, a PDF reuses **everything** downstream: type inference,
`Load table`, and the bronze/silver/gold pipeline. A scanned PDF behaves exactly like a CSV.

## Model access

- **OpenAI** (`OPENAI_API_KEY`, `OPENAI_MODEL`) via the Responses API — the same model that
  powers NL→SQL and chart selection. `vision.js` also exports `callVision(prompt, png)`,
  which the whiteboard reuses for sketch → dashboard.

Set these in the repo-root `.env`.

## API

```js
import { extractPdf } from './extract.js';
const { columns, rows, csv, pages, via, warnings } = await extractPdf(pdfBuffer, {
  dpi: 220, maxPages: 20,
  onProgress: (page, total) => {},
});
```

`via` is `'openai'`. `warnings` flags multi-page column mismatches.

## Verified end-to-end

Synthetic scanned invoice (an image-only PDF — `pdftotext` returns nothing) → vision read all
5 columns and 6 rows with 100% accuracy → type inference gave `Qty INT`, `Unit_Price DOUBLE`,
`Total DOUBLE` → loaded into Databricks and queried back correctly. It correctly ignored the
title and the "Grand Total" footer, keeping only table rows.

## What it's good and bad at

- **Good:** printed tables in scans — invoices, reports, spreadsheet printouts. Headers become
  columns; each table row becomes a record.
- **Weaker:** faint scans, heavy skew, handwriting, and multi-table pages. The extracted
  preview is shown in Slack before any table is written, so a user can catch misreads.
- **Not built for:** free-form documents without a table (returns empty), or record-per-document
  forms (this build targets tables-in-scans).

## Limits

- ~15s/page; 20-page hard cap per upload (logged, not silent).
- Multi-page reconcile assumes page 1 holds the header and later pages are continuations.
- Values are transcribed as strings; downstream type inference decides column types.
