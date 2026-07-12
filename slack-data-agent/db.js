/**
 * Schema/context helpers over Databricks. Replaces the former MySQL layer.
 *
 * Safety note: Databricks Free Edition has no per-statement read-only role, so unlike
 * the MySQL version there is no second least-privilege enforcement layer. Destructive
 * statements are gated by guard.js classification + human confirmation only.
 */
import { runSql, ident } from './databricks.js';

/** Columns for every table in a catalog.schema, as a Map<table, ["col type", ...]>. */
export async function describeSchema(catalog, schema) {
  const { rowObjects } = await runSql(
    `SELECT table_name, column_name, data_type
     FROM ${ident(catalog)}.information_schema.columns
     WHERE table_schema = '${schema.replace(/'/g, "''")}'
     ORDER BY table_name, ordinal_position`
  );
  const tables = new Map();
  for (const r of rowObjects) {
    const t = r.table_name;
    if (!tables.has(t)) tables.set(t, []);
    tables.get(t).push(`${r.column_name} ${r.data_type}`);
  }
  return tables;
}

export function schemaAsText(tables) {
  if (tables.size === 0) return '(this schema has no tables yet)';
  return [...tables.entries()].map(([t, cols]) => `${t}(${cols.join(', ')})`).join('\n');
}

export async function tableExists(catalog, schema, table) {
  const { rows } = await runSql(
    `SELECT COUNT(*) FROM ${ident(catalog)}.information_schema.tables
     WHERE table_schema = '${schema.replace(/'/g, "''")}' AND table_name = '${table.replace(/'/g, "''")}'`
  );
  return Number(rows[0][0]) > 0;
}

export { runSql };
