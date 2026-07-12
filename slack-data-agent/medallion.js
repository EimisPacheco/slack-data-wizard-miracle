/**
 * CSV ingestion and bronze → silver → gold medallion pipeline on Databricks.
 *
 * bronze : raw rows exactly as the CSV gave them, plus lineage columns.
 * silver : deduplicated, empty rows dropped, types enforced.
 * gold   : a business aggregation (GROUP BY a dimension, aggregate a measure).
 */
import { runSql, ident, sqlString } from './databricks.js';
import { analyseCsv, coerce } from '../csv-to-db/csv.js';

/** Maps the CSV inferrer's MySQL-ish types to Databricks SQL types. */
export function dbxType(csvType) {
  const t = csvType.toUpperCase();
  if (t.startsWith('VARCHAR') || t === 'TEXT') return 'STRING';
  if (t === 'DATETIME') return 'TIMESTAMP';
  if (t === 'BOOLEAN') return 'BOOLEAN';
  if (t === 'INT') return 'INT';
  if (t === 'BIGINT') return 'BIGINT';
  if (t === 'DOUBLE') return 'DOUBLE';
  if (t === 'DATE') return 'DATE';
  return 'STRING';
}

const fq = (catalog, schema, table) => `${ident(catalog)}.${ident(schema)}.${ident(table)}`;

/** SQL literal for one coerced value at a given Databricks type. */
function literal(value, dbxT) {
  if (value == null) return 'NULL';
  if (dbxT === 'INT' || dbxT === 'BIGINT' || dbxT === 'DOUBLE') return String(value);
  if (dbxT === 'BOOLEAN') return value ? 'TRUE' : 'FALSE';
  if (dbxT === 'TIMESTAMP') return `TIMESTAMP ${sqlString(value)}`;
  if (dbxT === 'DATE') return `DATE ${sqlString(value)}`;
  return sqlString(value);
}

/**
 * Bronze: create <name>_bronze and load the CSV verbatim (with lineage columns).
 * Databricks has no multi-row VALUES limit issue at CSV scale, but we batch to be safe.
 */
export async function ingestBronze({ catalog, schema, table, csvText, sourceName = 'upload.csv', mode = 'replace' }) {
  const { columns, dataRows } = analyseCsv(csvText);
  const cols = columns.map(c => ({ name: c.name, dbx: dbxType(c.type), csv: c.type }));

  const bronze = `${table}_bronze`;
  const colDdl = cols.map(c => `${ident(c.name)} ${c.dbx}`).join(', ');
  // 'append' keeps prior loads in bronze (each row carries its own _source/_ingested_at, so
  // lineage stays intact); silver then dedupes across them. 'replace' starts bronze clean.
  const verb = mode === 'append' ? 'CREATE TABLE IF NOT EXISTS' : 'CREATE OR REPLACE TABLE';
  await runSql(
    `${verb} ${fq(catalog, schema, bronze)} ` +
    `(${colDdl}, _ingested_at TIMESTAMP, _source STRING)`
  );

  const colList = cols.map(c => ident(c.name)).concat(['`_ingested_at`', '`_source`']).join(', ');
  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < dataRows.length; i += BATCH) {
    const chunk = dataRows.slice(i, i + BATCH);
    const valueRows = chunk.map(r => {
      const vals = cols.map((c, ci) => literal(coerce(r[ci], c.csv), c.dbx));
      vals.push('current_timestamp()', sqlString(sourceName));
      return `(${vals.join(', ')})`;
    });
    await runSql(`INSERT INTO ${fq(catalog, schema, bronze)} (${colList}) VALUES ${valueRows.join(', ')}`);
    inserted += chunk.length;
  }
  return { bronze, columns: cols, rowsInserted: inserted };
}

/**
 * Existing business column names of a table, or null if the table genuinely doesn't exist.
 * Only a not-found error yields null — anything else (auth, network, warehouse asleep) is
 * rethrown. Swallowing every error here would report a connection failure as "no such table"
 * and quietly steer the user into creating a duplicate.
 */
