#!/usr/bin/env node
/** Checks every dependency the agent needs, without starting Slack. */
import fs from 'node:fs';
import path from 'node:path';

for (const line of fs.readFileSync(path.resolve(import.meta.dirname, '../.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { console.log(`  ❌ ${m}`); failures++; };
let failures = 0;

console.log('env:');
for (const k of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'OPENAI_API_KEY',
  'DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'DATABRICKS_WAREHOUSE_ID']) {
  process.env[k] ? ok(k) : bad(`${k} is empty`);
}

console.log('\ndatabricks:');
try {
  const { runSql, listCatalogs } = await import('./databricks.js');
  const who = await runSql('SELECT current_user() u, current_catalog() c');
  ok(`warehouse reachable — user ${who.rowObjects[0].u}`);
  ok(`catalogs: ${(await listCatalogs()).join(', ')}`);
  const cat = process.env.DATABRICKS_CATALOG || 'workspace';
  const sch = process.env.DATABRICKS_SCHEMA || 'data_wizard';
  const { ensureSchema } = await import('./databricks.js');
  await ensureSchema(cat, sch);
  ok(`default namespace ${cat}.${sch} ready`);
} catch (e) { bad(`databricks: ${e.message}`); }

console.log('\nSQL generation (queries & questions):');
{
  const p = (process.env.NL2SQL_PROVIDER || 'gemma').toLowerCase();
  if (p === 'openai') ok(`provider: OpenAI (${process.env.OPENAI_MODEL || 'gpt-5.6-terra'})`);
  else ok(`provider: Gemma (${process.env.GEMMA_MODEL || 'gemma4:31b'}) on the AMD GPU  ·  set NL2SQL_PROVIDER=openai to switch back`);
}

console.log('\ngemma vision (scanned-PDF extraction):');
try {
  const base = (process.env.GEMMA_BASE_URL || '').replace(/\/$/, '');
  if (!base && !process.env.FIREWORKS_API_KEY) {
    console.log('  ⚠️  no GEMMA_BASE_URL or FIREWORKS_API_KEY — PDF upload disabled (CSV still works)');
  } else if (base) {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) }).then(x => x.json()).catch(() => null);
    const model = process.env.GEMMA_MODEL || 'gemma4:31b';
    const has = r?.models?.some(m => m.name === model);
    has ? ok(`droplet reachable — ${model} loaded`)
        : console.log(`  ⚠️  droplet ${base} not reachable or ${model} missing${process.env.FIREWORKS_API_KEY ? ' (Fireworks fallback set)' : ''}`);
  } else {
    ok('Fireworks fallback configured');
  }
} catch (e) { console.log(`  ⚠️  gemma check: ${e.message}`); }

console.log('\nopenai:');
try {
  const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
  res.ok ? ok(`API key valid (HTTP ${res.status})`) : bad(`API key rejected (HTTP ${res.status})`);
} catch (e) { bad(`openai: ${e.message}`); }

console.log('\nperplexity (real-data generation):');
try {
  if (!process.env.PERPLEXITY_API_KEY) {
    console.log('  ⚠️  PERPLEXITY_API_KEY not set — "real data" generation disabled (synthetic still works)');
  } else {
    const r = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.PERPLEXITY_MODEL || 'sonar', messages: [{ role: 'user', content: 'Reply with the word OK.' }] }),
    });
    if (r.ok) ok(`key valid (${process.env.PERPLEXITY_MODEL || 'sonar'})`);
    else if (r.status === 401) bad('Perplexity rejected key (401 — check PERPLEXITY_API_KEY)');
    else bad(`Perplexity HTTP ${r.status}: ${(await r.text()).slice(0, 80)}`);
  }
} catch (e) { bad(`perplexity: ${e.message}`); }

console.log('\nguard (safety classifier):');
try {
  const { classify } = await import('./guard.js');
  const checks = [
    ['SELECT 1', true, 'read'],
    ['DROP TABLE t', true, 'destructive'],
    ['SELECT 1; DROP TABLE t', false, null],
    ['CREATE OR REPLACE TABLE t AS SELECT 1', true, 'destructive'],
  ];
  let g = 0;
  for (const [sql, eok, ek] of checks) {
    const r = classify(sql);
    if (r.ok === eok && (ek === null || r.kind === ek)) g++;
    else bad(`classify("${sql}") => ok=${r.ok} kind=${r.kind}`);
  }
  if (g === checks.length) ok(`${g}/${checks.length} classifier checks pass`);
} catch (e) { bad(`guard: ${e.message}`); }

console.log(failures ? `\n${failures} problem(s) found.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
