# Data Wizard

**A data team for companies that don't have one — living inside Slack, reasoning with OpenAI.**

Data Wizard lets someone who has never written a line of SQL upload a file, build a governed
lakehouse, ask questions in plain English — or by voice, or by **drawing** — and publish a Tableau
dashboard, by typing a sentence into Slack. Every act of intelligence in the product is performed
by **OpenAI models**: language for the SQL and DDL, vision for scanned pages and whiteboard sketches.

> 📑 **Pitch deck:** [pitch-deck.html](pitch-deck.html) · [PDF](docs/Data-Wizard-Deck.pdf) — **Submission copy:** [SUBMISSION.md](SUBMISSION.md)

---

## The problem

In most small and mid-size companies, the people who *own* the data are not the people who can
*query* it. An office manager has the signup sheet. A clinic administrator has the invoices. A
regional sales lead has the spreadsheet. None of them write SQL, and none of them have a data
engineer to ask.

So they wait. A question that takes ten seconds to answer takes three days to get answered — if it
gets answered at all. More often, the question simply doesn't get asked, and the decision gets made
on instinct. Meanwhile a scanned invoice gets retyped into Excel by hand, one row at a time.

The tooling that would fix this — a lakehouse, a medallion architecture, a BI server — is real,
mature, and completely out of reach, because it assumes a technical operator sitting in front of it.

**Data Wizard removes the operator.** The interface is a sentence in Slack. The operator is OpenAI.

---

## What it does

Everything below happens in a Slack message. No console, no SQL, no BI licence, no onboarding.

| You do this | Data Wizard does this |
|---|---|
| Drop a **CSV** | Infers every column type, asks what to call the table, loads it |
| Drop a **scanned PDF** | **OpenAI vision** reads the table off the page image and loads it |
| **Draw a table** on the whiteboard | **OpenAI vision** turns the drawing into a real table |
| _"draw a dashboard"_ — then **sketch the chart** | **OpenAI vision reads the drawing itself** — bar shapes, handwritten labels, the table name — and a real Tableau workbook posts back into the channel |
| Record a **voice note** 🎤 | **ElevenLabs** transcribes it, the answer posts as a table, and a **spoken reply** comes back as a playable clip |
| _"how many signups per country?"_ | **OpenAI writes the SQL**, runs it, returns a formatted table |
| _"create a schema called sales"_ | **OpenAI writes the DDL** — creation is natural language too |
| _"build a medallion pipeline"_ | Bronze → Silver → Gold, with lineage, dedup and a chosen aggregation |
| _"create a dashboard with signups"_ | **OpenAI picks the chart**, and a real Tableau workbook is published |
| _"generate 20 fake vendors"_ | Synthetic rows via OpenAI — or **real, cited figures** from the web via Perplexity |
| _"delete the inactive users"_ | Shows you the SQL and **waits for you to click** before touching anything |

The person doing this does not know they are using Unity Catalog, a medallion architecture, or a
Tableau REST API. They know they typed a sentence and got an answer.

---

## Where OpenAI sits

OpenAI is not a garnish on this project. **OpenAI is the product's reasoning.** There is no fallback
path in which a human writes the SQL. One model family drives five independent capabilities:

| Capability | What OpenAI does | Module |
|---|---|---|
| **Natural language → SQL** | Reads the live schema, writes one Databricks statement, explains it | `slack-data-agent/nl2sql.js` |
| **Natural language → DDL** | `CREATE SCHEMA`, `CREATE TABLE`, `SHOW`, `DESCRIBE` — all model-authored | `slack-data-agent/nl2sql.js` |
| **Vision: scanned document → table** | Reads a rasterised page image and extracts the table structure | `pdf-extract/vision.js` |
| **Vision: whiteboard → table & dashboard** | Reads a hand-drawn table into schema and rows — or reads a **sketched chart** (bar shapes, handwritten labels, the table name) and turns it into a validated spec for a published Tableau workbook. Verified end-to-end on real drawings. | `whiteboard/` |
| **Chart selection** | Chooses chart type, dimension, measure and aggregation from a sentence — the same path a sketch flows into | `viz-builder/spec.js` |

