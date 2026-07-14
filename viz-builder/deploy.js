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
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) {
      env[m[1]] = m[2];
      // databricks.js reads process.env, not this object — without this the host is undefined
      // and every query dies with "Failed to parse URL from undefined/api/2.0/sql/statements".
      if (!process.env[m[1]]) process.env[m[1]] = m[2];
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

/** Snapshot the table to CSV — this is what gets embedded in the .twbx. */
async function tableToCsv(env, table, columns, catalog, schema) {
  const c = catalog || env.DATABRICKS_CATALOG || 'dbdemos';
  const s = schema || env.DATABRICKS_SCHEMA || 'data_wizard';
  const names = columns.map(x => x.name);
  // Cap the snapshot — an unbounded SELECT on a big table would balloon the .twbx and the
  // statement API response. 100k rows is far beyond anything a chart can show anyway.
  const r = await dbx.runSql(`SELECT ${names.map(n => `\`${n}\``).join(', ')} FROM \`${c}\`.\`${s}\`.\`${table}\` LIMIT 100000`);
  const esc = v => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  return [names.join(','), ...r.rows.map(row => row.map(esc).join(','))].join('\n') + '\n';
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
  const out = execFileSync(py, [script, twbxPath, workbookName], { env: { ...process.env, ...env }, encoding: 'utf8' });
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

  const csv = await tableToCsv(env, spec.table, columns, catalog, schema);
  fs.writeFileSync(path.join(dir, 'Data', `${spec.table}.csv`), csv);

  const twbName = `${spec.table}_${spec.chartType}.twb`;
  fs.writeFileSync(path.join(dir, twbName), generateTwb({ spec, columns }));

  // package .twbx = zip of the .twb + Data/
  const twbx = path.join(dir, `${spec.table}_${spec.chartType}.twbx`);
  execFileSync('zip', ['-q', '-r', twbx, twbName, 'Data'], { cwd: dir });

  const wbName = workbookName || `Viz ${spec.table} ${spec.chartType}`;
  const { workbookId, views } = publish(env, twbx, wbName);
  const view = views[0];
  if (!view) throw new Error(`workbook ${workbookId} published but reported no views — cannot render`);
  const png = path.join(dir, `${spec.table}_${spec.chartType}.png`);
  const rendered = await renderView(env, view.id, png);

  // The model LOOKS at what it just built. If the render is unreadable and a different chart type
  // would clearly be clearer (e.g. a 10-slice pie → horizontal bar), rebuild ONCE with that type.
  if (critique && !_retried) {
    const { critiqueChart } = await import('./spec.js');
    const verdict = await critiqueChart(fs.readFileSync(rendered.path), spec, description).catch(() => ({ good: true }));
    if (!verdict.good && verdict.betterChartType && verdict.betterChartType !== spec.chartType) {
      const retrySpec = { ...spec, chartType: verdict.betterChartType, vizql: undefined };
      const out = await buildAndDeploy(retrySpec, { ...opts, _retried: true });
      return { ...out, critique: verdict, revisedFrom: spec.chartType };
    }
    return { workbookId, viewId: view.id, png: rendered.path, bytes: rendered.bytes, rows: csv.split('\n').length - 2, critique: verdict };
  }

  return { workbookId, viewId: view.id, png: rendered.path, bytes: rendered.bytes, rows: csv.split('\n').length - 2 };
}
