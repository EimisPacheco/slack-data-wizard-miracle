# Data Wizard

**A data team for companies that don't have one — living inside Slack, thinking on AMD GPUs.**

Data Wizard lets someone who has never written a line of SQL upload a file, build a governed
lakehouse, ask questions in plain English, and publish a Tableau dashboard — by typing a sentence
into Slack. Every act of intelligence in the product is performed by **Gemma, an open-source model
running on an AMD GPU**.

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

**Data Wizard removes the operator.** The interface is a sentence in Slack. The operator is Gemma.

---

## What it does

Everything below happens in a Slack message. No console, no SQL, no BI licence, no onboarding.

| You do this | Data Wizard does this |
|---|---|
| Drop a **CSV** | Infers every column type, asks what to call the table, loads it |
| Drop a **scanned PDF** | **Gemma's vision** reads the table off the page image and loads it |
| **Draw a table** on the whiteboard | **Gemma's vision** turns the drawing into a real table — ⚠️ *in progress, not yet verified* |
| _"how many signups per country?"_ | **Gemma writes the SQL**, runs it, returns a formatted table |
| _"create a schema called sales"_ | **Gemma writes the DDL** — creation is natural language too |
| _"build a medallion pipeline"_ | Bronze → Silver → Gold, with lineage, dedup and a chosen aggregation |
| _"create a dashboard with signups"_ | **Gemma picks the chart**, and a real Tableau workbook is published |
| _"delete the inactive users"_ | Shows you the SQL and **waits for you to click** before touching anything |

The person doing this does not know they are using Unity Catalog, a medallion architecture, or a
Tableau REST API. They know they typed a sentence and got an answer.

---

## Where AMD sits

Gemma is not a garnish on this project. **Gemma is the product's reasoning.** Remove the AMD GPU and
Data Wizard stops being able to think — there is no fallback path in which a human writes the SQL.

`gemma4:31b` is served with Ollama on an **AMD Instinct GPU on AMD Developer Cloud (ROCm)**, and it
is the engine behind four independent capabilities:

| Capability | What Gemma does | Module |
|---|---|---|
| **Natural language → SQL** | Reads the live schema, writes one Databricks statement, explains it | `slack-data-agent/nl2sql.js` |
| **Natural language → DDL** | `CREATE SCHEMA`, `CREATE TABLE`, `SHOW`, `DESCRIBE` — all model-authored | `slack-data-agent/nl2sql.js` |
| **Vision: scanned document → table** | Reads a rasterised page image and extracts the table structure | `pdf-extract/gemma.js` |
| **Vision: whiteboard → table** ⚠️ *in progress* | Turns a hand-drawn table into a schema and rows. Built on the same Gemma vision path as the scanned page, but **not yet verified end-to-end**. | `whiteboard/` |
| **Chart selection** | Chooses chart type, dimension, measure and aggregation from a sentence | `viz-builder/spec.js` |

The **Fireworks AI API** serves the same open-source Gemma family as an automatic fallback for the
vision path, so a GPU cold-start never becomes a failed user request.

We chose an open model deliberately. A company's ledger, payroll and customer list are exactly the
data you do not want to hand to a closed API — **an open model on your own AMD GPU is the only
version of this product a cautious business can actually adopt.**

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
**Gemma's vision on the AMD GPU**, get back a typed table in the lakehouse. Verified end-to-end on a
real scanned invoice.

### Why this *requires* an open model on your own GPU

Here is the part that matters, and it is the reason the AMD platform is not an implementation detail:

**A scanned patient record is exactly the data you cannot paste into a closed, third-party API.**
Protected health information is subject to HIPAA in the US and GDPR in the EU. For a huge class of
organisations, sending that page to an external model endpoint is not a trade-off to weigh — it is
simply not permitted.

An open-source model running on **your own AMD Instinct GPU** means the page never leaves your
infrastructure. There is no third-party processor, no data-sharing agreement to negotiate, no vendor
retention policy to audit. Same for the ledger, the payroll file, and the customer list.

This is what makes the architecture *adoptable* rather than merely clever. A closed-API version of
Data Wizard could not be deployed in a hospital at all. **Take away the AMD GPU and you do not get a
slower product — in regulated industries you get no product.**

> Scope note: self-hosting is the architecture that makes compliance *possible*; it is not itself a
> certification. Data Wizard is a hackathon prototype, not a HIPAA-attested system.

### Fewer hands on the data is itself a security control

There is a second, quieter security win, and it has nothing to do with the model.

**Every manual step in a data workflow is a person handling records they do not need to see.** The
administrator retyping an invoice reads every line of it. To do the job they export a spreadsheet to
a laptop, print a page to check it against, email a copy to a colleague to verify a number. Each of
those is a copy of sensitive data, sitting somewhere nobody is tracking, outliving the task that
created it.

**The fewer humans who ever handle the data, the smaller the surface for a leak.** This is the same
logic as least-privilege access, applied to a workflow rather than a permission: the safest record
is one that no unnecessary person ever opened, and that was never copied to a place with no owner.

