# pdf-extract

Turns a **scanned PDF** (image-only, no text layer) into structured rows using **Gemma 4
vision** on AMD GPUs. A module imported by Data Wizard — not a standalone app.

```
scanned PDF
  └─ rasterize.js  pdftoppm → one PNG per page (220 DPI, capped at 20 pages)
  └─ gemma.js      each PNG → Gemma vision → {columns, rows}
  └─ extract.js    reconcile pages → one table → CSV text
        └─ handed to Data Wizard's existing CSV → Databricks table path
```

Because the output is CSV text, a PDF reuses **everything** downstream: type inference,
`Load as table`, and the bronze/silver/gold pipeline. A scanned PDF behaves exactly like a CSV.

## Model access

- **Primary:** Ollama on your AMD MI300X droplet (`GEMMA_BASE_URL`, `GEMMA_MODEL=gemma4:31b`).
- **Fallback:** Fireworks AI Gemma (`FIREWORKS_API_KEY`, `FIREWORKS_GEMMA_MODEL`) — also
  AMD-hosted. On droplet connection failure/timeout, falls back automatically if a key is set;
  otherwise returns a clear "backend unavailable" error.

Set these in the repo-root `.env`.

## API

```js
import { extractPdf } from './extract.js';
const { columns, rows, csv, pages, via, warnings } = await extractPdf(pdfBuffer, {
  dpi: 220, maxPages: 20,
  onProgress: (page, total) => {},
});
```

`via` is `'droplet'` or `'fireworks'`. `warnings` flags multi-page column mismatches.

## Verified end-to-end

Synthetic scanned invoice (`samples/invoice_scan.pdf`, an image-only PDF — `pdftotext`
returns nothing) → Gemma read all 5 columns and 6 rows with 100% accuracy in ~17s on the
MI300X → type inference gave `Qty INT`, `Unit_Price DOUBLE`, `Total DOUBLE` → loaded into
Databricks and queried back correctly. It correctly ignored the title and the "Grand Total"
footer, keeping only table rows.

## What it's good and bad at

- **Good:** printed tables in scans — invoices, reports, spreadsheet printouts. Headers become
  columns; each table row becomes a record.
- **Weaker:** faint scans, heavy skew, handwriting, and multi-table pages. The extracted
  preview is shown in Slack before any table is written, so a user can catch misreads.
- **Not built for:** free-form documents without a table (returns empty), or record-per-document
  forms (this build targets tables-in-scans).

## Limits

- ~15s/page on the droplet; 20-page hard cap per upload (logged, not silent).
- Multi-page reconcile assumes page 1 holds the header and later pages are continuations.
- Depends on the droplet being up (see the Fireworks fallback).
- Values are transcribed as strings; downstream type inference decides column types.
