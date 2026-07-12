# datagen

Generates table data from a plain-English description, from two sources:

- **`fromSearch(description)`** → **Perplexity** (`sonar`): real, current statistics grounded
  in web search, with citations. E.g. "top 10 countries by population".
- **`synthetic(description)`** → **OpenAI** (`gpt-5.6-terra`): plausible fake rows. E.g.
  "20 sample employees with name, department, salary".

Both return `{ columns, rows, csv, source, citations }`, so the output feeds Data Wizard's
existing CSV → Databricks table path unchanged.

## Routing

`detectSource(text)` returns `'real' | 'synthetic' | 'ask'`:
- real signals: real, actual, current, latest, 202x, statistics, "top N countries", official
- synthetic signals: fake, synthetic, dummy, sample, mock, random, test data
- otherwise `'ask'` — Data Wizard shows a Card with 🌐 Real / 🎲 Synthetic buttons.

## Verified

- Real: "top 8 countries by population 2026" → India 1.48B, China 1.41B, US 349M … with 9
  citations, clean 4-column table, ~2s.
- Real → Databricks: "top 5 by GDP 2026" → US $32.38T, China $20.85T … typed (Rank INT,
  GDP DOUBLE), loaded and queried, `_source=perplexity` lineage.
- Synthetic: "12 fake employees" → plausible name/department/salary/hire_date rows, ~5s.
- Intent detection: 5/5 on the test cases.

## Reliability

`sonar` returns prose+citations by default, so the prompt demands `{"columns":[…],"rows":[…]}`
JSON only; `fromSearch` strips fences, brace-extracts, enforces rectangular rows, and retries
once. If it still isn't tabular it throws a clear error rather than writing garbage.

Real figures are grounded but not infallible — verify numbers that matter.