export async function tableColumns(catalog, schema, table) {
  try {
    const desc = await runSql(`DESCRIBE ${fq(catalog, schema, table)}`);
    return desc.rows.map(([name]) => name).filter(n => n && !n.startsWith('#') && !n.startsWith('_'));
  } catch (err) {
    if (/TABLE_OR_VIEW_NOT_FOUND|NoSuchTable|cannot be found|does not exist/i.test(err.message)) return null;
    throw err;
  }
}

/**
 * Loads a CSV into a table with the EXACT name given (no _bronze suffix, no lineage columns).
 *
 * @param mode 'replace' — CREATE OR REPLACE, the table becomes exactly this CSV (idempotent).
 *             'append'  — keep existing rows and add these. Appending is only safe if the CSV's
 *                         columns match the table's; otherwise values would land in the wrong
 *                         columns, so we refuse with a message naming the mismatch.
 */
export async function loadFlatTable({ catalog, schema, table, csvText, mode = 'replace' }) {
  const { columns, dataRows } = analyseCsv(csvText);
  const cols = columns.map(c => ({ name: c.name, dbx: dbxType(c.type), csv: c.type }));

  if (mode === 'append') {
    const existing = await tableColumns(catalog, schema, table);
    if (!existing) throw new Error(`Table \`${table}\` doesn't exist yet — choose *New table* instead.`);
    const missing = cols.map(c => c.name).filter(n => !existing.includes(n));
    if (missing.length) {
      throw new Error(
        `Can't append: \`${table}\` has no column${missing.length > 1 ? 's' : ''} ` +
        `${missing.map(m => `\`${m}\``).join(', ')}. Its columns are ${existing.map(e => `\`${e}\``).join(', ')}. ` +
        `Use *Replace* to overwrite it with this file's shape.`);
    }
  } else {
    const colDdl = cols.map(c => `${ident(c.name)} ${c.dbx}`).join(', ');
    await runSql(`CREATE OR REPLACE TABLE ${fq(catalog, schema, table)} (${colDdl})`);
  }

  const colList = cols.map(c => ident(c.name)).join(', ');
  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < dataRows.length; i += BATCH) {
    const chunk = dataRows.slice(i, i + BATCH);
    const valueRows = chunk.map(r => `(${cols.map((c, ci) => literal(coerce(r[ci], c.csv), c.dbx)).join(', ')})`);
    await runSql(`INSERT INTO ${fq(catalog, schema, table)} (${colList}) VALUES ${valueRows.join(', ')}`);
    inserted += chunk.length;
  }
  const [{ n }] = (await runSql(`SELECT COUNT(*) AS n FROM ${fq(catalog, schema, table)}`)).rowObjects;
  return { table, columns: cols, rowsInserted: inserted, totalRows: Number(n), mode };
}

/**
 * Silver: deduplicated, non-empty, typed copy of bronze.
 * Dedup key defaults to all business columns (exclude lineage).
 */
export async function promoteSilver({ catalog, schema, table, dedupKey }) {
  const bronze = `${table}_bronze`;
  const silver = `${table}_silver`;

  const desc = await runSql(`DESCRIBE ${fq(catalog, schema, bronze)}`);
  const businessCols = [];
  for (const [name] of desc.rows) {
    if (!name || name.startsWith('#') || name.startsWith('_')) continue;
    businessCols.push(name);
  }
  const keyCols = (dedupKey && dedupKey.length ? dedupKey : businessCols).map(ident).join(', ');
  const selectCols = businessCols.map(ident).join(', ');

  // Keep one row per key, drop rows that are entirely null across business columns.
  const notAllNull = businessCols.map(c => `${ident(c)} IS NOT NULL`).join(' OR ');
  await runSql(`CREATE OR REPLACE TABLE ${fq(catalog, schema, silver)} AS
    SELECT ${selectCols} FROM (
      SELECT ${selectCols},
             ROW_NUMBER() OVER (PARTITION BY ${keyCols} ORDER BY _ingested_at DESC) AS _rn
      FROM ${fq(catalog, schema, bronze)}
      WHERE ${notAllNull}
    ) WHERE _rn = 1`);

  const [{ n }] = (await runSql(`SELECT COUNT(*) AS n FROM ${fq(catalog, schema, silver)}`)).rowObjects;
  return { silver, rows: Number(n), businessCols };
}

