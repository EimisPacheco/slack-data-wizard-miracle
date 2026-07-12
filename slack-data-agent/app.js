import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pkg from '@slack/bolt';
const { App } = pkg;

for (const line of fs.readFileSync(path.resolve(import.meta.dirname, '../.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const REQUIRED = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'OPENAI_API_KEY',
  'DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'DATABRICKS_WAREHOUSE_ID'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing in ../.env:\n${missing.map(m => `  - ${m}`).join('\n')}`);
  process.exit(1);
}

const { planQuery, runPlanned } = await import('./nl2sql.js');
const { runSql, ensureSchema, listTables } = await import('./databricks.js');
const { buildPipeline, loadFlatTable } = await import('./medallion.js');
const { analyseCsv } = await import('../csv-to-db/csv.js');
const { extractPdf } = await import('../pdf-extract/extract.js');
const { card, cardClassic, dataTable, tableClassic, postRich } = await import('./blocks.js');
const { fromSearch, synthetic, detectSource } = await import('../datagen/datagen.js');

const DEFAULT_CATALOG = process.env.DATABRICKS_CATALOG || 'workspace';
const DEFAULT_SCHEMA = process.env.DATABRICKS_SCHEMA || 'data_wizard';

const app = new App({ token: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN, socketMode: true });

// Per-user working context and short-lived wizard state. Lost on restart, by design.
const context = new Map();     // userId -> { catalog, schema }
const pendingUpload = new Map();// userId -> { csvText, filename, columns, dataRows }
const pendingSql = new Map();   // actionId -> { plan, context }

function ctxOf(userId) {
  if (!context.has(userId)) context.set(userId, { catalog: DEFAULT_CATALOG, schema: DEFAULT_SCHEMA });
  return context.get(userId);
}
const post = (client, channel, text, blocks) => client.chat.postMessage({ channel, text, ...(blocks ? { blocks } : {}) });

// ─────────────────────────── context commands ───────────────────────────

const HELP_TEXT =
`*Data Wizard* — manage your Databricks lakehouse in plain English.

*Where you're working*
• \`help\` — show this
• \`context\` — your current catalog.schema
• \`use catalog <name>\` / \`use schema <name>\` — switch

*Ask Gemma anything — it writes the SQL*
• _"what catalogs are there?"_  _"list the tables"_  _"what columns does signups_silver have?"_
• _"create a schema called sales"_  _"create a table of…"_

*Load data*
• Drop a *.csv* — or a *scanned .pdf* (Gemma reads the table from the image) — then pick
  *Load as table* or *Build medallion pipeline* (bronze/silver/gold).

*Ask anything in plain English*
• _"how many signups per country?"_  _"top 3 by score"_  _"show the gold table"_

*Change data (always confirmed first)*
• _"drop the bronze table"_, _"delete inactive users"_ — I show the SQL and wait for your click.`;

// Loose phrasing: pull a catalog/schema name out of varied wording.
const NAME = `["'\`]?([A-Za-z0-9_]+)["'\`]?`;

async function tryContextCommand(text, userId, channel, client) {
  // Slack sends code-formatted text with backticks (`list tables`); strip them or the
  // ^-anchored patterns below never match. Underscores are kept — table names use them.
  const raw = text.trim().replace(/`/g, '').trim();
  const t = raw.replace(/[?.!]+$/, '');
  const ctx = ctxOf(userId);
  let m;

  if (/^(help|commands|what can (i|you) do)$/i.test(t) || raw === '?') {
    await post(client, channel, HELP_TEXT);
    return true;
  }
  if (/\b(context|where am i|whoami|current (catalog|schema|namespace))\b/i.test(t) && !/\b(create|use|switch|list|show|table)\b/i.test(t)) {
    await post(client, channel, `You're in *${ctx.catalog}.${ctx.schema}*.`);
    return true;
  }
  // NOTE: listing (SHOW CATALOGS/SCHEMAS/TABLES) and object creation (CREATE SCHEMA/CATALOG/TABLE)
  // are NOT matched here — Gemma writes the SQL for those and it runs through the safety guard.
  // Only true app-state commands stay hard-coded, because they aren't SQL: our Databricks calls
  // are stateless (catalog/schema are passed per statement), so "use X" must be tracked in-app.
  if ((m = t.match(new RegExp(`\\b(?:use|switch to|go to|change to|open)\\b.*\\bcatalog\\s+${NAME}`, 'i')))) {
    ctx.catalog = m[1]; ctx.schema = 'default';
    await post(client, channel, `Switched to catalog *${ctx.catalog}* (schema reset to \`default\`).`);
    return true;
  }
  if ((m = t.match(new RegExp(`\\b(?:use|switch to|go to|change to|open)\\b.*\\b(?:schema|database)\\s+${NAME}`, 'i')))) {
    ctx.schema = m[1];
    await post(client, channel, `Now using *${ctx.catalog}.${ctx.schema}*.`);
    return true;
  }
  return false;
}

// ─────────────────────────── natural-language queries ───────────────────────────

// "create/make/generate a table of <description>" → data generation, not SQL.
const DATAGEN_RE = /^(?:create|make|generate|build|get|fetch|pull)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:table|dataset|data)\s+(?:of|about|on|for|with|from)\s+(.+)/i;

/**
 * Cleans a filename or description into a sensible SUGGESTED table name. Real exports look like
 * "2026_q3_export_signups_v2.csv" — strip the noise so the pre-filled suggestion is the word the
 * user would actually say. They can always override it in the modal.
 */
function suggestTableName(raw) {
  let n = String(raw).toLowerCase()
    .replace(/\.(csv|pdf)$/i, '')
    .replace(/[^a-z0-9]+/g, '_');
  n = n
    .replace(/^(\d{4,8}|\d{4}_?q[1-4]|\d{2}_\d{2}_\d{2,4})_/, '')   // leading dates / quarters
    .replace(/^(export|extract|report|copy_of|final|raw|data|dump)_/, '') // export prefixes
    .replace(/_(export|extract|final|raw|copy|latest|\d{4,8})$/, '')     // trailing noise
    .replace(/_v\d+$/, '')                                              // _v2
    .replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  if (!n || /^\d/.test(n)) n = 'my_table';
  return n.slice(0, 40);
}

// "create a dashboard / chart / graph / visualisation of <…>" → Tableau, not SQL.
// Without this the request fell through to NL→SQL, and the model answered the only question it
// was asked ("what SQL does this?") with a flat "I cannot create a dashboard" — technically true
// of a SQL statement, but wrong about what Data Wizard can do.
const VIZ_RE = /\b(dash?boards?|darshboards?|charts?|graphs?|visuali[sz]\w*|visual|viz|plots?)\b/i;

async function handleQuestion(text, userId, channel, client) {
  if (await tryContextCommand(text, userId, channel, client)) return;

  const dg = text.match(DATAGEN_RE);
  if (dg) { await handleDataGen(dg[1].trim(), userId, channel, client); return; }

  if (VIZ_RE.test(text)) { await handleDashboard(text, userId, channel, client); return; }

  const ctx = ctxOf(userId);
  const plan = await planQuery(text, ctx);
  if (!plan.ok) { await post(client, channel, `:no_entry: ${plan.reason}`); return; }

  if (plan.needsConfirmation) {
    const id = `sql_${userId}_${Object.keys(Object.fromEntries(pendingSql)).length}`;
    pendingSql.set(id, { plan, context: { ...ctx } });
    const opts = {
      emoji: '⚠️', title: 'This will change your data',
      subtitle: `${ctx.catalog}.${ctx.schema}`,
      body: plan.explanation, subtext: `\`${plan.sql}\``,
      buttons: [
        { text: 'Run it', action_id: 'confirm_sql', value: id, style: 'danger' },
        { text: 'Cancel', action_id: 'cancel_sql', value: id },
      ],
    };
    await postRich(client, channel, 'This changes data — confirm?', [card(opts)], cardClassic(opts));
    return;
  }

  const out = await runPlanned(plan, ctx);

  // Gemma now writes the DDL, so follow it: after creating a schema/catalog, work inside it.
  const madeSchema = plan.sql.match(/\bcreate\s+schema\s+(?:if\s+not\s+exists\s+)?`?([A-Za-z0-9_]+)`?/i);
  const madeCatalog = plan.sql.match(/\bcreate\s+catalog\s+(?:if\s+not\s+exists\s+)?`?([A-Za-z0-9_]+)`?/i);
  if (madeCatalog) { ctx.catalog = madeCatalog[1]; ctx.schema = 'default'; }
  else if (madeSchema) { ctx.schema = madeSchema[1]; }
  if (madeSchema || madeCatalog) {
    await post(client, channel, `:sparkles: Now working in *${ctx.catalog}.${ctx.schema}*.`);
  }

  if (out.kind === 'read') {
    const cols = out.rows.length ? Object.keys(out.rows[0]) : [];
    const rich = [
      { type: 'section', text: { type: 'mrkdwn', text: plan.explanation || 'Result' } },
      ...(out.rows.length ? [dataTable(cols, out.rows, `${out.rows.length} row${out.rows.length === 1 ? '' : 's'} · ${ctx.catalog}.${ctx.schema}`)] : [{ type: 'section', text: { type: 'mrkdwn', text: '_no rows_' } }]),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `\`${plan.sql}\`  ·  _${ctx.catalog}.${ctx.schema}_${out.rows.length > 100 ? ` · showing 100 of ${out.rows.length}` : ''}` }] },
    ];
    const classic = [
      { type: 'section', text: { type: 'mrkdwn', text: plan.explanation || 'Result' } },
      ...tableClassic(cols, out.rows),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `\`${plan.sql}\`  ·  _${ctx.catalog}.${ctx.schema}_` }] },
    ];
    await postRich(client, channel, plan.explanation || 'Result', rich, classic);
  } else {
    await post(client, channel, `:white_check_mark: ${plan.explanation}\nAffected *${out.affectedRows}* rows.\n\`${plan.sql}\``);
  }
}

