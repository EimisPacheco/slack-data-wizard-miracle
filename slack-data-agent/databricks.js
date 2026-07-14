/**
 * Databricks SQL client over the Statement Execution API.
 * Free Edition gives one serverless warehouse; it auto-starts on first query.
 *
 * Note on safety: Free Edition has no per-statement read-only role, so there is no
 * least-privilege reader guarantee. Destructive statements are gated by guard.js +
 * human confirmation only.
 */

const HOST = () => process.env.DATABRICKS_HOST;
const TOKEN = () => process.env.DATABRICKS_TOKEN;
const WAREHOUSE = () => process.env.DATABRICKS_WAREHOUSE_ID;

function headers() {
  return { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' };
}

async function poll(statementId) {
  // Serverless cold start can exceed the initial wait; poll until terminal.
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${HOST()}/api/2.0/sql/statements/${statementId}`, { headers: headers(), signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    const state = j.status?.state;
    if (['SUCCEEDED', 'FAILED', 'CANCELED', 'CLOSED'].includes(state)) return j;
    await new Promise(res => setTimeout(res, 2000));
  }
  throw new Error('statement did not finish within timeout');
}

/**
 * Runs one SQL statement. Returns { columns: [{name,type}], rows: [[...]], rowObjects: [{}] }.
 * @param {object} opts { catalog, schema } set the default namespace for the statement.
 */
// Databricks returns opaque 400s when the serverless warehouse can't run the statement. Surface a
// human message instead of raw JSON so the bot — and its spoken reply — explains what's wrong.
const isCreditExhausted = t => /free daily limit|community_edition_credit_exhausted/i.test(t || '');

function friendlyDbxError(status, text) {
  if (isCreditExhausted(text)) return CREDIT_MSG;
  return `Databricks HTTP ${status}: ${(text || '').slice(0, 200)}`;
}
const CREDIT_MSG = 'Databricks Community Edition has used up its free daily compute, so the SQL warehouse can’t start until it resets the next day. Try again tomorrow — your request itself was fine.';

// A "could not be processed by the warehouse" 400 means the serverless warehouse is stopped. The
// statement API doesn't say WHY, so probe /start: it reveals whether the account is out of free
// daily credits (Community Edition) vs merely asleep — and for an asleep warehouse the probe also
// kicks off the wake-up, so the user's next attempt succeeds.
async function warehouseDownReason() {
  try {
    const r = await fetch(`${HOST()}/api/2.0/sql/warehouses/${WAREHOUSE()}/start`, { method: 'POST', headers: headers() });
    if (isCreditExhausted(await r.text())) return CREDIT_MSG;
    return 'The Databricks SQL warehouse was asleep — I’ve started it (takes ~30s). Please try again in a moment.';
  } catch {
    return 'The Databricks SQL warehouse isn’t available right now. Give it a minute and try again.';
  }
}

export async function runSql(statement, opts = {}) {
  const body = {
    warehouse_id: WAREHOUSE(),
    statement,
    wait_timeout: '30s',
    on_wait_timeout: 'CONTINUE',
  };
  if (opts.catalog) body.catalog = opts.catalog;
  if (opts.schema) body.schema = opts.schema;

  const r = await fetch(`${HOST()}/api/2.0/sql/statements`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) {
    const text = await r.text();
    if (/could not be processed by the warehouse/i.test(text)) throw new Error(await warehouseDownReason());
    throw new Error(friendlyDbxError(r.status, text));
  }

  let result = await r.json();
  if (['PENDING', 'RUNNING'].includes(result.status?.state)) {
    result = await poll(result.statement_id);
  }

  if (result.status?.state !== 'SUCCEEDED') {
    const msg = result.status?.error?.message || result.status?.state;
    throw new Error(`SQL failed: ${msg}`);
  }

  const columns = (result.manifest?.schema?.columns || []).map(c => ({ name: c.name, type: c.type_name }));

  // The API returns only the FIRST chunk inline. Ignoring the rest silently truncated large
  // results — worst in the Tableau CSV snapshot, where a chart would be built (and published,
  // with no error) from a fraction of the table. Follow next_chunk_internal_link to the end.
  const rows = [...(result.result?.data_array || [])];
  let next = result.result?.next_chunk_internal_link;
  let guard = 0;
  while (next && guard++ < 200) {
    const cr = await fetch(`${HOST()}${next}`, { headers: headers(), signal: AbortSignal.timeout(60000) });
    if (!cr.ok) throw new Error(`Databricks chunk HTTP ${cr.status}`);
    const cj = await cr.json();
    rows.push(...(cj.data_array || []));
    next = cj.next_chunk_internal_link;
  }

  const rowObjects = rows.map(row => Object.fromEntries(columns.map((c, i) => [c.name, row[i]])));
  return { columns, rows, rowObjects, totalRows: result.manifest?.total_row_count ?? rows.length };
}

/** Escapes a string literal for Databricks SQL. */
export function sqlString(v) {
  if (v == null) return 'NULL';
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Backtick-quotes an identifier after sanitising. */
export function ident(name) {
  const cleaned = String(name).trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_{2,}/g, '_');
  if (!cleaned) throw new Error(`identifier "${name}" empty after sanitising`);
  return '`' + (/^\d/.test(cleaned) ? 'c_' + cleaned : cleaned) + '`';
}

// ── namespace helpers ──────────────────────────────────────────────

export async function listCatalogs() {
  const { rows } = await runSql('SHOW CATALOGS');
  return rows.map(r => r[0]);
}

export async function listSchemas(catalog) {
  const { rows } = await runSql(`SHOW SCHEMAS IN ${ident(catalog)}`);
  return rows.map(r => r[0]);
}

export async function listTables(catalog, schema) {
  const { rowObjects } = await runSql(`SHOW TABLES IN ${ident(catalog)}.${ident(schema)}`);
  // SHOW TABLES columns: database, tableName, isTemporary
  return rowObjects.map(r => r.tableName ?? r.table_name ?? Object.values(r)[1]);
}

export async function describeTable(catalog, schema, table) {
  const { rows } = await runSql(`DESCRIBE ${ident(catalog)}.${ident(schema)}.${ident(table)}`);
  // stops at the first blank/partitioning separator row
  const cols = [];
  for (const [name, type] of rows) {
    if (!name || name.startsWith('#')) break;
    cols.push({ name, type });
  }
  return cols;
}

export async function ensureSchema(catalog, schema) {
  await runSql(`CREATE SCHEMA IF NOT EXISTS ${ident(catalog)}.${ident(schema)}`);
}

export async function ensureCatalog(catalog) {
  await runSql(`CREATE CATALOG IF NOT EXISTS ${ident(catalog)}`);
}
