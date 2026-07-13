# Devpost submission copy — Data Wizard

## Short Description (255 max)

A data team for companies that don't have one. Upload a file, a scanned page or a whiteboard sketch; build a governed lakehouse; ask questions in plain English or by voice; publish Tableau dashboards — all inside Slack, all reasoned by OpenAI.

## Long Description (600 min / 2000 max)

Every company has data. Most don't have a data team. That gap is the market.

In a small business, the people who own the data can't query it. The office manager holds the signup sheet. The clinic administrator holds scanned invoices. Neither writes SQL; neither has an engineer to ask. So the question never gets asked.

Slack Data Wizard is that data team. Drop a CSV and it becomes a typed table, named in your words. Ask "how many signups per country?" and OpenAI writes the SQL. Say "create a schema called sales" and it writes the DDL. Say "build a medallion pipeline" and get bronze, silver and gold tables. Say "create a dashboard" and it picks the chart and publishes a real Tableau workbook. Ask for "the top 10 countries by population" and Perplexity pulls the real figures from the internet, with citations — or OpenAI generates synthetic rows for testing. Ask by voice note and ElevenLabs transcribes the question and speaks the answer back into the channel. Or reach the same tools from Claude and ChatGPT via MCP.

Then drop in a scanned PDF — the case that matters most. Hospitals and billing offices still run on paper. Today a human retypes it. OpenAI's vision reads the table straight off the page.

And here is the part we're proudest of: say "draw a dashboard", and sketch the chart you want on a whiteboard — wobbly bars, handwritten labels, the table name in marker. OpenAI's vision reads the drawing itself, validates it against the live schema, publishes the Tableau workbook, and posts the chart back into Slack. BI has always demanded that users translate a mental image into analytics language. We removed the translation: the mental image is now the interface.

That changes who touches the data: the person who produces it loads the lakehouse directly — no analyst, no engineer, no untracked copies in between. Every question and every change is a Slack message with a name and a timestamp — an audit trail nobody had to configure.

A model that writes CREATE TABLE can also write DROP TABLE — so every statement is classified before it runs, and destructive ones wait for a click. Voice can never destroy data: destructive requests post the SQL and wait for a human.

This deserves to win because it solves a real problem: it makes data handling faster, simpler and accessible to everyone.

---

# Video narration script (~3 minutes)

Every company has data. Most companies don't have a data team.

Think about who actually holds the numbers. The office manager with the signup sheet. The clinic administrator with a folder of scanned invoices. They own the data. They cannot query it. And there's no engineer down the hall to ask.

So the question doesn't get asked. The decision gets made on instinct.

This is Data Wizard. A data team for the companies that don't have one — living inside Slack, where those people already work.

And Slack is not just a distribution trick — I chose it from experience. I'm a data engineer, and honestly, even for me it's bothersome to connect to one more platform, wait for a console, click past gadgets I never asked for. Most days I just want to ask the question — and send the answer to the person who needs it. Slack gives me exactly that: one simple surface, nothing extra, and when the answer comes back I forward it straight to the coworker, the internal user, the customer. If it's the path of least resistance for an engineer, imagine what it is for the office manager.

They drag in a CSV. It becomes a typed table, named in their own words, not the file's.

Now watch. They drop in a scanned PDF.

Walk into a hospital, a clinic, a medical billing office — and you will find paper. Scanned intake forms. Faxed lab results. Invoices that are pictures of paper, not data. This is not a legacy edge case. This is Tuesday. And today, a human retypes those numbers, one row at a time.

OpenAI's vision reads the table straight off the image — and the page becomes a real, queryable table.

That saves hours. But look at what else it just did.

Every one of those manual steps was a person handling records they didn't need to see. A spreadsheet on a laptop. A printout on a desk. A file emailed to a colleague — each one a copy nobody is tracking. With Data Wizard, the person who produces the data loads the lakehouse directly — no analyst in the middle, no engineer in the middle, no hand-offs at all. The fewer people who ever touch the data, the smaller the surface for a leak. So removing the retyping doesn't just remove the typos. It removes the exposure.

Now the moment we're proudest of. This user doesn't know the words "dimension" and "measure" — but they know exactly what the chart should look like. So they say: "draw a dashboard."

A whiteboard opens. They sketch it — wobbly bars, handwritten labels, the table name in marker. And OpenAI's vision reads the drawing itself. The shape of the bars picks the chart type. The handwriting names the table. Every column is validated against the live schema — and a real, published Tableau workbook posts back into the channel.

BI has always demanded that people translate a mental image into analytics language. We removed the translation. The mental image is now the interface.

The same model does everything else here — OpenAI is the reasoning. It writes the SQL when someone asks "how many signups per country". It writes the DDL when they say "create a schema called sales". It builds them a bronze, silver and gold lakehouse without ever using the word. It picks the chart when they ask for a dashboard. Ask for the top ten countries by population and you get real, cited figures. And you don't even have to type: record a voice note, ElevenLabs transcribes it, the answer comes back as a table — and as a spoken reply.

One last thing, and it matters most for the people we built this for. A model that can write CREATE TABLE can also write DROP TABLE. So every statement the model produces is classified before it runs — and anything destructive waits for a human to click. Even by voice, nothing is ever destroyed without a click.

So why does this deserve to win? Because it solves a real problem — it makes data handling faster, simpler and accessible to everyone. And because of who that unlocks: there are millions of small businesses, clinics and family firms that will never hire a data engineer — and every one of them makes decisions every single day. Data Wizard gives them the whole stack — ingestion, a governed lakehouse, safe SQL, published dashboards — for the cost of typing one sentence in a tool they already have open. Or saying it. Or drawing it.