app.action('confirm_sql', async ({ ack, body, client }) => {
  await ack();
  const entry = pendingSql.get(body.actions[0].value);
  if (!entry) { await post(client, body.channel.id, 'That confirmation expired.'); return; }
  pendingSql.delete(body.actions[0].value);
  try {
    const out = await runPlanned(entry.plan, entry.context);
    await post(client, body.channel.id, `:white_check_mark: Done — ${out.affectedRows ?? 0} rows affected.\n\`${entry.plan.sql}\``);
  } catch (err) { await post(client, body.channel.id, `:x: ${err.message}`); }
});

// ─────────────────────────── data generation (real / synthetic) ───────────────────────────

const pendingGen = new Map(); // userId -> description (for the ambiguous "ask" case)

async function handleDataGen(description, userId, channel, client) {
  const which = detectSource(description);
  if (which === 'ask') {
    pendingGen.set(userId, description);
    const opts = {
      emoji: '✨', title: 'Where should this data come from?',
      body: `_"${description}"_`,
      buttons: [
        { text: '🌐 Real (web search)', action_id: 'gen_real', style: 'primary' },
        { text: '🎲 Synthetic (AI)', action_id: 'gen_synthetic' },
        { text: 'Cancel', action_id: 'cancel_upload' },
      ],
    };
    await postRich(client, channel, 'Choose a data source', [card(opts)], cardClassic(opts));
    return;
  }
  await generateAndPreview(description, which, userId, channel, client);
}

