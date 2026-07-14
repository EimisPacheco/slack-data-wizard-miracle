/**
 * End-to-end test suite for Data Wizard — exercises every AI flow against the LIVE stack:
 * OpenAI (routing, NL→SQL, chart specs, vision), Databricks, Tableau, Perplexity, ElevenLabs,
 * and the whiteboard server on :3200.
 *
 *   node tests/e2e.mjs            # run everything, prints a markdown report
 *
 * Slack-surface interactions (buttons, modals, file_shared events) can't be simulated without
 * a Slack client — those are listed as MANUAL at the end of the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const CATALOG = process.env.DATABRICKS_CATALOG || 'workspace';
const SCHEMA = process.env.DATABRICKS_SCHEMA || 'data_wizard';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
const WB = 'http://localhost:3200';

const results = [];
let current = null;
async function test(id, name, fn) {
  current = id;
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ id, name, pass: true, note: note || '', ms: Date.now() - t0 });
    console.error(`✅ ${id} ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ id, name, pass: false, note: err.message.slice(0, 180), ms: Date.now() - t0 });
    console.error(`❌ ${id} ${name} — ${err.message.slice(0, 180)}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---- helpers reused from the app (same prompts, same code paths) ----
const appSrc = fs.readFileSync(path.join(ROOT, 'slack-data-agent', 'app.js'), 'utf8');
const ROUTER_SYSTEM = appSrc.match(/const ROUTER_SYSTEM = `([\s\S]*?)`;/)[1];

async function openai(system, user) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ] }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const p = await r.json();
  const msg = (p.output || []).find(o => o.type === 'message');
  return ((msg?.content || []).find(c => c.type === 'output_text')?.text || '');
}
function parseJson(t) {
  t = t.replace(/```(json)?/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}
const route = async text => parseJson(await openai(ROUTER_SYSTEM, text));

// ════════════════════════════ A · AI intent router ════════════════════════════
async function sectionA() {
  const expect = async (id, text, intent, extra) => test(id, `route: "${text}"`, async () => {
    const r = await route(text);
    assert(r.intent === intent, `expected ${intent}, got ${JSON.stringify(r)}`);
    if (extra) extra(r);
    return `→ ${JSON.stringify(r)}`;
  });
  await expect('A01', 'help', 'help');
  await expect('A02', 'what can you do?', 'help');
  await expect('A03', 'where I am?', 'context');
  await expect('A04', '¿dónde estoy trabajando?', 'context');                       // edge: Spanish
  await expect('A05', 'USE CATALOG Finance!!!', 'use_catalog', r => assert(/finance/i.test(r.name), `name=${r.name}`)); // edge: caps+punctuation
  await expect('A06', 'switch me over to the sales schema please', 'use_schema', r => assert(/sales/i.test(r.name), `name=${r.name}`));
  await expect('A07', 'generate 20 fake vendors with contact emails', 'generate_data', r => assert(r.source === 'synthetic', `source=${r.source}`));
  await expect('A08', 'create a table of the top 10 countries by population', 'generate_data', r => assert(r.source === 'real', `source=${r.source}`));
  await expect('A09', "let's crate a dashboard", 'dashboard');                        // edge: typo
  await expect('A10', 'I want to draw a dashboard', 'draw_dashboard');
  await expect('A11', 'let me sketch a table for you', 'draw_table');
  await expect('A12', 'how many signups per country?', 'query');
  await expect('A13', 'delete all the inactive users', 'query');
  await test('A14', 'route edge: gibberish falls back safely', async () => {
    const r = await route('asdf qwerty zzz 🔥');
    assert(typeof r.intent === 'string', 'router crashed');
    return `→ ${r.intent}`;
  });
}

// ════════════════════════════ B · NL→SQL + safety guard ════════════════════════════
async function sectionB() {
  const { planQuery, runPlanned, looksDegenerate } = await import(path.join(ROOT, 'slack-data-agent', 'nl2sql.js'));
  const { classify } = await import(path.join(ROOT, 'slack-data-agent', 'guard.js'));
  const ctx = { catalog: CATALOG, schema: SCHEMA };

  let readPlan;
  await test('B01', 'read query plans without confirmation', async () => {
    readPlan = await planQuery('how many signups per country?', ctx);
    assert(readPlan.ok, readPlan.reason);
    assert(readPlan.kind === 'read', `kind=${readPlan.kind}`);
    assert(!readPlan.needsConfirmation, 'read should not need confirmation');
    return readPlan.sql;
  });
  await test('B02', 'read query executes and returns rows', async () => {
    const out = await runPlanned(readPlan, ctx);
    assert(out.rows.length > 0, 'no rows');
    return `${out.rows.length} rows, first: ${JSON.stringify(out.rows[0])}`;
  });
  await test('B03', 'listing: "list the tables" → SHOW, executable', async () => {
    const p = await planQuery('list the tables', ctx);
    assert(p.ok && /show\s+tables/i.test(p.sql), p.sql || p.reason);
    const out = await runPlanned(p, ctx);
    assert(out.rows.length > 0, 'no tables listed');
    return `${out.rows.length} tables`;
  });
  await test('B04', 'DDL: create schema plans as CREATE (not executed)', async () => {
    const p = await planQuery('create a schema called qa_e2e_scratch', ctx);
    assert(p.ok && /create\s+schema/i.test(p.sql), p.sql || p.reason);
    return `${p.sql} · needsConfirmation=${p.needsConfirmation}`;
  });
  await test('B05', 'destructive: DROP requires confirmation (not executed)', async () => {
    const p = await planQuery('drop the hackathon_signups_bronze table', ctx);
    assert(p.ok && p.needsConfirmation === true, `needsConfirmation=${p.needsConfirmation} sql=${p.sql}`);
    return p.sql;
  });
  await test('B06', 'guard: stacked statements rejected', async () => {
    const v = classify('SELECT 1; DROP TABLE t');
    assert(v.ok === false, `classified ok=${v.ok}`);
    return v.reason || 'rejected';
  });
  await test('B07', 'guard edge: destructive keyword inside a string literal is READ', async () => {
    const v = classify(`SELECT * FROM t WHERE note = 'please drop table x'`);
    assert(v.ok === true && v.kind === 'read', `kind=${v.kind}`);
    return 'read, not destructive';
  });
  await test('B08', 'degenerate SQL detector catches empty IN-lists', async () => {
    const bad = looksDegenerate(`SELECT * FROM t WHERE c IN ('', '')`);
    assert(bad, 'not flagged');
    return bad;
  });
  await test('B09', 'unanswerable question fails gracefully', async () => {
    const p = await planQuery('what is the average weight of a unicorn?', ctx);
    assert(p.ok === false || p.sql === '', `unexpected: ${JSON.stringify(p).slice(0, 120)}`);
    return p.reason || 'declined with reason';
  });
}

// ════════════════════════════ C · data generation ════════════════════════════
async function sectionC() {
  const { synthetic, fromSearch } = await import(path.join(ROOT, 'datagen', 'datagen.js'));
  const { analyseCsv } = await import(path.join(ROOT, 'csv-to-db', 'csv.js'));

  await test('C01', 'synthetic data: 5 fake employees', async () => {
    const g = await synthetic('5 fake employees with name and salary');
    const { columns, dataRows } = analyseCsv(g.csv);
    assert(dataRows.length >= 4 && columns.length >= 2, `${dataRows.length} rows, ${columns.length} cols`);
    return `${dataRows.length} rows · cols: ${columns.map(c => c.name).join(',')}`;
  });
  await test('C02', 'real data via Perplexity: cited figures', async () => {
    const g = await fromSearch('top 5 countries by population');
    const { dataRows } = analyseCsv(g.csv);
    assert(dataRows.length >= 3, `${dataRows.length} rows`);
    assert(g.citations.length > 0, 'no citations');
    return `${dataRows.length} rows · ${g.citations.length} citations`;
  });
  await test('C03', 'CSV edge: quoted comma inside a value', async () => {
    const { columns, dataRows } = analyseCsv('name,notes\nAda,"loves x, y"\n');
    assert(columns.length === 2 && dataRows[0][1] === 'loves x, y', JSON.stringify(dataRows));
    return 'parsed correctly';
  });
}

// ════════════════════════════ D · chart specs + Tableau builds ════════════════════════════
async function sectionD() {
  const { describeToSpec } = await import(path.join(ROOT, 'viz-builder', 'spec.js'));
  const { buildAndDeploy } = await import(path.join(ROOT, 'viz-builder', 'deploy.js'));
  const appTM = appSrc.match(/async function tablesMentioned[\s\S]*?\n}/)[0];
  const tablesMentioned = new Function('return ' + appTM.replace('async function tablesMentioned', 'async function'))();
  const ALL = ['countries_gdp', 'countries_population', 'hackathon_signups', 'hackathon_signups_gold', 'world_perspectives_sample'];

  await test('D01', 'vague request anchors NO table (bot must ask)', async () => {
    const named = await tablesMentioned("let's create a dashboard", ALL);
    assert(named.length === 0, `unexpectedly matched ${named}`);
    return 'asks the user, as designed';
  });
  await test('D02', 'fuzzy table reference resolves via model', async () => {
    const named = await tablesMentioned('chart the signups table', ALL);
    assert(named.includes('hackathon_signups'), JSON.stringify(named));
    return `→ ${named}`;
  });
  await test('D03', 'bar spec for a named table', async () => {
    const r = await describeToSpec(CATALOG, SCHEMA, ['hackathon_signups'], 'signups per country as a bar chart');
    assert(r.ok && ['bar', 'hbar'].includes(r.spec.chartType), JSON.stringify(r).slice(0, 150));
    return `${r.spec.chartType}: ${r.spec.dimension} × ${r.spec.aggregation}(${r.spec.measure})`;
  });
  await test('D04', 'pie spec for share-per-category', async () => {
    const r = await describeToSpec(CATALOG, SCHEMA, ['countries_gdp'], 'a pie chart of gdp share by country');
    assert(r.ok && r.spec.chartType === 'pie', JSON.stringify(r.spec || r).slice(0, 150));
    return `pie: ${r.spec.dimension} × ${r.spec.measure}`;
  });
  await test('D05', 'treemap → model speaks raw VizQL', async () => {
    const r = await describeToSpec(CATALOG, SCHEMA, ['countries_gdp'], 'a treemap of gdp by country');
    assert(r.ok && r.spec.vizql?.mark === 'Square', JSON.stringify(r.spec?.vizql || r).slice(0, 150));
    return `vizql mark=Square, encodings: ${r.spec.vizql.encodings.map(e => e.shelf).join(',')}`;
  });
  await test('D06', 'edge: nonsense column request stays schema-valid', async () => {
    const r = await describeToSpec(CATALOG, SCHEMA, ['countries_gdp'], 'chart the flurbles by zorp from countries_gdp');
    // Either a graceful refusal or a spec using only real columns — never a crash or invented column.
    if (r.ok) assert(['Country', 'Nominal_GDP_USD_Trillions_', 'Year'].includes(r.spec.dimension) || !r.spec.dimension, `invented ${r.spec.dimension}`);
    return r.ok ? `coped: ${r.spec.dimension}×${r.spec.measure}` : `refused: ${r.reason.slice(0, 80)}`;
  });
  await test('D07', 'FULL BUILD: bar chart published to Tableau + PNG', async () => {
    const spec = { table: 'hackathon_signups', chartType: 'bar', dimension: 'country_code', measure: 'signup_id', aggregation: 'COUNT', title: 'QA Signups by Country', sheetName: 'QA Signups by Country' };
    const r = await buildAndDeploy(spec, { workbookName: 'QA e2e bar', outDir: os.tmpdir(), catalog: CATALOG, schema: SCHEMA });
    assert(r.bytes > 5000 && r.workbookId, `bytes=${r.bytes}`);
    return `workbook ${r.workbookId.slice(0, 8)}… · PNG ${r.bytes} bytes`;
  });
  await test('D08', 'FULL BUILD: pie with legend/labels published + PNG', async () => {
    const spec = { table: 'countries_gdp', chartType: 'pie', dimension: 'Country', measure: 'Nominal_GDP_USD_Trillions_', aggregation: 'SUM', title: 'QA GDP Share', sheetName: 'QA GDP Share' };
    const r = await buildAndDeploy(spec, { workbookName: 'QA e2e pie', outDir: os.tmpdir(), catalog: CATALOG, schema: SCHEMA });
    assert(r.bytes > 20000, `bytes=${r.bytes} (legend+labels should make it >20KB)`);
    return `PNG ${r.bytes} bytes (labels+legend present)`;
  });
}

// ════════════════════════════ E · vision: PDF + whiteboard ════════════════════════════
async function sectionE() {
  await test('E01', 'scanned PDF → typed table (OpenAI vision)', async () => {
    const { extractPdf } = await import(path.join(ROOT, 'pdf-extract', 'extract.js'));
    const pdf = fs.readFileSync(path.join(ROOT, 'pdf-extract', 'samples', 'patient_record_scan.pdf'));
    const r = await extractPdf(pdf, {});
    assert(r.rows.length > 0 && r.columns.length > 1, `${r.rows.length} rows`);
    return `${r.columns.length} cols × ${r.rows.length} rows via ${r.via}`;
  });
  await test('E02', 'whiteboard table sketch → Databricks table', async () => {
    const img = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'sketch-table.png')).toString('base64');
    const r = await fetch(`${WB}/extract`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: `data:image/png;base64,${img}`, table: 'qa_e2e_fruit' }),
    }).then(x => x.json());
    assert(r.ok, r.message || r.error);
    assert(r.rowsInserted >= 2, `${r.rowsInserted} rows`);
    return `${r.table} · ${r.rowsInserted} rows · cols: ${r.columns.join(',')}`;
  });
  await test('E03', 'whiteboard pie sketch + hint → published dashboard', async () => {
    const img = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'sketch-pie.png')).toString('base64');
    const r = await fetch(`${WB}/dashboard`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: `data:image/png;base64,${img}`, hint: 'countries_gdp', channel: '' }),
    }).then(x => x.json());
    assert(r.ok, `${r.message || r.error} (read as: ${r.described || 'n/a'})`);
    assert(r.table === 'countries_gdp', `hint ignored: used ${r.table}`);
    assert(r.png && r.url, 'missing png/url');
    return `read as "${r.described.slice(0, 60)}…" → ${r.chartType} from ${r.table}`;
  });
}

// ════════════════════════════ F · voice round-trip (ElevenLabs) ════════════════════════════
async function sectionF() {
  await test('F01', 'TTS → STT round-trip preserves the question', async () => {
    const phrase = 'How many signups per country?';
    const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: phrase, model_id: 'eleven_turbo_v2_5' }),
    });
    assert(tts.ok, `TTS ${tts.status}`);
    const mp3 = Buffer.from(await tts.arrayBuffer());
    assert(mp3.length > 5000, `mp3 ${mp3.length} bytes`);
    const form = new FormData();
    form.append('model_id', 'scribe_v1');
    form.append('file', new Blob([mp3], { type: 'audio/mpeg' }), 'q.mp3');
    const stt = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, body: form,
    });
    assert(stt.ok, `STT ${stt.status}`);
    const text = (await stt.json()).text || '';
    assert(/signups?/i.test(text) && /country/i.test(text), `transcribed: "${text}"`);
    return `spoke ${mp3.length}B of audio, heard back: "${text.trim()}"`;
  });
}

// ════════════════════════════ cleanup + report ════════════════════════════
async function cleanup() {
  try {
    const { runSql } = await import(path.join(ROOT, 'slack-data-agent', 'databricks.js'));
    await runSql(`DROP TABLE IF EXISTS ${CATALOG}.${SCHEMA}.qa_e2e_fruit`);
    console.error('🧹 dropped qa_e2e_fruit');
  } catch (e) { console.error(`cleanup: ${e.message}`); }
}

const t0 = Date.now();
await sectionA(); await sectionB(); await sectionC(); await sectionD(); await sectionE(); await sectionF();
await cleanup();

const pass = results.filter(r => r.pass).length;
console.log(`# Data Wizard — end-to-end test report\n`);
console.log(`**${pass}/${results.length} passed** · ${Math.round((Date.now() - t0) / 1000)}s total · ${new Date().toISOString()}\n`);
console.log(`| # | Test | Result | Detail | ms |`);
console.log(`|---|------|--------|--------|----|`);
for (const r of results) console.log(`| ${r.id} | ${r.name.replace(/\|/g, '\\|')} | ${r.pass ? '✅' : '❌'} | ${String(r.note).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160)} | ${r.ms} |`);
console.log(`\n## Manual-only cases (need a live Slack client)\n`);
console.log(`- M01 Voice note in Slack → transcription + table + spoken clip (verified by hand 2026-07-13)`);
console.log(`- M02 CSV drop → Card + Data Table preview → Load modal (placeholder→form on cold warehouse)`);
console.log(`- M03 Destructive confirm/cancel buttons; SQL never runs before the click`);
console.log(`- M04 "draw a dashboard" → whiteboard link button → chart posts back to the channel`);
console.log(`- M05 Dashboard table-picker select → chart built from the chosen table`);
console.log(`- M06 Bot's own uploads (mp3/PNG) do not re-trigger file_shared`);
process.exit(pass === results.length ? 0 : 1);
