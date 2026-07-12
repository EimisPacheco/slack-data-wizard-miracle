/**
 * Whiteboard → Databricks table.
 * Serves a drawing page; on "Extract", the canvas PNG goes to Gemma vision (AMD GPU),
 * the extracted table lands in Databricks. Reuses the exact modules Data Wizard uses.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const ROOT = path.resolve(import.meta.dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { extractTable } = await import(path.join(ROOT, 'pdf-extract', 'gemma.js'));
const { loadFlatTable } = await import(path.join(ROOT, 'slack-data-agent', 'medallion.js'));
const { ensureSchema } = await import(path.join(ROOT, 'slack-data-agent', 'databricks.js'));
const { analyseCsv } = await import(path.join(ROOT, 'csv-to-db', 'csv.js'));

function toCsv({ columns, rows }) {
  const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [columns.map(esc).join(','), ...rows.map(r => columns.map((_, i) => esc(r[i])).join(','))].join('\n') + '\n';
}
const sanitize = s => (s || 'drawing').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_{2,}/g, '_').slice(0, 40) || 'drawing';

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));

app.post('/extract', async (req, res) => {
  try {
    const { image, table, catalog, schema } = req.body || {};
    if (!image) return res.status(400).json({ error: 'no image' });
    const png = Buffer.from(image.replace(/^data:image\/png;base64,/, ''), 'base64');

    const r = await extractTable(png);
    if (!r.rows.length) return res.json({ ok: false, message: 'Gemma found no table in the drawing. Try clearer rows/columns.' });

    const c = catalog || process.env.DATABRICKS_CATALOG || 'workspace';
    const s = schema || process.env.DATABRICKS_SCHEMA || 'data_wizard';
    const tbl = sanitize(table);
    const csv = toCsv(r);
    const { columns } = analyseCsv(csv);  // for the typed preview
    await ensureSchema(c, s);
    const loaded = await loadFlatTable({ catalog: c, schema: s, table: tbl, csvText: csv });

    res.json({
      ok: true, via: r.via,
      table: `${c}.${s}.${tbl}`,
      columns: r.columns,
      rows: r.rows,
      types: columns.map(x => ({ name: x.name, type: x.type })),
      rowsInserted: loaded.rowsInserted,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = Number(process.env.WHITEBOARD_PORT || 3200);
app.listen(PORT, () => console.log(`🎨 Whiteboard → table on http://localhost:${PORT}`));