Data Wizard removes the retyping, and with it the exports, the printouts and the emailed copies. The
record goes **from the page straight into a governed table** — read by one model, on hardware you
control, and by nobody else. Every access is a Slack message with a name and a timestamp.

So the same change that removes the transcription errors also removes the insider-risk surface and
the untracked copies. **Less human handling is less exposure.**

---

## Safety, because non-technical users are exactly who you must protect

A model that can write `CREATE TABLE` can also write `DROP TABLE`. Databricks has no per-statement
read-only role, so the guard is ours to build:

- `guard.js` **classifies every statement** the model produces before it runs — read, write, or
  destructive — after stripping comments and string literals, so a keyword hidden inside a quoted
  value can't smuggle itself past the classifier.
- Anything destructive is **never executed silently**. The SQL is shown in a Slack card, in plain
  English, and it does not run until a human clicks.
- Malformed model output is **detected and regenerated** rather than executed. (A model that emits
  `IN ('', '')` returns "no rows" — which reads like a real answer and is far more dangerous than
  an error.)

---

## Architecture

```
Slack (Bolt, Socket Mode, Block Kit)
  │
  ├── CSV / scanned PDF / whiteboard ──► Gemma vision (AMD GPU) ──► typed rows
  ├── plain-English question ──────────► Gemma NL→SQL (AMD GPU) ──► guard ──► Databricks
  ├── "create a dashboard" ────────────► Gemma chart spec (AMD GPU) ──► Tableau workbook
  └── voice ───────────────────────────► ElevenLabs agent ──► the same functions
                                              │
                                    Databricks Free Edition
                                   (Unity Catalog · medallion)
```

| Module | Role |
|---|---|
| `slack-data-agent/` | The agent: Block Kit UI, NL→SQL, safety guard, medallion pipeline |
| `csv-to-db/` | RFC-4180 parser and type inference (incl. thousands separators) |
| `pdf-extract/` | Rasterise a scanned PDF, extract its table with Gemma vision |
| `whiteboard/` | Draw a table by hand, get a real one — ⚠️ *in progress* |
| `viz-builder/` | Sentence → Tableau `.twb` → published workbook → rendered PNG |
| `datagen/` | Bootstrap a table from the live web (Perplexity) or synthetically |

---

## Why it matters commercially

Every company has data. Most companies do not have a data team. That gap is the entire market.

Data Wizard is not a cheaper BI tool — it is a **BI tool with the technical prerequisite removed**.
Its distribution channel is Slack, which the target customer is already inside all day, and its
reasoning runs on an open model they can host themselves. The cost of serving one more company is
the cost of one more GPU-second, not the cost of one more data engineer.

---

## Everything a user can say

There are no commands to memorise and no syntax. Gemma reads the **live schema**, so it answers
against whatever tables actually exist in your catalog. These are just examples of phrasing that works.

**📥 Load data**
- Drop a **`.csv`** into the channel — every column type is inferred, then it asks what to name the table
- Drop a **scanned `.pdf`** — Gemma's vision reads the table off the page image
- Then choose: **a new table** (you name it) or **an existing table** → **append** or **replace**
- **Build medallion pipeline** — bronze / silver / gold in one click

**❓ Ask questions**
- _"how many signups per country?"_
- _"show me the top 5 countries in countries_gdp"_
- _"which countries have the largest population?"_
- _"top 3 by score"_ · _"show the gold table"_

**🔍 Explore the lakehouse** — Gemma writes the `SHOW` / `DESCRIBE` itself; none of it is hard-coded
- _"what catalogs are there?"_
- _"list the tables"_
- _"what columns does signups_silver have?"_

**🏗 Create objects** — Gemma writes the DDL, and you're moved into whatever it just created
- _"create a schema called sales"_
- _"create a catalog called finance"_

**🌐 Generate a table**
- _"create a table of the top 10 countries by population"_ — **real** figures from the web, with citations
- _"generate 20 fake employees"_ — **synthetic** rows
- If it's ambiguous, Data Wizard asks you: 🌐 real or 🎲 synthetic?

**📊 Dashboards**
- _"create a dashboard with hackathon_signups"_ — Gemma picks the chart and a **real Tableau workbook is published**

**⚠️ Change data** — always confirmed first
- _"drop the bronze table"_ · _"delete the inactive users"_
- The SQL is **shown, explained in plain English, and waits for your click**

**Where you are**
- `help` · `context` (where am I?) · `use catalog <name>` · `use schema <name>`

---

## Running it

```bash
npm install
npm run doctor      # preflight: Slack, Databricks, Gemma on AMD, Tableau, guard
node slack-data-agent/app.js
```

Configuration lives in `.env` (never committed). `NL2SQL_PROVIDER=gemma` keeps the reasoning on the
AMD GPU; the provider is switchable, but Gemma is the default and the point.
