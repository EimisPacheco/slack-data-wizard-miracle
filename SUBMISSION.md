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
