# csv-to-db

Uploads a CSV into MySQL. If the target table doesn't exist, it is created from the
schema inferred from the CSV. Credentials come from `../.env` (`MYSQL_*`).

## Usage

```bash
cd csv-to-db
npm install

node index.js samples/hackathon_signups.csv            # create table if needed, insert
node index.js data.csv --table my_table                # override the table name
node index.js data.csv --truncate                      # replace rows instead of appending
node index.js data.csv --dry-run                       # print inferred DDL, touch nothing
node index.js data.csv --batch 1000                    # rows per INSERT (default 500)
```

Table name defaults to the CSV's filename.

## Type inference

Every value in a column is examined; the type widens on conflict.

| CSV column contains | MySQL type |
|---|---|
| only integers | `INT`, or `BIGINT` past 2³¹ |
| integers and decimals | `DOUBLE` |
| only `true`/`false` | `BOOLEAN` (stored as `tinyint(1)`) |
| `YYYY-MM-DD HH:MM[:SS]` | `DATETIME` |
| `YYYY-MM-DD` | `DATE` |
| anything else | `VARCHAR(n)`, or `TEXT` past 1000 chars |

An empty cell is `NULL`. A column that is empty in every row becomes `TEXT`.

## Behaviour worth knowing

- **Appends by default.** Running twice inserts the rows twice. Use `--truncate` to replace.
- **Refuses schema drift.** If the table exists but lacks a column the CSV has, it aborts
  rather than dropping data. Extra columns in the table are fine.
- **All-or-nothing.** Inserts run in a transaction and roll back on any error.
- **Identifiers are sanitised** (`My Column!` → `My_Column`) and a leading digit gets a `c_`
  prefix. Duplicate names after sanitising are rejected.
- **Datetimes are read in the server's local timezone.** `09:15:00` in the CSV comes back as
  `13:15Z` on a UTC-4 machine. Store UTC in the CSV if that matters.
- Values are always bound as parameters, never interpolated. Identifiers are quoted with
  backticks after sanitising.

## Why this exists

It's the ingestion half of the Slack agent: a user drops a CSV into a channel, the bot
downloads it via `url_private_download` (with a `Bearer` token — without one Slack returns
an HTML login page, not the file), and hands the bytes to `analyseCsv()` from `csv.js`.
