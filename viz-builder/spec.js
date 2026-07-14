/**
 * Natural-language description -> Tableau viz spec, validated against the live Databricks schema.
 * Uses the same OpenAI model as the rest of Data Wizard (OPENAI_MODEL).
 */
import path from 'node:path';
import { KNOWN_MARKS, KNOWN_DERIVATIONS } from './twbgen.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const dbx = await import(path.join(ROOT, 'slack-data-agent', 'databricks.js'));
const { callVision } = await import(path.join(ROOT, 'pdf-extract', 'vision.js'));

/**
 * Vision critic: the model LOOKS at the chart it just produced and judges whether it's actually
 * readable — overlapping labels, too many pie slices, a cramped plot. If a different chart type
 * from our vocabulary would clearly read better, it says so, and buildAndDeploy rebuilds once.
 * This is the same "AI validates its own output" principle as the SQL guard, applied to pixels.
 * @returns {Promise<{good:boolean, reason:string, betterChartType:string|null}>}
 */
export async function critiqueChart(pngBuffer, spec, description = '') {
  if (!process.env.OPENAI_API_KEY) return { good: true, reason: 'no critic', betterChartType: null };
  const prompt =
`You are a strict data-visualization critic. This image is a "${spec.chartType}" chart just rendered ` +
`for the request: "${description || spec.title || 'a chart'}".
Judge ONLY its visual quality as shown:
- Are any labels overlapping, colliding, or unreadable?
- Is the chart type appropriate for how many categories are visible? (A pie with more than ~6 slices,
  or with tiny crowded slices, is hard to read — a horizontal bar chart is almost always clearer.)
- Is the plot cramped or well proportioned?
Reply with JSON only:
{"good": true|false, "reason": "<one short phrase>", "betterChartType": "bar|hbar|line|area|scatter|pie|null"}
Set "betterChartType" ONLY if switching to that type (from bar/hbar/line/area/scatter/pie) would clearly
be more readable for THIS data; otherwise null. Prefer "hbar" for many categories or long labels.`;
  try {
    const text = await callVision(prompt, pngBuffer);
    let t = text.replace(/```(json)?/g, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a !== -1 && b > a) t = t.slice(a, b + 1);
    const v = JSON.parse(t);
    const better = KNOWN_CHART_TYPES.has(v.betterChartType) ? v.betterChartType : null;
    return { good: v.good !== false, reason: String(v.reason || ''), betterChartType: better };
  } catch { return { good: true, reason: 'critic unavailable', betterChartType: null }; }
}
const KNOWN_CHART_TYPES = new Set(['bar', 'hbar', 'line', 'area', 'scatter', 'pie']);

/**
 * SELF-HEALING critic. The model — an expert in VizQL that already looks at its own charts —
 * judges whether the RENDER actually represents the data correctly and meaningfully (not just
 * "is it readable"). If it's broken (a flat line that should vary, a single point, a blank or
 * unreadable plot, the wrong chart for the data), it DIAGNOSES the problem and REGENERATES a
 * corrected chart itself via describeToSpec. This is the project's own thesis applied to its
 * output: the AI recognizes and fixes its own work instead of us hand-coding each failure.
 *
 * @returns {Promise<{good:boolean, problem?:string, newSpec?:object}>}
 */
export async function healChart(pngBuffer, spec, description, catalog, schema, dataFacts = '') {
  if (!process.env.OPENAI_API_KEY) return { good: true };
  const prompt =
`You are a strict Tableau/VizQL data-visualization critic, and you FIX your own work.
This image is a chart just rendered for the request: "${description || spec.title || 'a chart'}".
Underlying data (already aggregated for the chart): ${dataFacts || 'unknown'}.

Judge whether the chart is CORRECT and MEANINGFUL for that data — not merely pretty:
- BROKEN: a HORIZONTAL flat line (the same value across every x), a SINGLE point/dot, a blank or
  near-empty plot, or a chart whose visible values clearly don't match the data above. These mean
  the data was not grouped or plotted correctly.
- BROKEN: labels overlapping to the point of being unreadable, or a chart type that fights the data
  (e.g. a pie with many tiny crowded slices).
- BROKEN/uninsightful: a PERFECTLY straight line (constant slope) or bars all the SAME height. The
  plotted field is uniform, so the chart reveals nothing and is not a valid chart. Unless the request
  explicitly asked for a cumulative total or growth-to-date, treat this as broken and regenerate over
  a DIFFERENT dimension that actually varies (e.g. a category/status breakdown).
- GOOD: a line with real ups and downs, bars of differing heights, a pie with differing slices — a
  clean readable chart whose shape matches the data and shows how it differs. Do not "fix" a chart
  that already shows real variation.

Judge the chart ONLY on whether it is valid, readable and reveals THIS data. Do NOT flag it merely
because its TYPE differs from what was asked or sketched — the expert may have deliberately chosen a
better-suited type (a bar/hbar instead of a pie that would be too crowded, for instance). A clean,
appropriate bar is GOOD even when a pie was requested; never regenerate a chart just to match a
requested chart type.

Reply with JSON only: {"good": true|false, "problem": "<one short phrase — what's wrong, or empty>"}`;
  let verdict;
  try {
    const text = await callVision(prompt, pngBuffer);
    let t = text.replace(/```(json)?/g, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a !== -1 && b > a) t = t.slice(a, b + 1);
    verdict = JSON.parse(t);
  } catch { return { good: true }; }         // critic unavailable → trust the build
  if (verdict.good !== false) return { good: true };

  // Broken → let the VizQL expert regenerate a corrected chart, told exactly what went wrong.
  const problem = String(verdict.problem || 'the chart did not represent the data correctly');
  try {
    const fixed = await describeToSpec(catalog, schema, [spec.table],
      `${description || spec.title}\n\nThe chart just produced was BROKEN: ${problem}. ` +
      `Design a CORRECTED, meaningful chart for this exact data — a different chart type, aggregation, ` +
      `or VizQL if that reads better. Prefer a clear VISUAL chart (a horizontal bar handles many ` +
      `categories or long labels well); use a plain table only if the data genuinely cannot be charted. ` +
      `Do not repeat the broken result.`);
    if (fixed.ok) { fixed.spec.sheetName = fixed.spec.title || spec.sheetName || 'Viz'; return { good: false, problem, newSpec: fixed.spec }; }
  } catch { /* fall through */ }
  return { good: false, problem };            // couldn't regenerate — report, keep what we have
}

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
- REASON about the DATA PROFILE first: a chart must make sense for the actual data. Only chart a
  field where the measure VARIES across it (the profile marks these "VARIES ✓"). NEVER build a chart
  on a field the profile says is CONSTANT/uniform or all-equal — it renders a flat or perfectly
  straight line that shows nothing and is not a valid chart. In particular, do NOT put an evenly-
  spread date on a line/area if its per-day count is constant; pick a categorical dimension that
  varies instead (e.g. a country/status/category breakdown). Near-unique columns (id, name, email)
  are never grouping dimensions. Choose the single view that best reveals how the data actually
  differs, and title it for that story.
