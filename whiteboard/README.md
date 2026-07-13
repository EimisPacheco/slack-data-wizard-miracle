# whiteboard → table / dashboard

Draw on a whiteboard in the browser; **OpenAI vision** reads your sketch. Two modes:

- **Table mode** (default): draw a table — a header row and a few data rows — and it loads
  into a **Databricks** table. "Sketch it on a napkin, query it in your lakehouse."
- **Dashboard mode** (`/?mode=dashboard&channel=<slack channel>`): sketch the **chart you
  want** — bars, a line, handwritten labels, the table name — and OpenAI vision turns the
  drawing into a validated chart spec, publishes a **real Tableau workbook**, and posts the
  chart back into your Slack channel. In Slack, say _"draw a dashboard"_ and Data Wizard posts
  the link with the channel already wired in.

Slack can't host a drawing surface natively (its surfaces are declarative Block Kit / markdown —
no `<canvas>`, no JS, no iframe). So the drawing lives in a small external web app, and the
*result* flows back into Slack and the shared lakehouse that Data Wizard reads.

```
browser <canvas> drawing ──POST /extract───▶ OpenAI vision ──▶ Databricks table
                 └────────POST /dashboard──▶ OpenAI vision ──▶ chart spec (validated against
                                             the live schema) ──▶ Tableau workbook ──▶ Slack
```

## Run

```bash
npm install
node server.js            # → http://localhost:3200
```

Table mode: sketch a table, name it, click **Extract to table**.
Dashboard mode: sketch the chart, click **Build dashboard**.
Reads credentials from the repo-root `.env` (`OPENAI_API_KEY`, `DATABRICKS_*`, `SLACK_BOT_TOKEN`
for the post-back, and the Tableau `SERVER`/`SITE_NAME`/`PAT_*` vars for publishing).

## Verified end-to-end

- **Table:** a hand-drawn-style table (wobbly borders, marker font) → all 3 columns and 5 rows
  extracted with 100% accuracy → typed (`Qty` INT, `Price` DOUBLE) → loaded into the lakehouse →
  queried back correctly.
- **Dashboard:** four wobbly hand-drawn horizontal bars + the table name → read as
  _"a horizontal bar chart of GDP by country from countries_gdp"_ → a real published Tableau
  workbook, with the chart posted back into the Slack channel.

## Using it with Slack / Data Wizard

- Say **"draw a dashboard"** or **"draw a table"** to Data Wizard — it replies with an
  **Open the whiteboard** button carrying your channel ID, so results come home to the channel.
- Tables land in the same Databricks namespace Data Wizard uses, so after drawing you can ask:
  _"show the fruit_stand table"_ — the loop closes with no extra wiring.

## Hosting (for real use / demo)

Locally it's plain HTTP. To use from anywhere, host it publicly — `ngrok http 3200` or any
small VM — and set `WHITEBOARD_URL` in `.env` so Data Wizard's button links to the public URL.

## Notes & limits

- The drawing surface is a dependency-free HTML5 canvas (pen, colors, eraser, clear) — no build
  step, hostable anywhere.
- Table mode is best at *tables* — a header row and data rows. Dashboard mode is best at bar /
  line / scatter sketches with a legible table name (there's a hint box if your handwriting is risky).
- Vision handles rough sketches well, but very messy handwriting will have errors; the extracted
  result is shown before it's trusted.
- Same Free-Edition caveat as the rest of Data Wizard: no read-only DB role.
