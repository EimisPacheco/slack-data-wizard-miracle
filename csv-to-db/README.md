# csv-to-db

The CSV-ingestion library for the Slack agent. It parses a CSV (RFC-4180: quoted fields,
embedded commas and newlines, escaped quotes) and infers a column type for every column. The
Slack agent hands the result to `medallion.js`, which maps the inferred types to Databricks and
loads the rows.

No CLI and no database driver of its own — it's imported, not run:

```js
import { analyseCsv } from './csv.js';
const { columns, dataRows } = analyseCsv(csvText);
// columns: [{ name, type }]   dataRows: string[][]
```

## Type inference

Every value in a column is examined; the type widens on conflict. The names are a portable SQL
vocabulary — `medallion.js` maps them to Databricks types (`STRING`, `TIMESTAMP`, …).

| CSV column contains | inferred type |
|---|---|
| only integers | `INT`, or `BIGINT` past 2³¹ |
| integers and decimals | `DOUBLE` |
| only `true`/`false` | `BOOLEAN` |
| `YYYY-MM-DD HH:MM[:SS]` | `DATETIME` |
| `YYYY-MM-DD` | `DATE` |
| anything else | `VARCHAR(n)`, or `TEXT` past 1000 chars |

An empty cell is `NULL`. A column that is empty in every row becomes `TEXT`. Thousands
separators are handled: `1,476,625,576` is read as the number, so numeric sorts are correct.

## Notes

- **Identifiers are sanitised** (`My Column!` → `My_Column`); a leading digit gets a prefix, and
  duplicate names after sanitising are rejected.
- Datetimes are parsed as written; store UTC in the CSV if timezone matters.

## Where it fits

A user drops a CSV into a channel; the bot downloads it via `url_private_download` (with a
`Bearer` token — without one Slack returns an HTML login page, not the file) and passes the bytes
to `analyseCsv()`.
