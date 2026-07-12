#!/usr/bin/env node
/**
 * Upload a CSV into MySQL, creating the table from the CSV's inferred schema when absent.
 *
 *   node index.js samples/hackathon_signups.csv
 *   node index.js data.csv --table my_table --truncate
 *   node index.js data.csv --dry-run
 *
 * Reads MYSQL_* from ../.env
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { analyseCsv, coerce, safeIdent } from './csv.js';

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function parseArgs(argv) {
  const args = { file: null, table: null, truncate: false, dryRun: false, batch: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--table') args.table = argv[++i];
    else if (a === '--truncate') args.truncate = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--batch') args.batch = parseInt(argv[++i], 10);
    else if (!a.startsWith('--')) args.file = a;
  }
  return args;
}

/** Table name defaults to the CSV's basename. */
function tableNameFor(file, override) {
  return safeIdent(override || path.basename(file).replace(/\.csv$/i, '').toLowerCase());
}

async function tableExists(conn, db, table) {
  const [rows] = await conn.query(
    'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [db, table]
  );
  return rows[0].n > 0;
}

async function existingColumns(conn, db, table) {
  const [rows] = await conn.query(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
    [db, table]
  );
  return rows.map(r => r.column_name ?? r.COLUMN_NAME);
}

async function main() {
  loadEnv(path.resolve(process.cwd(), '../.env'));
  loadEnv(path.resolve(process.cwd(), '.env'));

  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('usage: node index.js <file.csv> [--table name] [--truncate] [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(args.file)) {
    console.error(`❌ no such file: ${args.file}`);
    process.exit(1);
  }

  const { columns, dataRows } = analyseCsv(fs.readFileSync(args.file, 'utf8'));
  const table = tableNameFor(args.file, args.table);
  const db = process.env.MYSQL_DATABASE;

  console.log(`📄 ${args.file}`);
  console.log(`   rows: ${dataRows.length}  columns: ${columns.length}`);
  console.log(`🧬 inferred schema for \`${table}\`:`);
  for (const c of columns) console.log(`     ${c.name.padEnd(14)} ${c.type}`);

  const ddl =
    `CREATE TABLE IF NOT EXISTS \`${table}\` (\n` +
    columns.map(c => `  \`${c.name}\` ${c.type}`).join(',\n') +
    `\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

  if (args.dryRun) {
    console.log('\n--- DDL (dry run, nothing executed) ---\n' + ddl);
    return;
  }

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: db,
    connectTimeout: 15000,
  });
  console.log(`\n🔌 connected to ${process.env.MYSQL_HOST}/${db}`);

  try {
    const existed = await tableExists(conn, db, table);
    if (existed) {
      console.log(`📋 table \`${table}\` already exists - reusing it`);
      const have = new Set((await existingColumns(conn, db, table)).map(c => c.toLowerCase()));
      const missing = columns.filter(c => !have.has(c.name.toLowerCase()));
      if (missing.length) {
        throw new Error(
          `table \`${table}\` is missing columns present in the CSV: ${missing.map(m => m.name).join(', ')}`
        );
      }
    } else {
      await conn.query(ddl);
      console.log(`🆕 created table \`${table}\``);
    }

    if (args.truncate) {
      await conn.query(`DELETE FROM \`${table}\``);
      console.log(`🗑️  cleared existing rows`);
    }

    const colList = columns.map(c => `\`${c.name}\``).join(', ');
    const values = dataRows.map(r => columns.map((c, i) => coerce(r[i], c.type)));

    await conn.beginTransaction();
    let inserted = 0;
    for (let i = 0; i < values.length; i += args.batch) {
      const chunk = values.slice(i, i + args.batch);
      const [res] = await conn.query(`INSERT INTO \`${table}\` (${colList}) VALUES ?`, [chunk]);
      inserted += res.affectedRows;
    }
    await conn.commit();

    const [[{ total }]] = await conn.query(`SELECT COUNT(*) total FROM \`${table}\``);
    console.log(`✅ inserted ${inserted} rows  (table now holds ${total})`);
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

main();
