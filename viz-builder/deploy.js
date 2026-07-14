/**
 * Databricks table + viz spec -> published Tableau workbook -> rendered PNG.
 *
 * The data is packaged as a CSV inside the .twbx (exactly how Tableau's own Superstore sample
 * embeds `Data/…csv`). Tableau's live Databricks connector publishes blank — the embedded-CSV
 * path is the one that verifiably renders — so we snapshot the table at build time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateTwb } from './twbgen.js';

const ROOT = path.resolve(import.meta.dirname, '..');

export function loadEnv() {
  const env = {};
  // In the cloud there is no .env — secrets are real env vars. Seed `env` from process.env so
  // callers that read the returned object (SERVER, SITE_NAME, PAT_*) still work, then overlay the
  // file if it exists locally.
  for (const k of Object.keys(process.env)) env[k] = process.env[k];
  const dotenv = path.join(ROOT, '.env');
  if (fs.existsSync(dotenv)) {
    for (const line of fs.readFileSync(dotenv, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) {
        env[m[1]] = m[2];
        // databricks.js reads process.env, not this object — without this the host is undefined
        // and every query dies with "Failed to parse URL from undefined/api/2.0/sql/statements".
        if (!process.env[m[1]]) process.env[m[1]] = m[2];
      }
    }
  }
  return env;
}

const dbx = await import(path.join(ROOT, 'slack-data-agent', 'databricks.js'));

/** Live column list for a Databricks table. */
export async function introspect(env, table, catalog, schema) {
  const c = catalog || env.DATABRICKS_CATALOG || 'dbdemos';
  const s = schema || env.DATABRICKS_SCHEMA || 'data_wizard';
  const cols = await dbx.describeTable(c, s, table);
  if (!cols.length) throw new Error(`table "${c}.${s}.${table}" not found`);
  return cols;
}

// Databricks returns timestamps as ISO-8601 ("2026-07-01T09:15:00.000Z"). Tableau's textscan
// connector will NOT parse that into a real datetime, so date truncation silently fails.
// Normalise to Tableau's native "2026-07-01 09:15:00".
const ISO_DT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/;
const rowsToCsv = (names, rows) => {
  const norm = v => { const t = v == null ? '' : String(v); const m = t.match(ISO_DT); return m ? `${m[1]} ${m[2]}` : t; };
  const esc = v => { const t = norm(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  return [names.join(','), ...rows.map(row => row.map(esc).join(','))].join('\n') + '\n';
};

/** Snapshot the table to CSV — this is what gets embedded in the .twbx. */
async function tableToCsv(env, table, columns, catalog, schema) {
  const c = catalog || env.DATABRICKS_CATALOG || 'dbdemos';
  const s = schema || env.DATABRICKS_SCHEMA || 'data_wizard';
  const names = columns.map(x => x.name);
  // Cap the snapshot — an unbounded SELECT on a big table would balloon the .twbx and the
  // statement API response. 100k rows is far beyond anything a chart can show anyway.
  const r = await dbx.runSql(`SELECT ${names.map(n => `\`${n}\``).join(', ')} FROM \`${c}\`.\`${s}\`.\`${table}\` LIMIT 100000`);
  return rowsToCsv(names, r.rows);
}

/**
 * Time-series snapshot: GROUP BY the date in SQL so Tableau gets ONE pre-aggregated row per
 * period (Tableau's embedded-CSV date truncation is unreliable — a line "over time" came out as a
 * flat line because it never grouped the day's timestamps).
 *
 * For an ADDITIVE measure (COUNT / SUM) we return the CUMULATIVE running total, because
 * "<thing> over time" means the growth curve — total-to-date climbing 2→4→6→8→10 — not the
 * per-day count, which on uniform data is a flat, useless line. Non-additive aggregations
 * (AVG / COUNTD / MIN / MAX) can't be accumulated, so those stay per-period.
 * Returns { csv, columns, spec } to feed the workbook generator.
 */
const VALID_AGG = new Set(['COUNT', 'SUM', 'AVG', 'COUNTD', 'MIN', 'MAX']);

/** The date/timestamp field a chart groups by — from spec.dimension, else a date field in vizql. */
export function dateDimension(spec, columns) {
  const isDate = name => { const c = columns.find(x => x.name === name); return c && /date|timestamp/i.test(c.type); };
  if (spec.dimension && isDate(spec.dimension)) return spec.dimension;
  const fields = [...(spec.vizql?.cols || []), ...(spec.vizql?.rows || []), ...(spec.vizql?.encodings || [])]
    .map(p => p && p.field).filter(Boolean);
  return fields.find(isDate) || null;
}

