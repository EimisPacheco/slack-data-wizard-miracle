import { describeSchema, schemaAsText, runSql } from './db.js';
import { classify, requiresConfirmation, KIND } from './guard.js';

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-terra';

// Which model writes the SQL. Set NL2SQL_PROVIDER=openai in .env to switch back.
const PROVIDER = (process.env.NL2SQL_PROVIDER || 'gemma').toLowerCase();
const GEMMA_BASE_URL = () => (process.env.GEMMA_BASE_URL || '').replace(/\/$/, '');
const GEMMA_MODEL = () => process.env.GEMMA_MODEL || 'gemma4:31b';

const SYSTEM = `You translate natural language into a single Databricks SQL statement.
You handle BOTH questions about data AND instructions to create or inspect objects.

RULES:
1. Reply with JSON only: {"sql": "<one statement>", "explanation": "<one plain sentence>"}
2. Exactly ONE statement. Never use semicolons to chain statements.
3. Use only tables and columns from the schema given. Never invent column names.
4. Tables are already in the active catalog and schema — reference them by bare name.
5. This is Databricks SQL: use STRING not VARCHAR, TIMESTAMP not DATETIME, backticks for identifiers.
6. LIMIT unbounded SELECTs to 100 rows unless the user asks for a specific count.
7. If the request cannot be answered from the schema, set "sql" to "" and explain why.

YOU CAN ALSO EMIT (when the user asks for them):
- Listing/inspection: SHOW CATALOGS · SHOW SCHEMAS · SHOW TABLES · DESCRIBE <table>
  ("what catalogs are there" -> SHOW CATALOGS; "list tables" -> SHOW TABLES;
   "what columns does X have" -> DESCRIBE X)
- Creating objects: CREATE CATALOG <name> · CREATE SCHEMA <name> · CREATE TABLE <name> (...)
  ("create a schema called sales" -> CREATE SCHEMA IF NOT EXISTS sales)
- Changing/removing data: DROP / DELETE / UPDATE / TRUNCATE / ALTER — only when the user
  clearly asks to change or remove something. These are shown to the user for confirmation
  before they run, so emit the correct statement rather than refusing.`;

async function callOpenAI(system, user) {
  const res = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const payload = await res.json();
  const msg = (payload.output || []).find(o => o.type === 'message');
  const block = msg && (msg.content || []).find(c => c.type === 'output_text');
  if (!block) throw new Error('No text in OpenAI response');
  return block.text;
}

/** Gemma via Ollama on the AMD GPU. format:'json' forces valid JSON; think:false keeps it fast. */
async function callGemma(system, user) {
  if (!GEMMA_BASE_URL()) throw new Error('GEMMA_BASE_URL not set');
  const res = await fetch(`${GEMMA_BASE_URL()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GEMMA_MODEL(),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false,
      think: false,
      format: 'json',
      options: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Gemma ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = j.message?.content;
  if (!text) throw new Error('No text in Gemma response');
  return text;
}

/**
 * Detects degenerate model output — SQL that is syntactically plausible but obviously broken.
 * Any LLM occasionally emits this; running it silently returns a wrong answer (e.g. an
 * `IN ('', '', '')` list matches nothing and reports "no rows", which reads like a real result).
 * @returns {string|null} reason it's degenerate, or null if the SQL looks sane.
 */
export function looksDegenerate(sql) {
  if (!sql || !sql.trim()) return 'empty SQL';

  // Empty string literals as values: IN ('', ''), = '', VALUES ('')
  if (/(?:\bIN\s*\(|=\s*|,\s*)''(?:\s*[,)]|\s*$)/i.test(sql)) return "contains empty string literals (e.g. IN ('', ''))";

  // Unbalanced quoting — a mangled string breaks the meaning of the statement.
  const backticks = (sql.match(/`/g) || []).length;
  if (backticks % 2 !== 0) return 'unbalanced backticks';
  const singles = (sql.match(/'/g) || []).length;
  if (singles % 2 !== 0) return 'unbalanced single quotes';

  return null;
}

/** One generation attempt: model → parsed { sql, explanation }. */
async function generate(user) {
  const raw = PROVIDER === 'openai' ? await callOpenAI(SYSTEM, user) : await callGemma(SYSTEM, user);
  let text = raw.replace(/```(json|sql)?/g, '').trim();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a !== -1 && b > a) text = text.slice(a, b + 1);
  try { return JSON.parse(text); }
  catch { throw new Error(`Model did not return JSON: ${text.slice(0, 120)}`); }
}

/** context = { catalog, schema } */
export async function planQuery(request, context) {
  const tables = await describeSchema(context.catalog, context.schema);
  const schema = schemaAsText(tables);
  const user = `Active namespace: ${context.catalog}.${context.schema}\nSchema:\n${schema}\n\nRequest: ${request}`;

  // Generate, and if the model emits degenerate SQL, regenerate once before giving up.
  let parsed = await generate(user);
  if (parsed.sql) {
    const bad = looksDegenerate(parsed.sql);
    if (bad) {
      console.warn(`⚠️  degenerate SQL (${bad}) — regenerating: ${parsed.sql.slice(0, 90)}`);
      parsed = await generate(user);
      const stillBad = parsed.sql ? looksDegenerate(parsed.sql) : null;
      if (stillBad) {
        return { ok: false, reason: `I generated malformed SQL (${stillBad}) and couldn't recover — please rephrase.` };
      }
    }
  }

  if (!parsed.sql) return { ok: false, reason: parsed.explanation || 'Could not answer from the schema' };

  const verdict = classify(parsed.sql);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, sql: parsed.sql, kind: verdict.kind };

  return {
    ok: true,
    // Execute the ORIGINAL SQL. `verdict.statement` is normalised for classification —
    // guard.js strips every string literal to '' so a keyword hidden in a string can't fool
    // it. Running that stripped form would turn `IN ('Brazil')` into `IN ('')` and silently
    // match nothing. Classification uses the normalised form; execution uses the real one.
    sql: parsed.sql.trim().replace(/;+\s*$/, ''),
    kind: verdict.kind,
    explanation: parsed.explanation || '',
    needsConfirmation: requiresConfirmation(verdict.kind),
  };
}

/** Executes an already-classified statement in the given catalog.schema context. */
export async function runPlanned(plan, context) {
  if (!plan.ok) throw new Error(plan.reason);
  const result = await runSql(plan.sql, { catalog: context.catalog, schema: context.schema });

  if (plan.kind === KIND.READ) {
    return { kind: plan.kind, rows: result.rowObjects, rowCount: result.rowObjects.length };
  }
  return { kind: plan.kind, affectedRows: result.totalRows ?? 0 };
}

/** Renders result rows as a Slack-friendly fixed-width table. */
export function formatRows(rows, max = 12) {
  if (!rows || rows.length === 0) return '_no rows_';
  const cols = Object.keys(rows[0]);
  const shown = rows.slice(0, max);
  const width = {};
  for (const c of cols) {
    width[c] = Math.min(Math.max(c.length, ...shown.map(r => String(r[c] ?? 'NULL').length)), 28);
  }
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  const head = cols.map(c => clip(c, width[c])).join('  ');
  const rule = cols.map(c => '─'.repeat(width[c])).join('  ');
  const body = shown.map(r => cols.map(c => clip(String(r[c] ?? 'NULL'), width[c])).join('  '));
  const more = rows.length > max ? `\n… ${rows.length - max} more rows` : '';
  return '```\n' + [head, rule, ...body].join('\n') + more + '\n```';
}