Everything the model writes is validated before it acts: SQL goes through a safety classifier,
chart specs are checked column-by-column against the live Databricks schema, and vision output is
previewed to the user before a single row is loaded.

---

## The paper problem — and why healthcare is the sharpest case

Scanned documents are not a legacy edge case. They are how much of the economy still runs, and
nowhere more than in healthcare. Walk into a hospital, a clinic, a medical billing office, and you
will find **scanned intake forms, faxed lab results, photographed insurance cards, and PDF invoices
that are pictures of paper, not data.**

Today, a human retypes those numbers into a system, one row at a time. That is slow, it is expensive,
and — critically, in a clinical setting — **it is a transcription-error surface on data that matters.**
The person doing the retyping is usually an administrator, not a technologist, and they have no data
team to escalate to. They are precisely the user this product is for.

Data Wizard turns a scanned page into a queryable table: rasterise the page, hand the image to
**OpenAI vision**, get back a typed table in the lakehouse. Verified end-to-end on a real scanned
invoice. The extracted rows are always previewed in Slack before loading, so a human eyeballs the
scan against the table before it is trusted.

### Fewer hands on the data is itself a security control

**Every manual step in a data workflow is a person handling records they do not need to see.** The
administrator retyping an invoice reads every line of it. To do the job they export a spreadsheet to
a laptop, print a page to check it against, email a copy to a colleague to verify a number. Each of
those is a copy of sensitive data, sitting somewhere nobody is tracking, outliving the task that
created it.

**The fewer humans who ever handle the data, the smaller the surface for a leak.** This is the same
logic as least-privilege access, applied to a workflow rather than a permission: the safest record
is one that no unnecessary person ever opened, and that was never copied to a place with no owner.

Data Wizard removes the retyping, and with it the exports, the printouts and the emailed copies. The
record goes **from the page straight into a governed table** — and every access is a Slack message
with a name and a timestamp. Governance that nobody had to configure.

---

## Safety, because non-technical users are exactly who you must protect

A model that can write `CREATE TABLE` can also write `DROP TABLE`. Databricks has no per-statement
read-only role, so the guard is ours to build:

- `guard.js` **classifies every statement** the model produces before it runs — read, write, or
  destructive — after stripping comments and string literals, so a keyword hidden inside a quoted
  value can't smuggle itself past the classifier.
- Anything destructive is **never executed silently**. The SQL is shown in a Slack card, in plain
  English, and it does not run until a human clicks. That includes requests made **by voice** — a
  voice note can never destroy data.
- Malformed model output is **detected and regenerated** rather than executed. (A model that emits
  `IN ('', '')` returns "no rows" — which reads like a real answer and is far more dangerous than
  an error.)

---

## Architecture

```
Slack (Bolt, Socket Mode, Block Kit)
  │
  ├── CSV / scanned PDF / whiteboard ──► OpenAI vision ──► typed rows
  ├── plain-English question ──────────► OpenAI NL→SQL ──► guard ──► Databricks
  ├── "create a dashboard" ────────────► OpenAI chart spec ──► Tableau workbook
  ├── "draw a dashboard" + a sketch ───► OpenAI vision ──► chart spec ──► Tableau ──► back into Slack
  ├── voice note 🎤 ───────────────────► ElevenLabs Scribe STT ──► same NL→SQL ──► ElevenLabs TTS spoken reply
  ├── live voice ──────────────────────► ElevenLabs conversational agent ──► the same functions
  └── MCP (Claude · Cursor · ChatGPT) ─► mcp-server ──► the same functions
                                              │
                                          Databricks
                                   (Unity Catalog · medallion)
```

| Module | Role |
|---|---|
| `slack-data-agent/` | The agent: Block Kit UI, NL→SQL, safety guard, medallion pipeline |
| `csv-to-db/` | RFC-4180 parser and type inference (incl. thousands separators) |
| `pdf-extract/` | Rasterise a scanned PDF, extract its table with OpenAI vision |
| `whiteboard/` | Draw a **table** by hand, get a real one — or sketch a **chart** and get a published Tableau dashboard posted back into Slack |
| `viz-builder/` | Sentence → Tableau `.twb` → published workbook → rendered PNG |
| `datagen/` | Bootstrap a table from the live web (Perplexity) or synthetically (OpenAI) |
| `voice-agent/` | ElevenLabs voice agent: ask out loud, answers + transcripts posted back to Slack |
| `mcp-server/` | Exposes the same tools over MCP (Streamable HTTP) to Claude, Cursor and ChatGPT |
| `tableau-voice-backend/` | Tableau Extensions API: voice-controlled dashboard filtering |