- Use ONLY tables and columns from the schema provided. Never invent names.
- For geographic data (countries, regions), use bar or hbar grouped by that column — never a map.
- pie suits share-per-category with FEW categories (≤8); with more, prefer hbar.
- If the request or sketch implies a chart type that does NOT suit this data (e.g. a pie drawn for a
  table with many categories, or a line where the date is uniform), pick the type that DOES suit it
  and EXPLAIN the swap in "explanation" — e.g. "A pie would be unreadable with 40 countries, so I used
  a horizontal bar." Never silently force an unsuitable chart, and never refuse — adapt and explain.
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

/**
 * A compact statistical profile of a table so the EXPERT can REASON about what chart actually makes
 * sense for THIS data — which fields VARY (worth charting) and which are uniform or unique (a flat/
 * straight line, or an unusable axis). Best-effort, bounded, run in parallel; never blocks a spec.
 */
async function profileTable(catalog, schema, table, cols) {
  const fq = `\`${catalog}\`.\`${schema}\`.\`${table}\``;
  const run = sql => dbx.runSql(sql).then(r => r.rows).catch(() => null);
  const isDate = t => /date|timestamp/.test(t);
  const isNum = t => /int|double|float|decimal|numeric/.test(t);

  const distSel = cols.map((c, i) => `COUNT(DISTINCT \`${c.name}\`) AS d${i}`).join(', ');
  const head = await run(`SELECT COUNT(*) AS n, ${distSel} FROM ${fq}`);
  if (!head) return null;
  const n = Number(head[0][0]);
  if (!n) return `${table}: 0 rows (empty)`;

  // For each column pick the one extra probe that reveals its variation, then run them all at once.
  const probes = cols.map((c, i) => {
    const t = (c.type || '').toLowerCase();
    const d = Number(head[0][i + 1]);
    if (isDate(t)) return run(`SELECT DATE_TRUNC('day', \`${c.name}\`) k, COUNT(*) v FROM ${fq} WHERE \`${c.name}\` IS NOT NULL GROUP BY 1 ORDER BY k LIMIT 60`).then(r => ({ i, kind: 'date', d, r }));
    if (d >= 2 && d <= 15 && d < n) return run(`SELECT \`${c.name}\` k, COUNT(*) v FROM ${fq} GROUP BY 1 ORDER BY v DESC LIMIT 12`).then(r => ({ i, kind: 'dist', d, r }));
    if (isNum(t) && d > 15) return run(`SELECT MIN(\`${c.name}\`), MAX(\`${c.name}\`), ROUND(AVG(\`${c.name}\`), 2) FROM ${fq}`).then(r => ({ i, kind: 'range', d, r }));
    return Promise.resolve({ i, kind: 'plain', d, r: null });
  });
  const done = await Promise.all(probes);

  const lines = [`${table}: ${n} rows`];
  for (const { i, kind, d, r } of done) {
    const c = cols[i], t = (c.type || '').toLowerCase();
    let note = `${d} distinct`;
    if (kind === 'date' && r?.length) {
      const v = r.map(x => Number(x[1]));
      const varies = Math.max(...v) !== Math.min(...v);
      note += `; ${r.length} day(s) ${String(r[0][0]).slice(0, 10)}..${String(r[r.length - 1][0]).slice(0, 10)}, per-day count ${varies ? 'VARIES ✓' : `is CONSTANT (${v[0]} every day) — a trend/line over time would be a flat or perfectly straight line, uninsightful`}`;
    } else if (kind === 'dist' && r?.length) {
      const v = r.map(x => Number(x[1]));
      const varies = Math.max(...v) !== Math.min(...v);
      note += `; ${r.map(x => `${x[0] == null ? 'null' : x[0]}=${x[1]}`).join(', ')} (${varies ? 'VARIES ✓ — meaningful to chart' : 'all equal — flat'})`;
    } else if (kind === 'range' && r?.length) {
      note += ` — continuous numeric measure (min ${r[0][0]}, max ${r[0][1]}, avg ${r[0][2]})`;
    } else if (d >= n && n > 1) {
      note += isNum(t) ? ' — near-unique numeric (a measure)' : ' — unique per row (id/label, not a grouping dimension)';
    }
    lines.push(`  ${c.name} ${c.type} — ${note}`);
  }
  return lines.join('\n');
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
  const profiles = (await Promise.all(tables.map(t => profileTable(catalog, schema, t, s[t] || []).catch(() => null)))).filter(Boolean);
  const user = `Tables:\n${schemaText(s)}\n\n` +
    `DATA PROFILE — reason about what chart actually makes sense for THIS data before choosing:\n` +
    `${profiles.join('\n\n') || '(profile unavailable)'}\n\n` +
    `Request: ${description}`;

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