async function generateAndPreview(description, which, userId, channel, client) {
  await post(client, channel, which === 'real'
    ? `:globe_with_meridians: Searching the web with Perplexity for _"${description}"_…`
    : `:game_die: Generating synthetic data for _"${description}"_…`);
  try {
    const gen = which === 'real' ? await fromSearch(description) : await synthetic(description);
    const { columns, dataRows } = analyseCsv(gen.csv);
    const ctx = ctxOf(userId);
    const base = suggestTableName(description);
    pendingUpload.set(userId, { csvText: gen.csv, filename: `${base}.csv`, columns, dataRows });

    const src = which === 'real'
      ? `Real data via Perplexity · ${gen.citations.length} sources`
      : 'Synthetic data via OpenAI';
    const opts = {
      emoji: which === 'real' ? '🌐' : '🎲', title: base,
      subtitle: src,
      body: `${dataRows.length} rows · ${columns.length} columns → *${ctx.catalog}.${ctx.schema}*`,
      buttons: [
        { text: 'Load as table', action_id: 'load_simple', value: base, style: 'primary' },
        { text: 'Build medallion pipeline', action_id: 'load_medallion', value: base },
        { text: 'Cancel', action_id: 'cancel_upload' },
      ],
    };
    const previewTable = dataRows.length ? [dataTable(columns.map(c => c.name), dataRows.slice(0, 5), `Preview — first 5 of ${dataRows.length} rows`)] : [];
    await postRich(client, channel, `Generated ${base}`,
      [card(opts), ...previewTable],
      [...cardClassic(opts), ...tableClassic(columns.map(c => c.name), dataRows.slice(0, 5))]);

    if (which === 'real' && gen.citations.length) {
      await post(client, channel, 'Sources: ' + gen.citations.slice(0, 5).map((u, i) => `<${u}|[${i + 1}]>`).join(' '));
    }
  } catch (err) { await post(client, channel, `:x: ${err.message}`); }
}

