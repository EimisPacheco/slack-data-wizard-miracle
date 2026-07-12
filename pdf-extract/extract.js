import { rasterize } from './rasterize.js';
import { extractTable } from './gemma.js';

/** CSV-escape one value. */
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** { columns, rows } → CSV text, so a PDF reuses the exact CSV → table path. */
export function toCsv({ columns, rows }) {
  const header = columns.map(csvCell).join(',');
  const body = rows.map(r => {
    // pad/truncate each row to the column count so the CSV stays rectangular
    const cells = columns.map((_, i) => csvCell(r[i]));
    return cells.join(',');
  });
  return [header, ...body].join('\n') + '\n';
}

/**
 * Reconcile per-page extractions into one table.
 * Page 1's header wins; continuation pages map onto it positionally. If a page's
 * column count clearly differs, its rows are still appended (padded), and it's flagged.
 */
function reconcile(pages) {
  const withCols = pages.filter(p => p.columns.length > 0);
  if (withCols.length === 0) return { columns: [], rows: [], warnings: ['no table found on any page'] };

  const master = withCols[0].columns;
  const warnings = [];
  const rows = [];

  pages.forEach((p, idx) => {
    if (p.columns.length && p.columns.length !== master.length && idx > 0) {
      warnings.push(`page ${idx + 1} had ${p.columns.length} columns vs ${master.length} on page 1`);
    }
    for (const r of p.rows) rows.push(r);
  });

  return { columns: master, rows, warnings };
}

/**
 * Full pipeline: scanned PDF buffer → { columns, rows, csv, pages, via, warnings }.
 * @param {Buffer} pdfBuffer
 * @param {object} opts { dpi, maxPages, onProgress }
 */
export async function extractPdf(pdfBuffer, opts = {}) {
  const pngs = await rasterize(pdfBuffer, { dpi: opts.dpi || 220, maxPages: opts.maxPages || 20 });

  const pageResults = [];
  let via = null;
  for (let i = 0; i < pngs.length; i++) {
    if (opts.onProgress) await opts.onProgress(i + 1, pngs.length);
    const res = await extractTable(pngs[i], { timeoutMs: opts.timeoutMs });
    via = res.via;
    pageResults.push(res);
  }

  const { columns, rows, warnings } = reconcile(pageResults);
  return { columns, rows, csv: toCsv({ columns, rows }), pages: pngs.length, via, warnings };
}