---

## Why it matters commercially

Every company has data. Most companies do not have a data team. That gap is the entire market.

Data Wizard is not a cheaper BI tool — it is a **BI tool with the technical prerequisite removed**.
Its distribution channel is Slack, which the target customer is already inside all day. The cost of
serving one more company is an API call, not one more data engineer.

---

## Everything a user can say

There are no commands to memorise and no syntax. OpenAI reads the **live schema**, so it answers
against whatever tables actually exist in your catalog. These are just examples of phrasing that works.

**📥 Load data**
- Drop a **`.csv`** into the channel — every column type is inferred, then it asks what to name the table
- Drop a **scanned `.pdf`** — OpenAI vision reads the table off the page image
- _"draw a table"_ — sketch it on the whiteboard, OpenAI vision reads it into typed rows
- Then choose: **a new table** (you name it) or **an existing table** → **append** or **replace**
- **Build pipeline** — bronze / silver / gold in one click

**❓ Ask questions**
- _"how many signups per country?"_
- _"show me the top 5 countries in countries_gdp"_
- _"which countries have the largest population?"_
- _"top 3 by score"_ · _"show the gold table"_

**🔍 Explore the lakehouse** — the model writes the `SHOW` / `DESCRIBE` itself; none of it is hard-coded
- _"what catalogs are there?"_
- _"list the tables"_
- _"what columns does signups_silver have?"_

**🏗 Create objects** — the model writes the DDL, and you're moved into whatever it just created
- _"create a schema called sales"_
- _"create a catalog called finance"_

**🌐 Generate a table**
- _"create a table of the top 10 countries by population"_ — **real** figures from the web, with citations
- _"generate 20 fake vendors with contact emails"_ — **synthetic** rows; any phrasing that names a source works
- If it's ambiguous, Data Wizard asks you: 🌐 real or 🎲 synthetic?

**📊 Dashboards**
- _"create a dashboard with hackathon_signups"_ — OpenAI picks the chart and a **real Tableau workbook is published**
- _"draw a dashboard"_ — **sketch the chart on the whiteboard**; OpenAI vision reads the drawing (bar shapes, handwritten labels, the table name), validates it against the live schema, publishes the workbook, and **posts the chart back into the channel**

**⚠️ Change data** — always confirmed first
- _"drop the bronze table"_ · _"delete the inactive users"_
- The SQL is **shown, explained in plain English, and waits for your click**

**🎙 Ask by voice**
- Record a **voice note** (🎤 in the message box) — **ElevenLabs Scribe** transcribes it (Slack's own transcription is tried first), the question runs the same NL→SQL path, the answer posts as a table, and a **spoken reply** (ElevenLabs TTS) comes back as a playable clip
- Or speak to the ElevenLabs "Data Wizard Voice" agent — it runs the same NL→SQL path, answers out loud, and posts every Q&A + the full transcript back into Slack
- Destructive SQL is **never executed from voice** — it posts for a confirming click

**Where you are**
- `help` · `context` (where am I?) · `use catalog <name>` · `use schema <name>`

---

## Running it

```bash
cd slack-data-agent
npm install
npm run doctor      # preflight: Slack, Databricks, OpenAI, Tableau, guard
node app.js
```

Optional extras:

```bash
(cd whiteboard && node server.js)       # whiteboard → table / dashboard, http://localhost:3200
(cd voice-agent && node server.js)      # live voice agent (needs its HTTPS tunnel for ElevenLabs)
mcp-server/start-hosted.sh              # MCP endpoint for Slack / Claude / Cursor / ChatGPT
```

Configuration lives in `.env` (never committed). `OPENAI_API_KEY` powers all reasoning and vision;
`OPENAI_MODEL` selects the model.