app.action('gen_real', async ({ ack, body, client }) => {
  await ack();
  const d = pendingGen.get(body.user.id); pendingGen.delete(body.user.id);
  if (d) await generateAndPreview(d, 'real', body.user.id, body.channel.id, client);
});
app.action('gen_synthetic', async ({ ack, body, client }) => {
  await ack();
  const d = pendingGen.get(body.user.id); pendingGen.delete(body.user.id);
  if (d) await generateAndPreview(d, 'synthetic', body.user.id, body.channel.id, client);
});

app.action('cancel_sql', async ({ ack, body, client }) => {
  await ack();
  pendingSql.delete(body.actions[0].value);
  await post(client, body.channel.id, 'Cancelled. Nothing changed.');
});

// ─────────────────────────── CSV / scanned-PDF upload → table or pipeline ───────────────────────────

app.event('file_shared', async ({ event, client, logger }) => {
  try {
    const info = await client.files.info({ file: event.file_id });
    const file = info.file;
    const name = file.name || '';
    const isCsv = /\.csv$/i.test(name);
    const isPdf = /\.pdf$/i.test(name);
    if (!isCsv && !isPdf) return;

    const dl = await fetch(file.url_private_download, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });

    let csvText;
    if (isCsv) {
      csvText = await dl.text();
      if (csvText.trimStart().startsWith('<')) throw new Error('Slack returned HTML, not the file — check files:read scope');
    } else {
      // Scanned PDF: rasterize + Gemma vision. Slow (~15s/page), so tell the user first.
      const buf = Buffer.from(await dl.arrayBuffer());
      if (buf.subarray(0, 4).toString() !== '%PDF') throw new Error('That did not download as a PDF — check files:read scope');
      await post(client, event.channel_id, `:mag: Reading *${name}* with Gemma vision on the AMD GPU… (~15s per page)`);
      const r = await extractPdf(buf, {
        onProgress: async (p, n) => { if (n > 1) await post(client, event.channel_id, `   page ${p}/${n}…`); },
      });
      if (r.rows.length === 0) throw new Error('Gemma found no table in that scan.');
      csvText = r.csv;
      if (r.warnings.length) await post(client, event.channel_id, `:warning: ${r.warnings.join('; ')}`);
    }

    const { columns, dataRows } = analyseCsv(csvText);
    pendingUpload.set(event.user_id, { csvText, filename: name, columns, dataRows });
    const ctx = ctxOf(event.user_id);
    const base = suggestTableName(name);

    const preview = columns.slice(0, 8).map(c => c.name).join(', ');
    const opts = {
      emoji: isPdf ? '📄' : '🗂️', title: name,
      subtitle: isPdf ? 'table extracted from scan' : 'ready to load',
      body: `${dataRows.length} rows · ${columns.length} columns → *${ctx.catalog}.${ctx.schema}*`,
      subtext: `Columns: ${preview}`,
      buttons: [
        { text: 'Load as table', action_id: 'load_simple', value: base, style: 'primary' },
        { text: 'Build medallion pipeline', action_id: 'load_medallion', value: base },
        { text: 'Cancel', action_id: 'cancel_upload' },
      ],
    };
    // Show the extracted rows as a real table too, so the user can eyeball a scan before loading.
    const previewTable = dataRows.length
      ? [dataTable(columns.map(c => c.name), dataRows.slice(0, 5), `Preview — first 5 of ${dataRows.length} rows`)]
      : [];
    await postRich(client, event.channel_id, `Read ${name}`,
      [card(opts), ...previewTable],
      [...cardClassic(opts), ...tableClassic(columns.map(c => c.name), dataRows.slice(0, 5))]);
  } catch (err) { logger.error(err); await post(client, event.channel_id, `:x: ${err.message}`); }
});

