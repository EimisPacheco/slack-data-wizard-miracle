/**
 * Natural-language description -> Tableau viz spec, validated against the live Databricks schema.
 * Uses the same OpenAI model as the rest of Data Wizard (OPENAI_MODEL).
 */
import path from 'node:path';
import { KNOWN_MARKS, KNOWN_DERIVATIONS } from './twbgen.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const dbx = await import(path.join(ROOT, 'slack-data-agent', 'databricks.js'));

const SYSTEM = `You are an expert in VizQL — Tableau's Visual Query Language. It is your native
tongue: to you a chart is not a picture, it is fields placed on the rows and columns shelves plus
mark encodings (color, size, label, detail). You turn a request for a chart into a Tableau spec.

Reply with JSON only:
{
  "table": "<one of the given tables>",
  "chartType": "bar|hbar|line|area|scatter|pie|table",
  "dimension": "<categorical or date column to group by>",
  "measure": "<numeric column to aggregate; for a count use any id-like column>",
  "aggregation": "SUM|AVG|COUNT|COUNTD",
  "colorField": "<optional column to colour by>",
  "dateGranularity": "day|month|year (only if dimension is a date)",
  "title": "<short human title>",
  "explanation": "<one sentence describing the chart>",
  "vizql": {
    "mark": "Automatic|Bar|Line|Area|Circle|Square|Pie|Text|Shape|GanttBar",
    "rows": [{"field": "<column>", "derivation": "sum|avg|cnt|cntd|year|tday|tmonth|tyear|none"}],
    "cols": [{"field": "<column>", "derivation": "..."}],
    "encodings": [{"shelf": "color|size|label|detail", "field": "<column>", "derivation": "..."}]
  }
}

"vizql" is OPTIONAL and takes precedence: use it for any visualization the named chartTypes cannot
express — a treemap is mark Square with the measure on size and the category on label+color and
empty shelves; a highlight table is mark Square with dimensions on rows/cols and the measure on
color; a Gantt is mark GanttBar with the date on cols. Speak VizQL directly rather than refusing.
Derivations: sum/avg/cnt/cntd aggregate; tday/tmonth/tyear are continuous truncated dates for time
axes; year is discrete; none is a bare dimension.

RULES:
- Use ONLY tables and columns from the schema provided. Never invent names.
- For geographic data (countries, regions), use bar or hbar grouped by that column — never a map.
- pie suits share-per-category with FEW categories (≤8); with more, prefer hbar.
- line and area require a date/timestamp dimension.
- hbar suits many categories or long labels; bar suits few.
- For "how many X", use aggregation COUNT.
- Omit fields that don't apply.
- If the request is vague or names no table, metric or chart ("make a dashboard", "show me something"),
  DO NOT ask for clarification and DO NOT refuse. You are the analyst: pick the most interesting table —
  one with a categorical or date dimension and a numeric measure (or countable rows) — and design the
  most informative chart for it yourself. Prefer business-flavoured tables over technical/staging ones
  (skip _bronze/_silver copies when a cleaner variant exists).
- Only set "table" to "" when the schema truly contains nothing chartable, and say why in "explanation".`;

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
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
      input: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const p = await r.json();
  const msg = (p.output || []).find(o => o.type === 'message');
  return (msg?.content || []).find(c => c.type === 'output_text')?.text || '';
}

