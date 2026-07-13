# viz-builder

Real-time Tableau workbook creation from selected tables and a plain-English question.
You pick tables and ask a question; it generates a `.twb`, publishes it to Tableau Cloud,
renders the view, and returns a PNG.

```
question + tables
   │
   ├─ spec.js   NL → viz spec         (OpenAI, validated against the live Databricks schema)
   ├─ deploy.js snapshot table → CSV, embed in the .twbx, publish, render
   ├─ twbgen.js spec → .twb XML        (embedded-CSV connection, modelled on Tableau's own workbooks)
   └─ publish.py .twb → Tableau Cloud   (tableauserverclient; no live connection, so no DB creds)
```

## How it's invoked

It's a library, called by the Slack agent's dashboard command — a user types
_"create a dashboard with hackathon_signups"_ and `app.js` runs `describeToSpec()` (spec.js)
then `buildAndDeploy()` (deploy.js). Publishing needs `TSC_PYTHON` pointing at a Python with
`tableauserverclient` installed.

## Chart types (all verified end-to-end against a live site)

| type | shelves | verified with |
|---|---|---|
| `bar` | dimension on cols, `AGG(measure)` on rows | signups by country |
| `hbar` | dimension on rows, `AGG(measure)` on cols | avg stance score by country |
| `line` | truncated date on cols, `AGG(measure)` on rows | avg score over Jul 1–5 |
| `map` | filled `Multipolygon`, geo dimension, color by field | stance by country |
| `scatter` | two measures on rows/cols, dimension on detail | (mechanism built) |
| `table` | text marks | (mechanism built) |

`bar`, `hbar`, `line`, `map` are proven with rendered images. `scatter` and `table` share the
same generator paths but haven't been screenshot-verified — treat them as beta.

## Aggregations

`SUM`, `AVG`, `COUNT`, `COUNTD`. For "how many", the model uses `COUNT` on an id column.

## Dates

Line charts truncate the date so a time axis actually has multiple points:
`--dateGranularity day|month|year` (via the spec). Categorical charts use discrete year.
This matters: without it, data inside a single year collapses to one dot.

## What makes it reliable

Every hard lesson from hand-building the first workbook is baked into `twbgen.js`:

- **A `<metadata-record>` per column**, or Tableau returns zero rows.
- **Every field on a shelf/encoding is declared in `<datasource-dependencies>`.** A single
  undeclared reference blanks the entire view with no error — this cost hours to find.
- **Unique datasource captions**, or publish fails with `400011 duplicate data source name`.
- Filled maps need `Multipolygon` + `[Geometry (generated)]` + generated lat/lon + an
  `ISO3166_2` semantic role — not the numeric lat/lon columns, which produce a scatterplot.

## Limits

- One worksheet per workbook. No dashboards, no multi-sheet layouts.
- Custom colors use Tableau defaults (the categorical palette override is still unsolved).
- The model occasionally references a column that doesn't exist; `spec.js` validates against
  the real schema and refuses rather than generating broken SQL.
- Publishing needs the Python `tableauserverclient`; a pure-Node REST publish isn't built yet.
- Each call publishes a new/overwritten workbook — fine for a demo, not for high volume.