app.action('cancel_upload', async ({ ack, body, client }) => {
  await ack(); pendingUpload.delete(body.user.id);
  await post(client, body.channel.id, 'Upload cancelled.');
});

async function doLoad(userId, channel, client, base, medallion, mode = 'replace') {
  const pending = pendingUpload.get(userId);
  if (!pending) { await post(client, channel, 'That upload expired — send the CSV again.'); return; }
  const ctx = ctxOf(userId);
  try {
    await ensureSchema(ctx.catalog, ctx.schema);
    if (medallion) {
      // No dimension given → buildPipeline picks one that actually groups (not `full_name`).
      const r = await buildPipeline({
        catalog: ctx.catalog, schema: ctx.schema, table: base, mode,
        csvText: pending.csvText, sourceName: pending.filename,
        goldSpec: { aggregation: 'COUNT' },
      });
      pendingUpload.delete(userId);
      const opts = {
        emoji: '🧱', title: 'Medallion pipeline built',
        subtitle: `${ctx.catalog}.${ctx.schema} · ${mode === 'append' ? 'appended' : 'replaced'}`,
        body: `🥉 \`${r.bronze.bronze}\` — ${r.bronze.rowsInserted} raw + lineage\n` +
              `🥈 \`${r.silver.silver}\` — ${r.silver.rows} deduped & typed\n` +
              `🥇 \`${r.gold.gold}\` — aggregated by \`${r.gold.dimension}\``,
        buttons: [{ text: `Show ${base}_gold`, action_id: 'show_gold', value: `${r.gold.gold}`, style: 'primary' }],
      };
      await postRich(client, channel, `Pipeline built in ${ctx.catalog}.${ctx.schema}`, [card(opts)], cardClassic(opts));
    } else {
      const r = await loadFlatTable({
        catalog: ctx.catalog, schema: ctx.schema, table: base, csvText: pending.csvText, mode,
      });
      pendingUpload.delete(userId);
      // Say what actually happened — "appended 10" is only meaningful next to the new total.
      const what = mode === 'append'
        ? `Appended *${r.rowsInserted}* rows to \`${ctx.catalog}.${ctx.schema}.${base}\` — now *${r.totalRows}* rows.`
        : `Loaded *${r.rowsInserted}* rows into \`${ctx.catalog}.${ctx.schema}.${base}\`.`;
      await post(client, channel, `:white_check_mark: ${what} Ask me about it in plain English.`);
    }
  } catch (err) { await post(client, channel, `:x: ${err.message}`); }
}

