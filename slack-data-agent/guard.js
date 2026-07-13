/**
 * Classifies LLM-generated SQL before anything executes.
 *
 * Databricks Free Edition has no per-statement read-only role, so this classifier plus the
 * human-confirmation step it triggers are the only thing standing between a model-authored
 * statement and your data. It normalises the statement first (comments and string literals
 * stripped) so a keyword hidden inside a quoted value cannot fool the classification.
 */

export const KIND = {
  READ: 'read',           // SELECT, SHOW, DESCRIBE, EXPLAIN
  CREATE: 'create',       // CREATE TABLE, INSERT
  DESTRUCTIVE: 'destructive', // DROP, DELETE, TRUNCATE, ALTER, UPDATE, RENAME, REPLACE
  UNKNOWN: 'unknown',
};

const READ_VERBS = ['select', 'show', 'describe', 'desc', 'explain', 'with', 'use'];
const CREATE_VERBS = ['create', 'insert'];
// Databricks adds MERGE, COPY INTO, VACUUM, OPTIMIZE; all mutate and require confirmation.
const DESTRUCTIVE_VERBS = ['drop', 'delete', 'truncate', 'alter', 'update', 'rename',
  'replace', 'grant', 'revoke', 'merge', 'copy', 'vacuum', 'optimize'];

/** Strips comments and string literals so keywords inside data can't fool the classifier. */
function normalise(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')  // /* block */
    .replace(/--[^\n]*/g, ' ')          // -- line
    .replace(/#[^\n]*/g, ' ')           // # line
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")  // 'string'
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')  // "string"
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits on semicolons that are not inside literals. Returns non-empty statements. */
export function splitStatements(sql) {
  return normalise(sql)
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

function verbOf(statement) {
  const m = statement.match(/^([a-z_]+)/i);
  return m ? m[1].toLowerCase() : '';
}

// Objects safe to CREATE without confirmation. CREATE USER/ROLE would be escalation.
const CREATABLE = /^create\s+(temporary\s+)?(catalog|schema|database|table|index|view)\b/i;
// CREATE OR REPLACE overwrites existing data — treat like a destructive rebuild.
const OR_REPLACE = /^create\s+or\s+replace\b/i;

function classifyOne(statement) {
  const verb = verbOf(statement);
  if (DESTRUCTIVE_VERBS.includes(verb)) return KIND.DESTRUCTIVE;
  if (verb === 'create') {
    if (OR_REPLACE.test(statement)) return KIND.DESTRUCTIVE;
    return CREATABLE.test(statement) ? KIND.CREATE : KIND.UNKNOWN;
  }
  if (verb === 'insert') return KIND.CREATE;
  if (READ_VERBS.includes(verb)) return KIND.READ;
  return KIND.UNKNOWN;
}

/**
 * @returns {{ok: boolean, kind: string, reason?: string, statement?: string}}
 * `ok:false` means refuse outright. `kind` drives whether confirmation is required.
 */
export function classify(sql) {
  if (typeof sql !== 'string' || !sql.trim()) {
    return { ok: false, kind: KIND.UNKNOWN, reason: 'Empty SQL' };
  }

  const statements = splitStatements(sql);

  if (statements.length === 0) {
    return { ok: false, kind: KIND.UNKNOWN, reason: 'No executable statement' };
  }
  // Multi-statement is the classic injection vector: "SELECT 1; DROP TABLE users".
  if (statements.length > 1) {
    return { ok: false, kind: KIND.UNKNOWN, reason: `Refusing ${statements.length} statements at once; send one` };
  }

  const statement = statements[0];
  const kind = classifyOne(statement);

  if (kind === KIND.UNKNOWN) {
    return { ok: false, kind, reason: `Unrecognised statement type: "${verbOf(statement)}"` };
  }

  // A read must not smuggle a write in a subquery or CTE body.
  if (kind === KIND.READ) {
    const smuggled = DESTRUCTIVE_VERBS.find(v => new RegExp(`\\b${v}\\b`, 'i').test(statement));
    if (smuggled) {
      return { ok: false, kind: KIND.DESTRUCTIVE, reason: `Read statement contains "${smuggled.toUpperCase()}"` };
    }
    if (/\binto\s+(outfile|dumpfile)\b/i.test(statement)) {
      return { ok: false, kind: KIND.DESTRUCTIVE, reason: 'SELECT ... INTO OUTFILE writes to disk' };
    }
  }

  return { ok: true, kind, statement };
}

/** Destructive statements need an explicit human click before they run. */
export function requiresConfirmation(kind) {
  return kind === KIND.DESTRUCTIVE;
}

/** Reads go to the read-only connection; everything else needs the writer. */
export function needsWriteConnection(kind) {
  return kind !== KIND.READ;
}
