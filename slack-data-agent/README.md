# slack-data-agent — Data Wizard (Databricks)

A Slack agent for managing a Databricks lakehouse in plain English: upload CSVs, build
bronze/silver/gold pipelines, create and switch catalogs and schemas, and query — no SQL required.

Backed by **Databricks Free Edition** via the SQL Statement Execution API (one serverless
warehouse, auto-starting). Replaces the earlier AWS RDS MySQL version.

## What it does

**`help`** prints the full command list in Slack.

**Work anywhere in the lakehouse.** Every user has an active `catalog.schema` (default
`workspace.data_wizard`). Change it in chat — phrasing is flexible:

```
context                          → your current catalog.schema
list catalogs / schemas / tables (also "show me the tables", "what tables do i have")
use catalog main                 (also "switch to catalog main", "go to catalog main")
use schema sales
create catalog my_catalog        → creates and switches
create schema bronze_raw         (also "create a new schema called bronze_raw")
```

Anything that isn't one of these is treated as a question and turned into SQL — so
"show the signups_gold table" queries the table, while "show tables" lists them.

**Upload a CSV** — drop a `.csv` in a channel/DM. Choose:
- **Load as table** — one typed table.
- **Build medallion pipeline** — `_bronze` (raw + lineage), `_silver` (deduped, typed),
  `_gold` (aggregated). All three created in your active schema.

**Generate data** — `@Data Wizard create a table of the top 10 countries by GDP` pulls **real
statistics via Perplexity** (with citations); `create a table of 20 fake employees` makes
**synthetic data via OpenAI**. It infers which from your phrasing and, when ambiguous, shows a
Card with 🌐 Real / 🎲 Synthetic buttons. Generated data lands via the same Load/Pipeline flow.

**Ask questions** — `@Data Wizard show the signups_gold table`. It writes Databricks SQL,
runs it in your active namespace, returns the result as a **Data Table** block, and shows the
SQL underneath.

## Rich UX (Block Kit)

Uses Slack's new agent blocks with a classic fallback:
- **Data Table** blocks for query results and previews (numbers right-aligned).
- **Card** blocks for upload/generate previews, medallion results, and the destructive-change
  confirmation (warning-styled with a danger button).
- `postRich()` tries the new blocks and re-posts classic `section`/`actions` if a surface
  rejects them, so the UX upgrades where supported and never breaks where it isn't.

**Change data** — "drop the bronze table" generates the `DROP`, shows it, and waits for you
to click **Run it**. Nothing destructive runs without a click.

## Safety model

- **Classifier** (`guard.js`): every generated statement is parsed before execution.
  Comments/strings are stripped first; multi-statement input is refused; `CREATE OR REPLACE`
  and `MERGE`/`DROP`/`DELETE`/`TRUNCATE`/`UPDATE`/`VACUUM` require confirmation;
  `CREATE USER`/`GRANT` are refused.
- **Honest limitation:** Databricks Free Edition has no per-statement read-only role, so
  unlike the MySQL version there is **no second least-privilege enforcement layer**. The
  token has full access. Destructive operations rely on the classifier + human confirmation
  alone. Don't point this at production data.

## Medallion pipeline

`medallion.js`:
- **bronze** — CSV loaded verbatim with inferred types + `_ingested_at`, `_source`.
- **silver** — `CREATE OR REPLACE ... SELECT` that dedupes (row-number per key, latest wins)
  and drops all-null rows.
- **gold** — `GROUP BY` a dimension with an aggregate (default: count by the first text column).

Verified end-to-end: 10-row CSV → bronze 10, silver 10 (deduped), gold aggregated US=6/GB=3/AT=1.

## Setup

```bash
npm install
npm run doctor      # checks Slack, Databricks, OpenAI, and the classifier
node app.js
```

`.env` (in the parent dir) needs: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `OPENAI_API_KEY`,
`DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID`, and optionally
`DATABRICKS_CATALOG` / `DATABRICKS_SCHEMA` for the default namespace.

## Files

| file | role |
|---|---|
| `databricks.js` | Statement Execution API client + namespace helpers |
| `medallion.js` | CSV ingest + bronze/silver/gold |
| `db.js` | schema introspection over `information_schema` |
| `nl2sql.js` | English → Databricks SQL (OpenAI), classified |
| `guard.js` | SQL safety classifier |
| `app.js` | Slack wiring: context, upload, query, confirmation |
| `doctor.js` | preflight checks |
| `manifest.json` | Slack app manifest |

## Limits

- Free Edition: one warehouse, one metastore. First query after idle pays a cold start (~15s).
- Wizard state is in-memory; a restart loses pending uploads and per-user context.
- No read-only enforcement layer (see Safety).
- CSV inserts batch 200 rows per statement; fine for demos, not bulk loads (use `COPY INTO`
  from cloud storage for that).