async function timeSeriesSnapshot(env, spec, columns, catalog, schema, dateDim) {
  const c = catalog || env.DATABRICKS_CATALOG || 'dbdemos';
  const s = schema || env.DATABRICKS_SCHEMA || 'data_wizard';
  const granKey = ['day', 'month', 'year'].includes((spec.dateGranularity || '').toLowerCase())
    ? spec.dateGranularity.toLowerCase() : 'day';
  const gran = { day: 'DAY', month: 'MONTH', year: 'YEAR' }[granKey];
  const agg = (spec.aggregation || 'COUNT').toUpperCase();
  if (!VALID_AGG.has(agg)) throw new Error(`Unsupported aggregation "${agg}" for a time chart.`);
  const measExpr = agg === 'COUNT' ? 'COUNT(*)'
    : agg === 'COUNTD' ? `COUNT(DISTINCT \`${spec.measure}\`)`
    : `${agg}(\`${spec.measure}\`)`;
  // The value column's name / axis label. A COUNT is COUNT(*) — a count of ROWS — so its value has
  // nothing to do with spec.measure; labeling that axis with the (id) column the model happened to
  // name reads as nonsense ("signup_id" going 2→10). Name it for what's actually counted: the
  // table's records (humanized). SUM/AVG/etc DO derive from the measure column, so those keep it.
  // Never undefined, and never equal to the date column (a name collision collapses both columns).
  let alias = agg === 'COUNT'
    ? spec.table.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
    : spec.measure;
  if (!alias || alias === dateDim) alias = 'value';
  const dq = `\`${dateDim}\``;

  const mark = spec.vizql?.mark;
  const chartType = ['bar', 'hbar', 'line', 'area'].includes(spec.chartType) ? spec.chartType
    : mark === 'Bar' ? 'bar' : mark === 'Area' ? 'area' : 'line';
  const isLineArea = chartType === 'line' || chartType === 'area';
  // Accumulate ONLY a line/area of an additive measure — that's the growth story. Bars, and any
  // non-additive aggregation (AVG/COUNTD/MIN/MAX), stay per-period.
  const cumulative = isLineArea && (agg === 'COUNT' || agg === 'SUM');

  const perPeriod =
    `SELECT DATE_TRUNC('${gran}', ${dq}) AS period, ${measExpr} AS v ` +
    `FROM \`${c}\`.\`${s}\`.\`${spec.table}\` WHERE ${dq} IS NOT NULL GROUP BY 1`;
  const query = cumulative
    ? `SELECT period AS ${dq}, SUM(v) OVER (ORDER BY period ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS \`${alias}\` ` +
      `FROM (${perPeriod}) ORDER BY period LIMIT 100000`
    : `SELECT period AS ${dq}, v AS \`${alias}\` FROM (${perPeriod}) ORDER BY period LIMIT 100000`;

  const r = await dbx.runSql(query);
  if (!r.rows.length) throw new Error(`No dated rows in \`${spec.table}\` to chart "${dateDim}" over time.`);
  const csv = rowsToCsv([dateDim, alias], r.rows);

  // Force the plain chartType path (not vizql): the model's vizql block re-applies COUNT per row,
  // which on one-row-per-period data is 1 again. Stripping it uses SUM over the pre-aggregated value.
  const title = cumulative && spec.title && !/cumulative|running|total|to date/i.test(spec.title)
    ? `Cumulative ${spec.title}` : spec.title;

  return {
    csv,
    columns: [{ name: dateDim, type: 'timestamp' }, { name: alias, type: 'double' }],
    // measure:alias so twbgen finds the value column; dateGranularity set so it truncates
    // consistently (an unset granularity made area charts collapse every row into one year).
    spec: { ...spec, dimension: dateDim, measure: alias, chartType, aggregation: 'SUM',
      dateGranularity: granKey, vizql: undefined, title, sheetName: title || spec.sheetName },
    rows: r.rows.length,
  };
}

async function signin(env) {
  const r = await fetch(env.SERVER + '/api/3.24/auth/signin', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ credentials: {
      personalAccessTokenName: env.PAT_NAME, personalAccessTokenSecret: env.PAT_VALUE,
      site: { contentUrl: env.SITE_NAME } } }),
  });
  const j = await r.json();
  if (!j.credentials) throw new Error(`Tableau signin failed: ${JSON.stringify(j).slice(0, 160)}`);
  return { token: j.credentials.token, siteId: j.credentials.site.id };
}

function publish(env, twbxPath, workbookName) {
  const py = process.env.TSC_PYTHON || env.TSC_PYTHON || 'python3';
  const script = path.resolve(import.meta.dirname, 'publish.py');
  let out;
  try {
    out = execFileSync(py, [script, twbxPath, workbookName], { env: { ...process.env, ...env }, encoding: 'utf8' });
  } catch (e) {
    // The Tableau publish runs in a Python venv (TSC_PYTHON). Only a genuine setup failure —
    // python binary missing (spawn ENOENT) or the package not installed — should tell the user
    // to rebuild it. Every OTHER publish error (transient Tableau 5xx, auth) surfaces a Python
    // traceback whose PATHS contain "tableauserverclient", so matching that word misreported
    // real server hiccups as "rebuild your venv". Match the precise signatures instead.
    const stderr = e.stderr || '';
    const setupBroken = e.code === 'ENOENT' || /ModuleNotFoundError|No module named/i.test(stderr);
    if (setupBroken) {
      throw new Error(
        'Tableau publisher Python is not set up. Rebuild it:\n' +
        '  python3 -m venv .venv && .venv/bin/python -m pip install -r viz-builder/requirements.txt\n' +
        `(TSC_PYTHON=${py})`);
    }
    throw e;
  }
  const m = out.match(/PUBLISHED:\s*(\S+)/);
  const views = [...out.matchAll(/^VIEW\s+(.+?)\s+(\S+)$/gm)].map(x => ({ name: x[1], id: x[2] }));
  if (!m) throw new Error('publish did not report a workbook id:\n' + out);
  return { workbookId: m[1], views };
}

