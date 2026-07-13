/** RFC-4180 CSV parsing and column type inference. No dependencies. */

/** Splits CSV text into rows of fields, honouring quotes, escaped quotes and embedded newlines. */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== '');
}

/** A CSV cell is "empty" (SQL NULL) only when it has no characters at all. */
const isEmpty = v => v === '' || v == null;

const INT_RE = /^-?\d+$/;
const DEC_RE = /^-?\d+\.\d+$/;
const BOOL_RE = /^(true|false)$/i;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Web-sourced figures often arrive with thousands separators ("1,476,625,576").
// Without this they'd be typed as text and sort lexically — "349,035,494" would
// outrank "1,476,625,576". Normalise them to plain numbers.
const GROUPED_NUM_RE = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
const ungroup = v => (GROUPED_NUM_RE.test(String(v)) ? String(v).replace(/,/g, '') : String(v));

/**
 * Infers a generic SQL column type from every value in the column. These names
 * (INT/BIGINT/DOUBLE/BOOLEAN/DATETIME/DATE/VARCHAR/TEXT) are a portable vocabulary that the
 * caller maps to its target engine — `medallion.js` maps them to Databricks types.
 * Widens on conflict: an INT column containing "3.5" becomes DOUBLE; anything
 * unrecognised falls back to VARCHAR/TEXT sized to the longest value seen.
 */
export function inferType(values) {
  const present = values.filter(v => !isEmpty(v));
  if (present.length === 0) return 'TEXT';

  const nums = present.map(ungroup);
  if (nums.every(v => INT_RE.test(v))) {
    const big = nums.some(v => Math.abs(Number(v)) > 2147483647);
    return big ? 'BIGINT' : 'INT';
  }
  if (nums.every(v => INT_RE.test(v) || DEC_RE.test(v))) return 'DOUBLE';
  if (present.every(v => BOOL_RE.test(v))) return 'BOOLEAN';
  if (present.every(v => DATETIME_RE.test(v))) return 'DATETIME';
  if (present.every(v => DATE_RE.test(v))) return 'DATE';

  const longest = present.reduce((m, v) => Math.max(m, v.length), 0);
  // Past ~1000 chars a VARCHAR key/row-size limit becomes a real risk; use TEXT.
  return longest > 1000 ? 'TEXT' : `VARCHAR(${Math.min(Math.max(longest * 2, 32), 1000)})`;
}

/** Coerces a CSV string into the JS value to insert for the given inferred column type. */
export function coerce(value, type) {
  if (isEmpty(value)) return null;
  if (type === 'INT' || type === 'BIGINT') return parseInt(ungroup(value), 10);
  if (type === 'DOUBLE') return parseFloat(ungroup(value));
  if (type === 'BOOLEAN') return /^true$/i.test(value) ? 1 : 0;
  return value;
}

/** SQL identifiers: strip anything hostile, prefix if it would start with a digit. */
export function safeIdent(name) {
  const cleaned = String(name).trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_{2,}/g, '_');
  if (!cleaned) throw new Error(`Column name "${name}" is empty after sanitising`);
  return /^\d/.test(cleaned) ? `c_${cleaned}` : cleaned;
}

/** Reads a CSV's text and returns headers, typed columns and raw rows. */
export function analyseCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one data row');

  const headers = rows[0].map(safeIdent);
  const dupes = headers.filter((h, i) => headers.indexOf(h) !== i);
  if (dupes.length) throw new Error(`Duplicate column names after sanitising: ${[...new Set(dupes)].join(', ')}`);

  const dataRows = rows.slice(1).filter(r => r.some(v => !isEmpty(v)));

  const columns = headers.map((name, i) => ({
    name,
    type: inferType(dataRows.map(r => r[i])),
  }));

  return { headers, columns, dataRows };
}