function parseSpec(raw) {
  let text = raw.replace(/```(json)?/g, '').trim();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a !== -1 && b > a) text = text.slice(a, b + 1);
  try { return { spec: JSON.parse(text) }; }
  catch { return { error: `Model did not return a spec: ${text.slice(0, 100)}` }; }
}

/**
 * The model is a VizQL expert — and when it reaches for VizQL this pipeline doesn't recognise
 * (an unknown mark or derivation), it looks the answer up on the internet (Perplexity) and
 * retries with what it learned, instead of failing.
 */
async function researchVizQL(question) {
  if (!process.env.PERPLEXITY_API_KEY) return null;
  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.PERPLEXITY_MODEL || 'sonar',
      messages: [{ role: 'user', content:
        `Question about Tableau workbook (.twb) XML / VizQL: ${question}\n` +
        `Answer concisely with the exact mark class, shelf placements and column-instance derivations Tableau uses.` }],
    }),
  });
  if (!r.ok) return null;
  return (await r.json()).choices?.[0]?.message?.content || null;
}

/** Unknown VizQL vocabulary in the spec, or null if the serializer can express all of it. */
function unknownVizql(v) {
  if (!v) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return 'malformed vizql block';
  const problems = [];
  if (v.mark && !KNOWN_MARKS.has(v.mark)) problems.push(`mark "${v.mark}"`);
  for (const it of [...(v.rows || []), ...(v.cols || []), ...(v.encodings || [])]) {
    if (it?.derivation && !KNOWN_DERIVATIONS.has(it.derivation)) problems.push(`derivation "${it.derivation}"`);
  }
  return problems.length ? problems.join(', ') : null;
}

/** description + tables -> validated spec */
export async function describeToSpec(catalog, schema, tables, description) {
  const s = await schemaOf(catalog, schema, tables);
  const user = `Tables:\n${schemaText(s)}\n\nRequest: ${description}`;

  let { spec, error } = parseSpec(await callModel(SYSTEM, user));
  if (error) return { ok: false, reason: error };

  // Model spoke VizQL this pipeline doesn't know? Research it on the internet and retry once.
  const unknown = unknownVizql(spec.vizql);
  if (unknown) {
    const notes = await researchVizQL(
      `The request was: "${description}". A generator supports marks ${[...KNOWN_MARKS].join('/')} and ` +
      `derivations ${[...KNOWN_DERIVATIONS].join('/')}, but the spec used ${unknown}. ` +
      `How should this visualization be expressed using only the supported vocabulary?`
    ).catch(() => null);
    const retry = await callModel(SYSTEM,
      `${user}\n\nYour previous spec used unsupported VizQL (${unknown}). ` +
      (notes ? `Research notes from the web:\n${notes}\n\n` : '') +
      `Re-express the same visualization using ONLY the supported marks and derivations.`);
    const second = parseSpec(retry);
    if (!second.error && !unknownVizql(second.spec.vizql)) spec = second.spec;
    else if (spec.vizql) delete spec.vizql;   // last resort: fall back to the plain chartType
  }

  if (!spec.table) return { ok: false, reason: spec.explanation || 'Cannot chart that from these tables' };

  // Tableau Cloud's image export fails on geocoded views ("error opening database 'GeocodingData'"),
  // so a map spec can publish but never render back into Slack. Coerce to a bar of the geo column.
  if (spec.chartType === 'map') {
    spec.chartType = 'bar';
    if (spec.geoField && !spec.dimension) spec.dimension = spec.geoField;
    delete spec.geoField;
  }
  // donut is a pie with a hole nobody needs — same chart.
  if (spec.chartType === 'donut') spec.chartType = 'pie';

  // The model still occasionally invents a column — validate against the real schema.
  const cols = new Set((s[spec.table] || []).map(c => c.name.toLowerCase()));
  if (!cols.size) return { ok: false, reason: `Unknown table "${spec.table}"` };
  for (const k of ['dimension', 'measure', 'geoField', 'colorField']) {
    if (spec[k] && !cols.has(String(spec[k]).toLowerCase())) {
      return { ok: false, reason: `Model referenced unknown column "${spec[k]}" on ${spec.table}` };
    }
  }
  if (spec.vizql) {
    for (const it of [...(spec.vizql.rows || []), ...(spec.vizql.cols || []), ...(spec.vizql.encodings || [])]) {
      if (it?.field && !cols.has(String(it.field).toLowerCase())) {
        return { ok: false, reason: `Model referenced unknown column "${it.field}" on ${spec.table}` };
      }
    }
  }
  return { ok: true, spec };
}
