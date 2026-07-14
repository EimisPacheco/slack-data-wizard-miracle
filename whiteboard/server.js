/**
 * Whiteboard → Databricks table.
 * Serves a drawing page; on "Extract", the canvas PNG goes to OpenAI vision,
 * the extracted table lands in Databricks. Reuses the exact modules Data Wizard uses.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const ROOT = path.resolve(import.meta.dirname, '..');
// Local dev reads secrets from ../.env; in the cloud (Cloud Run) they arrive as real env vars and
// there is no file — so a missing .env is fine, not fatal.
if (fs.existsSync(path.join(ROOT, '.env'))) {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { extractTable, callVision } = await import(path.join(ROOT, 'pdf-extract', 'vision.js'));
const { loadFlatTable } = await import(path.join(ROOT, 'slack-data-agent', 'medallion.js'));
const { ensureSchema } = await import(path.join(ROOT, 'slack-data-agent', 'databricks.js'));
const { analyseCsv } = await import(path.join(ROOT, 'csv-to-db', 'csv.js'));

function toCsv({ columns, rows }) {
  const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [columns.map(esc).join(','), ...rows.map(r => columns.map((_, i) => esc(r[i])).join(','))].join('\n') + '\n';
}
// A leading digit is legal here but ident() rewrites it to `c_<name>` at creation time — we'd
// then report a table path that doesn't exist. Normalise the same way up front.
const sanitize = s => {
  const n = (s || 'drawing').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_{2,}/g, '_').slice(0, 40) || 'drawing';
  return /^\d/.test(n) ? `c_${n}` : n;
};

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));

// On a PUBLIC url (Cloud Run) the build endpoints must not be open to the internet — anyone could
// spend the API quota, write Databricks, or post into Slack. When WHITEBOARD_TOKEN is set, every
// build request must carry it (the Slack bot embeds it in the link, the page forwards it). Locally,
// with no token set, the guard is a no-op so nothing changes.
const requireToken = (req, res, next) => {
  const expected = process.env.WHITEBOARD_TOKEN;
  if (!expected) return next();
  const got = req.get('x-wb-token') || req.body?.token || req.query.token;
  if (got === expected) return next();
  return res.status(403).json({ ok: false, error: 'forbidden' });
};

app.post('/extract', requireToken, async (req, res) => {
  try {
    // catalog/schema deliberately NOT taken from the request: an unauthenticated caller could
    // otherwise target any namespace the Databricks token can write.
    const { image, table } = req.body || {};
    if (!image) return res.status(400).json({ error: 'no image' });
    const png = Buffer.from(image.replace(/^data:image\/png;base64,/, ''), 'base64');

    const r = await extractTable(png);
    if (!r.rows.length) return res.json({ ok: false, message: 'No table found in the drawing. Try clearer rows/columns.' });

    const c = process.env.DATABRICKS_CATALOG || 'workspace';
    const s = process.env.DATABRICKS_SCHEMA || 'data_wizard';
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

// ─────────────── sketch → Tableau dashboard ───────────────
// OpenAI vision describes the drawing in words; that description flows through the exact
// same pipeline a typed "create a dashboard…" request uses (describeToSpec → buildAndDeploy),
// so schema validation and Tableau publishing are shared, not reimplemented.

const { describeToSpec, listTables } = await import(path.join(ROOT, 'viz-builder', 'spec.js'));
const { buildAndDeploy, loadEnv } = await import(path.join(ROOT, 'viz-builder', 'deploy.js'));
const { WebClient } = await import('@slack/web-api');
const slack = process.env.SLACK_BOT_TOKEN ? new WebClient(process.env.SLACK_BOT_TOKEN) : null;

const SKETCH_PROMPT = (tables, hint) =>
`This image is a hand-drawn whiteboard SKETCH of a chart the user wants built from their data.
Available tables: ${tables.join(', ')}.${hint ? `
The user also typed this hint — treat it as authoritative, especially for which table to use: "${hint}".` : ''}
Read the drawing: the chart shape (vertical bars, horizontal bars, a line, scattered dots, a circle
with slices = a pie chart) and any handwritten words (title, axis labels, category names, a
table name).
Reply with ONE short sentence describing the chart to build — chart type, table (the hint's table if
given, else the written one, else the closest available), and fields — e.g.:
"a bar chart of count of signups by country from hackathon_signups"
No JSON. No markdown. One sentence only.`;

async function describeSketch(png, tables, hint) {
  const text = (await callVision(SKETCH_PROMPT(tables, hint), png)).trim();
  if (!text) throw new Error('empty vision reply');
  return text;
}

app.post('/dashboard', requireToken, async (req, res) => {
  try {
    const { image, channel, hint } = req.body || {};
    if (!image) return res.status(400).json({ error: 'no image' });
    const png = Buffer.from(image.replace(/^data:image\/png;base64,/, ''), 'base64');
    const c = process.env.DATABRICKS_CATALOG || 'workspace';
    const s = process.env.DATABRICKS_SCHEMA || 'data_wizard';

    const tables = await listTables(c, s);
    if (!tables.length) return res.json({ ok: false, message: `No tables in ${c}.${s} to chart — load some data first.` });

    const described = await describeSketch(png, tables, (hint || '').trim());
    const request = hint ? `${described} (user hint: ${hint})` : described;
    const specRes = await describeToSpec(c, s, tables, request);
    if (!specRes.ok) return res.json({ ok: false, message: specRes.reason, described });
    const spec = specRes.spec;
    spec.sheetName = spec.title || 'Viz';
    spec.chartType = spec.chartType || 'viz';   // vizql-only specs may omit it; used in filenames

    const env = loadEnv();
    const r = await buildAndDeploy(spec, {
      workbookName: (spec.title || `${spec.table} ${spec.chartType}`).slice(0, 60),
      outDir: os.tmpdir(), catalog: c, schema: s, description: described,
    });
    const url = `${env.SERVER}/#/site/${env.SITE_NAME}/workbooks/${r.workbookId}`;
    const chartPng = fs.readFileSync(r.png);

    // Close the loop in Slack — but a Slack hiccup must not fail the build the browser is waiting on.
    let posted = false;
    if (slack && channel) {
      try {
        await slack.files.uploadV2({
          channel_id: channel, file: chartPng, filename: `${spec.table}.png`,
          title: spec.title || spec.table,
          initial_comment: `🎨 *${spec.title || spec.table}* — built from your whiteboard sketch · <${url}|Open in Tableau>`,
        });
        posted = true;
      } catch (e) { console.error(`Slack post-back failed: ${e.message}`); }
    }

    res.json({
      ok: true, described, title: spec.title || spec.table, explanation: spec.explanation,
      // If the vision critic swapped the chart type for readability, report what it actually built.
      chartType: r.revisedFrom ? r.critique.betterChartType : spec.chartType,
      revisedFrom: r.revisedFrom || null, critique: r.critique?.reason || null,
      table: spec.table, rows: r.rows,
      url, png: chartPng.toString('base64'), posted,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Cloud Run injects PORT and needs the container to listen on 0.0.0.0; there the endpoints are
// protected by WHITEBOARD_TOKEN instead of the loopback bind. Locally (no PORT), stay loopback-only
// so the open endpoints aren't exposed on the LAN.
const PORT = Number(process.env.PORT || process.env.WHITEBOARD_PORT || 3200);
const onCloud = !!process.env.PORT || process.env.WHITEBOARD_PUBLIC === '1';
if (onCloud) {
  app.listen(PORT, '0.0.0.0', () => console.log(`🎨 Whiteboard → table on :${PORT} (public${process.env.WHITEBOARD_TOKEN ? ', token-guarded' : ', UNGUARDED — set WHITEBOARD_TOKEN'})`));
} else {
  app.listen(PORT, '127.0.0.1', () => console.log(`🎨 Whiteboard → table on http://localhost:${PORT} (loopback only)`));
}