/**
 * Picks a dimension worth grouping by: the text column with the FEWEST distinct values
 * (but more than one). Naively taking "the first text column" produced a useless gold table —
 * grouping 10 signups by `full_name` gives 10 groups of 1. `country_code` is what you want.
 */
export async function chooseGoldDimension({ catalog, schema, table, columns }) {
  const silver = `${table}_silver`;
  const candidates = columns.filter(c => /VARCHAR|TEXT|STRING/i.test(c.type ?? c.dbx ?? '')).map(c => c.name);
  if (!candidates.length) return columns[0].name;

  const exprs = candidates.map(c => `COUNT(DISTINCT ${ident(c)}) AS ${ident(c)}`).join(', ');
  const { rowObjects } = await runSql(
    `SELECT COUNT(*) AS _total, ${exprs} FROM ${fq(catalog, schema, silver)}`
  );
  const row = rowObjects[0];
  const total = Number(row._total);

  // A column that groups: >1 distinct value, and fewer distinct than rows (i.e. it repeats).
  const scored = candidates
    .map(c => ({ name: c, distinct: Number(row[c]) }))
    .filter(x => x.distinct > 1 && x.distinct < total)
    .sort((a, b) => a.distinct - b.distinct);

  return scored.length ? scored[0].name : candidates[0];
}

/**
 * Gold: an aggregated business table.
 * @param spec { dimension, measure, aggregation: 'SUM'|'AVG'|'COUNT'|'COUNTD' }
 */
export async function promoteGold({ catalog, schema, table, spec }) {
  const silver = `${table}_silver`;
  const gold = `${table}_gold`;
  const agg = (spec.aggregation || 'COUNT').toUpperCase();
  const measureExpr = agg === 'COUNT' ? 'COUNT(*)'
    : agg === 'COUNTD' ? `COUNT(DISTINCT ${ident(spec.measure)})`
    : `${agg}(${ident(spec.measure)})`;
  const alias = `${agg.toLowerCase()}_${(spec.measure || 'rows')}`.replace(/[^A-Za-z0-9_]/g, '_');

  await runSql(`CREATE OR REPLACE TABLE ${fq(catalog, schema, gold)} AS
    SELECT ${ident(spec.dimension)} AS ${ident(spec.dimension)},
           ${measureExpr} AS ${ident(alias)}
    FROM ${fq(catalog, schema, silver)}
    GROUP BY ${ident(spec.dimension)}
    ORDER BY ${ident(alias)} DESC`);

  const { rowObjects } = await runSql(`SELECT * FROM ${fq(catalog, schema, gold)} LIMIT 20`);
  return { gold, sample: rowObjects, dimension: spec.dimension, measureAlias: alias };
}

/** Full pipeline in one call. If no gold dimension is given, one is chosen that actually groups. */
export async function buildPipeline({ catalog, schema, table, csvText, sourceName, goldSpec, mode = 'replace' }) {
  const b = await ingestBronze({ catalog, schema, table, csvText, sourceName, mode });
  const s = await promoteSilver({ catalog, schema, table });

  const spec = { aggregation: 'COUNT', ...(goldSpec || {}) };
  if (!spec.dimension) {
    spec.dimension = await chooseGoldDimension({ catalog, schema, table, columns: b.columns });
  }
  const g = await promoteGold({ catalog, schema, table, spec });
  return { bronze: b, silver: s, gold: g };
}
