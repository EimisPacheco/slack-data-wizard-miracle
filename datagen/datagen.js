/**
 * Generate table data from a description, two sources:
 *   - fromSearch()  → Perplexity (sonar): REAL statistics grounded in web search, with citations.
 *   - synthetic()   → OpenAI (gpt-5.6-terra): plausible FAKE rows.
 * Both return { columns, rows, csv, source, citations } so they feed the existing CSV→table path.
 */

const PPLX_URL = 'https://api.perplexity.ai/chat/completions';
const OPENAI_URL = 'https://api.openai.com/v1/responses';

const SHAPE = `Return ONLY JSON, no prose, no markdown fences:
{"columns": ["col1","col2",...], "rows": [["v1","v2",...], ...]}
Every row must have exactly as many values as there are columns. Values are strings.`;

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv({ columns, rows }) {
  return [columns.map(csvCell).join(','), ...rows.map(r => columns.map((_, i) => csvCell(r[i])).join(','))].join('\n') + '\n';
}

function parseTable(text) {
  let t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) t = t.slice(a, b + 1);
  const obj = JSON.parse(t);
  const columns = Array.isArray(obj.columns) ? obj.columns.map(c => String(c).trim()) : [];
  const rows = Array.isArray(obj.rows)
    ? obj.rows.map(r => Array.isArray(r) ? r.map(v => v == null ? '' : String(v)) : []).filter(r => r.length)
    : [];
  if (!columns.length || !rows.length) throw new Error('no tabular data');
  // enforce rectangularity
  const width = columns.length;
  const clean = rows.map(r => r.slice(0, width).concat(Array(Math.max(0, width - r.length)).fill('')));
  return { columns, rows: clean };
}

/** REAL data via Perplexity, grounded in web search. Retries once on non-JSON. */
export async function fromSearch(description) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) throw new Error('PERPLEXITY_API_KEY not set');
  const model = process.env.PERPLEXITY_MODEL || 'sonar';

  const prompt = `Build a data table answering: "${description}".
Use real, current figures from the web. Prefer the most recent year available and name it in a column if relevant.
${SHAPE}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(PPLX_URL, {
      method: 'POST',
    signal: AbortSignal.timeout(90000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You output only valid JSON tables grounded in real web data.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
      }),
    });
    if (!r.ok) throw new Error(`Perplexity ${r.status}: ${(await r.text()).slice(0, 150)}`);
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content || '';
    const citations = j.citations || j.search_results?.map(s => s.url) || [];
    try {
      const { columns, rows } = parseTable(text);
      return { columns, rows, csv: toCsv({ columns, rows }), source: 'perplexity', citations };
    } catch (e) {
      if (attempt === 1) throw new Error(`Perplexity did not return a table: ${text.slice(0, 120)}`);
    }
  }
}

/** SYNTHETIC data via OpenAI. */
export async function synthetic(description) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-terra';

  const prompt = `Generate a realistic but entirely FAKE data table for: "${description}".
Invent plausible values; do not use real people or real proprietary data. Default to 20 rows if no count is given.
${SHAPE}`;

  const r = await fetch(OPENAI_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(90000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [
        { role: 'system', content: 'You output only valid JSON tables of synthetic data.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const payload = await r.json();
  const msg = (payload.output || []).find(o => o.type === 'message');
  const block = msg && (msg.content || []).find(c => c.type === 'output_text');
  const { columns, rows } = parseTable(block?.text || '');
  return { columns, rows, csv: toCsv({ columns, rows }), source: 'openai', citations: [] };
}

/**
 * Intent detection: real vs synthetic vs ambiguous.
 * @returns 'real' | 'synthetic' | 'ask'
 */
export function detectSource(text) {
  const t = text.toLowerCase();
  const synthetic = /\b(fake|synthetic|dummy|sample|mock|random|test data|made[- ]?up|placeholder|generate \d+ (fake|random))\b/;
  const real = /\b(real|actual|current|latest|today|this year|202\d|statistics|stats|by (gdp|population|country|region)|top \d+ countries|official)\b/;
  if (synthetic.test(t) && !real.test(t)) return 'synthetic';
  if (real.test(t) && !synthetic.test(t)) return 'real';
  return 'ask';
}
