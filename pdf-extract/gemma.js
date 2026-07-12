/**
 * Gemma vision client. Extracts a table from a scanned page image.
 *
 * Primary: Ollama on the AMD MI300X droplet (GEMMA_BASE_URL, GEMMA_MODEL).
 * Fallback: Fireworks AI Gemma (FIREWORKS_API_KEY, FIREWORKS_GEMMA_MODEL) — also AMD-hosted.
 * If the droplet is unreachable and no Fireworks key is set, throws a clear error.
 */

const GEMMA_BASE_URL = () => (process.env.GEMMA_BASE_URL || '').replace(/\/$/, '');
const GEMMA_MODEL = () => process.env.GEMMA_MODEL || 'gemma4:31b';
const FIREWORKS_KEY = () => process.env.FIREWORKS_API_KEY;
const FIREWORKS_MODEL = () => process.env.FIREWORKS_GEMMA_MODEL || 'accounts/fireworks/models/gemma-3-27b-it';

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

async function callOllama(base, model, imageB64, signal) {
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: EXTRACT_PROMPT, images: [imageB64] }],
      stream: false,
      options: { temperature: 0 },
    }),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return (await r.json()).message?.content || '';
}

async function callFireworks(model, imageB64, signal) {
  const r = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FIREWORKS_KEY()}`, 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: 'user', content: [
        { type: 'text', text: EXTRACT_PROMPT },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}` } },
      ] }],
    }),
  });
  if (!r.ok) throw new Error(`Fireworks HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return (await r.json()).choices?.[0]?.message?.content || '';
}

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

/**
 * Extract a table from one page image.
 * @param {Buffer} pngBuffer
 * @returns {Promise<{columns: string[], rows: string[][], via: 'droplet'|'fireworks'}>}
 */
export async function extractTable(pngBuffer, opts = {}) {
  const imageB64 = pngBuffer.toString('base64');
  const timeoutMs = opts.timeoutMs || 180000;

  // Primary: droplet Ollama.
  if (GEMMA_BASE_URL()) {
    const t = withTimeout(timeoutMs);
    try {
      const text = await callOllama(GEMMA_BASE_URL(), GEMMA_MODEL(), imageB64, t.signal);
      return { ...normalize(parseJson(text)), via: 'droplet' };
    } catch (err) {
      if (!FIREWORKS_KEY()) {
        throw new Error(`Gemma droplet unavailable (${err.message}). Set FIREWORKS_API_KEY to enable fallback.`);
      }
      // fall through to Fireworks
    } finally { t.done(); }
  }

  // Fallback: Fireworks.
  if (FIREWORKS_KEY()) {
    const t = withTimeout(timeoutMs);
    try {
      const text = await callFireworks(FIREWORKS_MODEL(), imageB64, t.signal);
      return { ...normalize(parseJson(text)), via: 'fireworks' };
    } finally { t.done(); }
  }

  throw new Error('No Gemma backend configured: set GEMMA_BASE_URL (droplet) or FIREWORKS_API_KEY.');
}

function normalize(obj) {
  const columns = Array.isArray(obj.columns) ? obj.columns.map(c => String(c).trim()) : [];
  const rows = Array.isArray(obj.rows) ? obj.rows.map(r => Array.isArray(r) ? r.map(v => v == null ? '' : String(v)) : []) : [];
  return { columns, rows };
}
