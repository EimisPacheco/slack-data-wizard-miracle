# whiteboard → table

Draw a table on a whiteboard in the browser; **Gemma vision (AMD MI300X)** reads your sketch and
loads it into a **Databricks** table. "Sketch it on a napkin, query it in your lakehouse."

Slack can't host a drawing surface natively (its surfaces are declarative Block Kit / markdown —
no `<canvas>`, no JS, no iframe). So the drawing lives in a small external web app — the same
external-web-app + post-result pattern as the original Tableau extension — and the *result* flows
into the shared lakehouse that Data Wizard reads.

```
browser <canvas> drawing ──POST /extract──▶ Gemma vision (droplet) ──▶ Databricks table
                                                                          │
                                          Data Wizard can then query it ◀─┘
```

## Run

```bash
npm install
node server.js            # → http://localhost:3200
```

Open it, sketch a table (a header row + a few data rows), name it, click **Extract to table**.
Reads credentials from the repo-root `.env` (`GEMMA_BASE_URL`, `DATABRICKS_*`).

## Verified end-to-end

A hand-drawn-style table (wobbly borders, marker font) → Gemma extracted all 3 columns and 5 rows
with 100% accuracy → typed (`Qty` INT, `Price` DOUBLE) → loaded into `workspace.data_wizard` →
queried back correctly (`ORDER BY Qty DESC`). ~12s for Gemma, ~40s total incl. Databricks cold start.

## Using it with Slack / Data Wizard

- The table lands in the same Databricks namespace Data Wizard uses, so after drawing you can ask
  **Data Wizard**: _"show the fruit_stand table"_ — the loop closes with no extra wiring.
- For a Slack entry point, add a button/link in a Slack message that opens this page (hosted).
  Slack opens external links in the browser; the drawing surface can't be embedded in Slack itself.

## Hosting (for real use / demo)

Locally it's plain HTTP. To use from anywhere (or from a Slack link), host it publicly —
`ngrok http 3200`, or run it on your AMD droplet. The droplet is ideal since Gemma already runs
there; the round-trip stays on one box.

## Notes & limits

- The drawing surface is a dependency-free HTML5 canvas (pen, colors, eraser, clear) — no build
  step, hostable anywhere.
- Best at *tables* — a header row and data rows. Free-form diagrams/charts aren't parsed as tables.
- Gemma handles rough sketches well, but very messy handwriting will have errors; the extracted
  table is shown before it's trusted.
- Same Free-Edition caveat as the rest of Data Wizard: no read-only DB role.