// ─────────────────────────── Tableau dashboards ───────────────────────────

/**
 * "create a dashboard with hackathon_signups" → a real, published Tableau workbook.
 *
 * Gemma reads the table's schema and chooses the chart type, dimension and measure; viz-builder
 * generates the .twb, embeds a CSV snapshot of the table, publishes to Tableau, and renders a PNG.
 * We post the PNG in-channel with a link to the live workbook.
 */
async function handleDashboard(text, userId, channel, client) {
  const ctx = ctxOf(userId);
  const status = await post(client, channel, ':bar_chart: Reading the table and choosing a chart…');
  const edit = t => client.chat.update({ channel, ts: status.ts, text: t }).catch(() => {});

  try {
    const { describeToSpec, listTables: vizTables } = await import('../viz-builder/spec.js');
    const { buildAndDeploy, loadEnv } = await import('../viz-builder/deploy.js');
    const env = loadEnv();

    // Chart whatever table the user named; if they named none, let Gemma pick from all of them.
    const all = await vizTables(ctx.catalog, ctx.schema);
    const named = all.filter(t => new RegExp(`\\b${t}\\b`, 'i').test(text));
    const candidates = named.length ? named : all;
    if (!candidates.length) { await edit(`:no_entry: No tables in *${ctx.catalog}.${ctx.schema}* to chart.`); return; }

    const res = await describeToSpec(ctx.catalog, ctx.schema, candidates, text);
    if (!res.ok) { await edit(`:no_entry: ${res.reason}`); return; }
    const spec = res.spec;
    spec.sheetName = spec.title || 'Viz';

    await edit(`:bar_chart: Building a *${spec.chartType}* of \`${spec.measure || 'count'}\` by ` +
               `\`${spec.dimension || spec.geoField}\` from \`${spec.table}\` — publishing to Tableau…`);

    const r = await buildAndDeploy(spec, {
      workbookName: (spec.title || `${spec.table} ${spec.chartType}`).slice(0, 60),
      outDir: os.tmpdir(), catalog: ctx.catalog, schema: ctx.schema,
    });
    const url = `${env.SERVER}/#/site/${env.SITE_NAME}/workbooks/${r.workbookId}`;

    await edit(`:white_check_mark: *${spec.title || spec.table}* — ${r.rows} rows from \`${spec.table}\``);
    try {
      await client.files.uploadV2({
        channel_id: channel, file: r.png, filename: `${spec.table}.png`,
        title: spec.title || spec.table,
        initial_comment: `📊 *${spec.title || spec.table}* · <${url}|Open in Tableau>`,
      });
    } catch (e) {
      // files:write was added to the manifest — if the app hasn't been reinstalled yet, the
      // upload 403s. Still give them the workbook rather than failing the whole request.
      await post(client, channel,
        `📊 *${spec.title || spec.table}* — <${url}|Open in Tableau>\n` +
        `_(Couldn't attach the image: ${e.data?.error || e.message}. Reinstall the app to grant \`files:write\`.)_`);
    }
  } catch (err) {
    await edit(`:x: Dashboard failed: ${err.message}`);
  }
}

// ─────────────────────────── the "where does this data go?" modal ───────────────────────────

const plain = t => ({ type: 'plain_text', text: t });
const opt = (text, value, description) => ({
  text: plain(text), value, ...(description ? { description: plain(description) } : {}),
});