export async function renderView(env, viewId, outPath) {
  const { token, siteId } = await signin(env);
  const r = await fetch(`${env.SERVER}/api/3.24/sites/${siteId}/views/${viewId}/image?resolution=high&maxAge=0`,
    { headers: { 'X-Tableau-Auth': token } });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.subarray(1, 4).toString() !== 'PNG') throw new Error(`render failed: ${buf.subarray(0, 160).toString()}`);
  fs.writeFileSync(outPath, buf);
  return { bytes: buf.length, path: outPath };
}

/** Full pipeline: spec -> snapshot -> .twbx -> publish -> PNG. */
export async function buildAndDeploy(spec, opts = {}) {
  const { workbookName, outDir, catalog, schema, description, critique = true, _retried = false } = opts;
  const env = loadEnv();
  const columns = await introspect(env, spec.table, catalog, schema);

  const dir = fs.mkdtempSync(path.join(outDir || os.tmpdir(), 'viz-'));
  fs.mkdirSync(path.join(dir, 'Data'), { recursive: true });

  // ANY chart over a date/timestamp dimension needs the date grouped in SQL — Tableau's embedded-CSV
  // truncation can't be trusted (it plotted every raw timestamp separately: a flat line, or one thin
  // bar per timestamp). Covers bar/hbar/line/area, and whether the model set chartType or a vizql
  // block, and whether the date is in spec.dimension or only inside vizql.
  const dateDim = dateDimension(spec, columns);
  const isDateChart = !!dateDim && (['bar', 'hbar', 'line', 'area'].includes(spec.chartType)
    || ['Bar', 'Line', 'Area'].includes(spec.vizql?.mark));
  let csv = '', genSpec = spec, genCols = columns;
  if (isDateChart) {
    const ts = await timeSeriesSnapshot(env, spec, columns, catalog, schema, dateDim);
    csv = ts.csv; genSpec = ts.spec; genCols = ts.columns;
  } else {
    csv = await tableToCsv(env, spec.table, columns, catalog, schema);
  }
  fs.writeFileSync(path.join(dir, 'Data', `${spec.table}.csv`), csv);

  const twbName = `${spec.table}_${spec.chartType}.twb`;
  fs.writeFileSync(path.join(dir, twbName), generateTwb({ spec: genSpec, columns: genCols }));

  // package .twbx = zip of the .twb + Data/
  const twbx = path.join(dir, `${spec.table}_${spec.chartType}.twbx`);
  execFileSync('zip', ['-q', '-r', twbx, twbName, 'Data'], { cwd: dir });

  const wbName = workbookName || `Viz ${spec.table} ${spec.chartType}`;
  const { workbookId, views } = publish(env, twbx, wbName);
  const view = views[0];
  if (!view) throw new Error(`workbook ${workbookId} published but reported no views — cannot render`);
  const png = path.join(dir, `${spec.table}_${spec.chartType}.png`);
  const rendered = await renderView(env, view.id, png);

  // SELF-HEALING: the model LOOKS at what it just rendered and judges whether it actually
  // represents the data (a flat line, a single dot, an unreadable mess = broken). If broken, the
  // VizQL expert regenerates a corrected chart and we rebuild ONCE. It's told the underlying data
  // so it can tell "this should have 5 rising points but shows 1". A correct chart (incl. a steady
  // diagonal cumulative line) is left alone.
  if (critique && !_retried) {
    const { healChart } = await import('./spec.js');
    const lines = csv.split('\n').filter(Boolean);
    const dataFacts = `${lines.length - 1} data rows. columns: ${lines[0]}. values: ${lines.slice(1, 7).join(' | ')}${lines.length > 7 ? ' …' : ''}`;
    const heal = await healChart(fs.readFileSync(rendered.path), genSpec, description, catalog, schema, dataFacts).catch(() => ({ good: true }));
    if (!heal.good && heal.newSpec) {
      const out = await buildAndDeploy(heal.newSpec, { ...opts, _retried: true });
      return { ...out, healed: heal.problem, revisedFrom: spec.chartType, revisedTo: heal.newSpec.chartType || 'viz' };
    }
    return { workbookId, viewId: view.id, png: rendered.path, bytes: rendered.bytes, rows: csv.split('\n').length - 2, critique: heal };
  }

  return { workbookId, viewId: view.id, png: rendered.path, bytes: rendered.bytes, rows: csv.split('\n').length - 2 };
}
