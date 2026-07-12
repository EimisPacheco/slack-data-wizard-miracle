/**
 * Natural-language description -> Tableau viz spec, validated against the live Databricks schema.
 * Uses the same model provider as the rest of Data Wizard (NL2SQL_PROVIDER: gemma | openai).
 */
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const dbx = await import(path.join(ROOT, 'slack-data-agent', 'databricks.js'));

const PROVIDER = () => (process.env.NL2SQL_PROVIDER || 'gemma').toLowerCase();

const SYSTEM = `You turn a request for a chart into a Tableau visualization spec.

Reply with JSON only:
{
  "table": "<one of the given tables>",
  "chartType": "bar|hbar|line|scatter|map|table",
  "dimension": "<categorical or date column to group by>",
  "measure": "<numeric column to aggregate; for a count use any id-like column>",
  "aggregation": "SUM|AVG|COUNT|COUNTD",
  "geoField": "<country column, ONLY when chartType is map>",
  "colorField": "<optional column to colour by>",
  "dateGranularity": "day|month|year (only if dimension is a date)",
  "title": "<short human title>",
  "explanation": "<one sentence describing the chart>"
}

RULES:
- Use ONLY tables and columns from the schema provided. Never invent names.
- map requires a column of country names or ISO codes in geoField.
- line requires a date/timestamp dimension.
- hbar suits many categories or long labels; bar suits few.
- For "how many X", use aggregation COUNT.
- Omit fields that don't apply.
- If it can't be charted from the schema, set "table" to "" and say why in "explanation".`;

/** Columns for each table in the active Databricks namespace. */
export async function schemaOf(catalog, schema, tables) {
  const out = {};
  for (const t of tables) out[t] = await dbx.describeTable(catalog, schema, t);
  return out;
}

export async function listTables(catalog, schema) {
  return dbx.listTables(catalog, schema);
}

function schemaText(s) {
  return Object.entries(s).map(([t, cols]) => `${t}(${cols.map(c => `${c.name} ${c.type}`).join(', ')})`).join('\n');
}

async function callModel(system, user) {
  if (PROVIDER() === 'openai') {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
        input: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 150)}`);
    const p = await r.json();
    const msg = (p.output || []).find(o => o.type === 'message');
    return (msg?.content || []).find(c => c.type === 'output_text')?.text || '';
  }
  const base = (process.env.GEMMA_BASE_URL || '').replace(/\/$/, '');
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.GEMMA_MODEL || 'gemma4:31b',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false, think: false, format: 'json', options: { temperature: 0 },
    }),
  });
  if (!r.ok) throw new Error(`Gemma ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return (await r.json()).message?.content || '';
}

/** description + tables -> validated spec */
export async function describeToSpec(catalog, schema, tables, description) {
  const s = await schemaOf(catalog, schema, tables);
  const raw = await callModel(SYSTEM, `Tables:\n${schemaText(s)}\n\nRequest: ${description}`);

  let text = raw.replace(/```(json)?/g, '').trim();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a !== -1 && b > a) text = text.slice(a, b + 1);

  let spec;
  try { spec = JSON.parse(text); }
  catch { return { ok: false, reason: `Model did not return a spec: ${text.slice(0, 100)}` }; }

  if (!spec.table) return { ok: false, reason: spec.explanation || 'Cannot chart that from these tables' };

  // The model still occasionally invents a column — validate against the real schema.
  const cols = new Set((s[spec.table] || []).map(c => c.name.toLowerCase()));
  if (!cols.size) return { ok: false, reason: `Unknown table "${spec.table}"` };
  for (const k of ['dimension', 'measure', 'geoField', 'colorField']) {
    if (spec[k] && !cols.has(String(spec[k]).toLowerCase())) {
      return { ok: false, reason: `Model referenced unknown column "${spec[k]}" on ${spec.table}` };
    }
  }
  return { ok: true, spec };
}