/**
 * The destination modal. Two decisions the user must make explicitly, never guessed:
 *   1. NEW table (what do I call it?) or EXISTING table (which one?)
 *   2. If existing: Append the rows, or Replace everything that's in there.
 *
 * We never name a table after the file. Real CSVs carry prefixes, dates and version suffixes
 * ("2026_q3_export_signups_v2.csv") that nobody wants to type in a question — so the name field
 * is pre-filled with a cleaned SUGGESTION and clearly labelled as one, to accept or overwrite.
 */
function destinationView({ ctx, suggested, medallion, dest, tables, channel, rowCount }) {
  const noun = medallion ? 'pipeline' : 'table';
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn',
      text: `*${rowCount} rows* → *${ctx.catalog}.${ctx.schema}*\nWhere should this data go?` } },
    { type: 'input', block_id: 'dest', dispatch_action: true,
      label: plain('Destination'),
      element: { type: 'radio_buttons', action_id: 'v',
        initial_option: dest === 'existing'
          ? opt('An existing table', 'existing', `Add to or replace one of your ${tables.length} tables`)
          : opt('A new table', 'new', `Creates a new ${noun} you name below`),
        options: [
          opt('A new table', 'new', `Creates a new ${noun} you name below`),
          opt('An existing table', 'existing',
            tables.length ? `Add to or replace one of your ${tables.length} tables` : 'No tables here yet'),
        ] } },
    { type: 'divider' },
  ];

  if (dest === 'existing') {
    if (!tables.length) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn',
        text: `_There are no tables in *${ctx.catalog}.${ctx.schema}* yet — pick *A new table* above._` } });
      return baseView({ blocks, medallion, channel, suggested, dest, submit: false });
    }
    blocks.push(
      { type: 'input', block_id: 'existing',
        label: plain('Which table?'),
        element: { type: 'static_select', action_id: 'v',
          placeholder: plain('Choose a table'),
          options: tables.slice(0, 100).map(t => opt(t, t)) } },
      { type: 'input', block_id: 'mode',
        label: plain('How should I write the rows?'),
        element: { type: 'radio_buttons', action_id: 'v',
          initial_option: opt('Append', 'append', 'Keep what\'s there and add these rows'),
          options: [
            opt('Append', 'append', 'Keep what\'s there and add these rows'),
            opt('Replace', 'replace', 'Delete every existing row, then load these'),
          ] } },
    );
  } else {
    blocks.push({ type: 'input', block_id: 'tbl',
      label: plain('Name your new table'),
      hint: plain(medallion
        ? `I suggest "${suggested}" (from your file). It becomes ${suggested}_bronze, _silver and _gold — accept it or type your own.`
        : `I suggest "${suggested}" (from your file) — accept it, or type the name you'd rather use when asking me questions.`),
      element: { type: 'plain_text_input', action_id: 'v', initial_value: suggested,
        placeholder: plain('e.g. signups') } });
  }
  return baseView({ blocks, medallion, channel, suggested, dest, submit: true });
}

function baseView({ blocks, medallion, channel, suggested, dest, submit }) {
  return {
    type: 'modal',
    callback_id: 'submit_destination',
    private_metadata: JSON.stringify({ channel, medallion, suggested, dest }),
    title: plain(medallion ? 'Build pipeline' : 'Load data'),
    ...(submit ? { submit: plain(medallion ? 'Build' : 'Load') } : {}),
    close: plain('Cancel'),
    blocks,
  };
}

/** Opens the modal. Table list is fetched live so "existing" always reflects reality. */
async function askDestination(client, body, medallion) {
  const ctx = ctxOf(body.user.id);
  const pending = pendingUpload.get(body.user.id);
  const tables = await listTables(ctx.catalog, ctx.schema).catch(() => []);
  await client.views.open({
    trigger_id: body.trigger_id,
    view: destinationView({
      ctx, suggested: body.actions[0].value, medallion, dest: 'new',
      tables, channel: body.channel.id, rowCount: pending?.dataRows?.length ?? 0,
    }),
  });
}