Every company has data. Most don't have a data team.

That gap is the market. And it is one sentence in Slack away from closing.

---

# Devpost story (first person)

## Inspiration

I'm a data engineer, and even for me, answering a simple data question is bothersome: connect to one more platform, wait for a console, click past gadgets I never asked for. Most days I just want to ask the question — and send the answer to the person who needs it. Then I noticed something: the question was already being asked, every day, in Slack. "Hey, how many signups did we get?" is already a Slack message — it just gets sent to a human who does the work by hand. So I stopped trying to bring people to the data, and brought the data team into Slack. The people who own the data — the office manager with the signup sheet, the clinic administrator with a folder of scanned invoices — will never open a BI console. But they already have Slack open.

## What it does

Data Wizard is a data team living inside Slack. In one channel you can: drop a **CSV** and get a typed table named in your own words; drop a **scanned PDF** and have OpenAI vision read the table off the page image; say **"draw a table"** or **"draw a dashboard"** and sketch it on a whiteboard — vision reads the drawing itself and, for dashboards, publishes a **real Tableau workbook** that posts back into the channel; ask anything in plain English and OpenAI writes and runs the SQL against Databricks; say "build a medallion pipeline" and get bronze/silver/gold with lineage; ask for "the top 10 countries by population" and get **real, cited figures** via Perplexity, or synthetic test rows via OpenAI; record a **voice note** and ElevenLabs transcribes it, answers with a table, and replies with a **spoken clip**. Every destructive statement is shown, explained, and waits for a human click — even when asked by voice.

## How I built it

Slack is the frame everything hangs on. The app is **Bolt for JavaScript in Socket Mode**, and I leaned hard into real Slack surfaces instead of a text bot: the new **Block Kit agent components** — **Data Table** for results and **Card** for actions — with a classic-blocks fallback when a surface doesn't support them; **modals** for the "where does this data go?" decision (new table vs. existing, append vs. replace); **events** (`file_shared`, `app_mention`, `message`) as the entry points; and the **Web API** to post charts and spoken replies back into the channel. Around that Slack core: **OpenAI (Responses API)** does all reasoning and vision — NL→SQL, DDL, chart specs, scanned pages, whiteboard sketches; **Databricks** (Unity Catalog + serverless SQL warehouse) is the lakehouse; **Tableau REST API** turns a generated `.twb` into a published workbook and a PNG rendered back into Slack; **ElevenLabs** covers voice in both directions (Scribe speech-to-text for voice notes, TTS for spoken replies, plus a conversational agent wired to the same query functions by webhook); **Perplexity** grounds real-data tables with citations; an **MCP server** exposes the same tools to Claude, Cursor and ChatGPT; and a small **Express** whiteboard app hosts the drawing canvas, because Slack can't — with the channel ID carried in the link so the finished chart comes home to the right conversation.

## Challenges we ran into

Almost every hard problem was a Slack platform constraint that forced a better design. Slack has no `<canvas>` and no iframes — so drawing had to live in an external web app, and I made it feel native anyway: the bot posts a link button carrying the channel ID, and the result posts itself back into the thread of work. A `trigger_id` dies three seconds after a button click, but listing tables on a cold Databricks warehouse takes longer — so the modal opens instantly as a placeholder and fills itself in with `views.update`. My bot's own spoken-answer MP3s re-triggered `file_shared` and would have had it transcribing itself in an infinite loop — one guard on the bot's user ID fixed it. Slack's built-in voice-clip transcription is free but slow and sometimes absent, so I poll it briefly and fall back to ElevenLabs Scribe. And because Databricks has no per-statement read-only role, I built my own SQL safety classifier — it strips comments and string literals so a keyword smuggled inside a quote can't fool it, and it passes 26 adversarial cases.

## Accomplishments that we're proud of

The sketch-to-dashboard flow, verified end-to-end: four wobbly hand-drawn bars and a table name in marker became a real, published Tableau workbook posted back into Slack — no SQL, no chart builder, no analytics vocabulary. Voice working in both directions inside Slack: a voice note in, a table plus a spoken clip out. The whole journey — file to lakehouse to dashboard — happening in four Slack messages, on real Block Kit surfaces that degrade gracefully. And a safety layer I'd genuinely trust in front of non-technical users: nothing destructive has ever executed without a click.

## What we learned

Meet people on the surface they already have open — the best interface is the one nobody has to adopt. Slack's constraints are features in disguise: because every interaction is a message, I got an audit trail with names and timestamps for free, and because surfaces are declarative, I was forced into clean confirmation flows instead of hidden state. I learned that the model is the operator, not a feature — and that the moment reasoning is good enough, the remaining product work is trust: previews before loads, validation against live schemas, confirmation before destruction. And I learned the external-app-plus-post-back pattern that lets Slack apps do things Slack itself can't host.

## What's next for Slack Data Wizard

Ship it to the **Slack App Directory** with OAuth so any workspace can install it in a click. Scheduled digests — "post the gold table to #leadership every Monday" — so answers arrive before the question. Per-channel memory of catalog and schema context, so teams keep their own workspace of tables. Richer sketch understanding: multi-chart dashboards from one drawing, and photos of physical whiteboards from a phone. And pilots with the users this was always for — clinics, billing offices, and small firms that have data, have Slack, and have never had a data team.
