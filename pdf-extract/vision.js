/**
 * OpenAI vision client. Extracts a table from a scanned page image.
 * Uses the same OpenAI Responses API as the rest of Data Wizard (OPENAI_MODEL).
 */

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const MODEL = () => process.env.OPENAI_MODEL || 'gpt-5.6-terra';

const EXTRACT_PROMPT =
`This image is a scanned document page containing a TABLE.
Read the table and return ONLY JSON, no prose, no markdown fences, in this exact shape:
{"columns": ["<header1>", "<header2>", ...], "rows": [["<v1>", "<v2>", ...], ...]}
Rules:
- Use the table's own header row for "columns". If there is no clear header, invent short snake_case names.
- One entry in "rows" per data row, values as strings in column order.
- Transcribe numbers exactly as written; do not compute or reformat.
- Ignore titles, totals, and footer lines that are not table rows.
- If the page has no table, return {"columns": [], "rows": []}.`;

/** Strips code fences and extracts the outermost JSON object. */
function parseJson(text) {
  let t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

/** One vision call: prompt + PNG → the model's text reply. Shared by table and sketch paths. */
export async function callVision(prompt, pngBuffer, signal) {
  const r = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: MODEL(),
      input: [{ role: 'user', content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: `data:image/png;base64,${pngBuffer.toString('base64')}` },
      ] }],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI vision ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const payload = await r.json();
  const msg = (payload.output || []).find(o => o.type === 'message');
  const block = msg && (msg.content || []).find(c => c.type === 'output_text');
  if (!block?.text) throw new Error('No text in OpenAI vision response');
  return block.text;
}

/**
 * Extract a table from one page image.
 * @param {Buffer} pngBuffer
 * @returns {Promise<{columns: string[], rows: string[][], via: 'openai'}>}
 */
export async function extractTable(pngBuffer, opts = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set — vision extraction unavailable.');
  const t = withTimeout(opts.timeoutMs || 180000);
  try {
    const text = await callVision(EXTRACT_PROMPT, pngBuffer, t.signal);
    return { ...normalize(parseJson(text)), via: 'openai' };
  } finally { t.done(); }
}

function normalize(obj) {
  const columns = Array.isArray(obj.columns) ? obj.columns.map(c => String(c).trim()) : [];
  const rows = Array.isArray(obj.rows) ? obj.rows.map(r => Array.isArray(r) ? r.map(v => v == null ? '' : String(v)) : []) : [];
  return { columns, rows };
}