app.action('load_simple', async ({ ack, body, client }) => { await ack(); await askDestination(client, body, false); });
app.action('load_medallion', async ({ ack, body, client }) => { await ack(); await askDestination(client, body, true); });

// The Destination radio swaps the rest of the form (name field ⇄ table picker + write mode).
app.action({ block_id: 'dest', action_id: 'v' }, async ({ ack, body, client }) => {
  await ack();
  const ctx = ctxOf(body.user.id);
  const meta = JSON.parse(body.view.private_metadata);
  const dest = body.actions[0].selected_option.value;
  const tables = await listTables(ctx.catalog, ctx.schema).catch(() => []);
  await client.views.update({
    view_id: body.view.id, hash: body.view.hash,
    view: destinationView({
      ctx, suggested: meta.suggested, medallion: meta.medallion, dest,
      tables, channel: meta.channel,
      rowCount: pendingUpload.get(body.user.id)?.dataRows?.length ?? 0,
    }),
  });
});

app.view('submit_destination', async ({ ack, body, view, client }) => {
  const { channel, medallion } = JSON.parse(view.private_metadata);
  const v = view.state.values;
  const dest = v.dest.v.selected_option.value;

  let table, mode;
  if (dest === 'existing') {
    table = v.existing.v.selected_option.value;
    mode = v.mode.v.selected_option.value;   // append | replace
  } else {
    const raw = (v.tbl.v.value || '').trim();
    table = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
    if (!table || /^\d/.test(table)) {
      // Reject inside the modal so the user can fix it without losing the upload.
      await ack({ response_action: 'errors',
        errors: { tbl: 'Use letters, numbers and underscores, and don\'t start with a number.' } });
      return;
    }
    mode = 'replace';   // a brand-new table: nothing to append to.
  }
  await ack();
  await doLoad(body.user.id, channel, client, table, medallion, mode);
});

app.action('show_gold', async ({ ack, body, client }) => {
  await ack();
  const ctx = ctxOf(body.user.id);
  const table = body.actions[0].value;
  try {
    const { rowObjects } = await runSql(`SELECT * FROM ${ctx.catalog}.${ctx.schema}.\`${table}\` LIMIT 100`);
    const cols = rowObjects.length ? Object.keys(rowObjects[0]) : [];
    await postRich(client, body.channel.id, `${table}`,
      [{ type: 'section', text: { type: 'mrkdwn', text: `*${table}*` } }, dataTable(cols, rowObjects, `${table} · ${rowObjects.length} rows`)],
      [{ type: 'section', text: { type: 'mrkdwn', text: `*${table}*` } }, ...tableClassic(cols, rowObjects)]);
  } catch (err) { await post(client, body.channel.id, `:x: ${err.message}`); }
});

// ─────────────────────────── entry points ───────────────────────────

app.event('app_mention', async ({ event, client, logger }) => {
  try {
    const text = event.text.replace(/<@[^>]+>\s*/, '').trim();
    if (text) await handleQuestion(text, event.user, event.channel, client);
  } catch (err) { logger.error(err); await post(client, event.channel, `:x: ${err.message}`); }
});

app.message(async ({ message, client, logger }) => {
  if (message.channel_type !== 'im' || message.subtype) return;
  // @mentioning the bot inside a DM fires BOTH app_mention and message → duplicate replies.
  // app_mention already handles mentions, so skip them here.
  if (/<@[A-Z0-9]+>/i.test(message.text || '')) return;
  try {
    if (message.text?.trim()) await handleQuestion(message.text.trim(), message.user, message.channel, client);
  } catch (err) { logger.error(err); await post(client, message.channel, `:x: ${err.message}`); }
});

await app.start(Number(process.env.PORT || 3001));
console.log(`⚡ Data Wizard (Databricks) running. Default namespace: ${DEFAULT_CATALOG}.${DEFAULT_SCHEMA}`);
