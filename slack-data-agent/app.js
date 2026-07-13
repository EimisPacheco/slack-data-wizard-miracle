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
const { fromSearch, synthetic } = await import('../datagen/datagen.js');

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

*Ask anything — the AI writes the SQL*
• _"what catalogs are there?"_  _"list the tables"_  _"what columns does signups_silver have?"_
• _"create a schema called sales"_  _"create a table of…"_

*Load data*
• Drop a *.csv* — or a *scanned .pdf* (OpenAI vision reads the table from the image) — then pick
  *Load table* or *Build pipeline* (bronze/silver/gold).

*Ask anything in plain English*
• _"how many signups per country?"_  _"top 3 by score"_  _"show the gold table"_

*Generate a table*
• _"create a table of the top 10 countries by population"_ — *real*, cited figures from the web
• _"generate 20 fake employees"_ — *synthetic* rows

*Dashboards*
• _"create a dashboard with hackathon_signups"_ — the AI picks the chart and publishes a *real Tableau workbook*; the chart posts back into the channel.

*Voice*
• Record a *voice clip* (🎤 in the message box) — I transcribe it, answer with the table, and reply with a spoken clip.
• Or talk live to the ElevenLabs *Data Wizard Voice* agent — answers and full transcripts post back into Slack.

*Change data (always confirmed first)*
• _"drop the bronze table"_, _"delete inactive users"_ — I show the SQL and wait for your click.`;

// ─────────────────────────── AI intent router ───────────────────────────
// No keyword rules and no regex: OpenAI reads every message and decides what the user
// wants. Phrasing, word order and even language don't matter — "where am I",
// "where I am?" and "¿dónde estoy?" all resolve to the same intent.

const ROUTER_SYSTEM = `You are the intent router for Data Wizard, a Slack data assistant.
Classify the user's message. Reply with JSON only:
{"intent":"<one from the list>","name":"<identifier>","description":"<text>","source":"real|synthetic|ask"}

Intents:
- "help"           — asks what the assistant can do, its commands or capabilities.
- "context"        — asks where they are working / their current catalog or schema, in any phrasing ("where am I", "where I am?", "context", "whoami").
- "use_catalog"    — wants to switch to / work in a catalog. Put the bare catalog name in "name".
- "use_schema"     — wants to switch to / work in a schema or database. Put the bare schema name in "name".
- "generate_data"  — wants NEW data created or fetched: a table of real-world facts, or fake/synthetic/sample/test rows. Put what they want in "description". Set "source" to "real" for true web-sourced figures, "synthetic" for fake/test rows, "ask" if unclear.
- "dashboard"      — wants a chart/dashboard/visualization built from existing tables, described in words.
- "draw_dashboard" — wants to DRAW or SKETCH the dashboard/chart themselves (whiteboard, drawing).
- "draw_table"     — wants to DRAW a table by hand on the whiteboard.
- "query"          — everything else: questions about data, listing or inspecting catalogs/schemas/tables/columns, creating objects via DDL, changing or deleting data.

Only include "name", "description" or "source" when they apply. When in doubt, use "query".`;

async function routeIntent(text) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
      input: [{ role: 'system', content: ROUTER_SYSTEM }, { role: 'user', content: text }],
    }),
  });
  if (!r.ok) throw new Error(`router ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const p = await r.json();
  const msg = (p.output || []).find(o => o.type === 'message');
  let t = ((msg?.content || []).find(c => c.type === 'output_text')?.text || '').replace(/```(json)?/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

// SQL identifiers are word characters only — mechanical cleanup, not language understanding.
const cleanIdent = s => String(s || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64);

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

// "draw / sketch a dashboard" → the whiteboard web app (Slack can't host a canvas natively).
// The AI router decides table vs dashboard mode; this just posts the link.
const WHITEBOARD_URL = (process.env.WHITEBOARD_URL || 'http://localhost:3200').replace(/\/$/, '');

async function handleWhiteboardLink(mode, channel, client) {
  const url = `${WHITEBOARD_URL}/?mode=${mode}&channel=${channel}`;
  const body = mode === 'dashboard'
    ? ':art: *Draw your dashboard* — sketch the chart you want (bars, a line…), write the table name on the board, then click *Build dashboard*. I publish it to Tableau and post the chart back here.'
    : ':art: *Draw your table* — a header row and a few data rows, then click *Extract to table*. It lands in your lakehouse and you can ask me about it.';
  await post(client, channel, body, [
    { type: 'section', text: { type: 'mrkdwn', text: body } },
    { type: 'actions', elements: [{
      type: 'button', style: 'primary', action_id: 'open_whiteboard', url,
      text: { type: 'plain_text', text: '🎨 Open the whiteboard' },
    }] },
  ]);
  return { spoken: mode === 'dashboard'
    ? 'I posted a whiteboard link. Sketch your dashboard there and the finished chart will come back to this channel.'
    : 'I posted a whiteboard link. Draw your table there and it will load into your lakehouse.' };
}

async function handleQuestion(text, userId, channel, client) {
  const ctx = ctxOf(userId);

  // One model call decides what the user wants. If the router itself fails, fall through
  // to the query path — which is also the model.
  let route;
  try { route = (await routeIntent(text)) || {}; } catch { route = { intent: 'query' }; }

  switch (route.intent) {
    case 'help':
      await post(client, channel, HELP_TEXT);
      return { spoken: 'I posted the full list of what I can do.' };

    case 'context':
      await post(client, channel, `You're in *${ctx.catalog}.${ctx.schema}*.`);
      return { spoken: `You're working in ${ctx.catalog}, schema ${ctx.schema}.` };

    case 'use_catalog': {
      const name = cleanIdent(route.name);
      if (!name) break;
      ctx.catalog = name; ctx.schema = 'default';
      await post(client, channel, `Switched to catalog *${ctx.catalog}* (schema reset to \`default\`).`);
      return { spoken: `Switched to catalog ${name}.` };
    }

    case 'use_schema': {
      const name = cleanIdent(route.name);
      if (!name) break;
      ctx.schema = name;
      await post(client, channel, `Now using *${ctx.catalog}.${ctx.schema}*.`);
      return { spoken: `Now using schema ${name}.` };
    }

    case 'generate_data':
      await handleDataGen(route.description?.trim() || text, route.source, userId, channel, client);
      return { spoken: 'Working on your table — a preview will post here shortly.' };

    case 'draw_dashboard': return handleWhiteboardLink('dashboard', channel, client);
    case 'draw_table': return handleWhiteboardLink('table', channel, client);

    case 'dashboard':
      return handleDashboard(text, userId, channel, client);
  }

  const plan = await planQuery(text, ctx);
  if (!plan.ok) { await post(client, channel, `:no_entry: ${plan.reason}`); return { spoken: `I couldn't answer that. ${plan.reason}` }; }

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
    return { spoken: 'That would change your data, so I will not run it from a voice note. The SQL is posted — confirm it with a click.' };
  }

  const out = await runPlanned(plan, ctx);

  // The model now writes the DDL, so follow it: after creating a schema/catalog, work inside it.
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
    return { spoken: speakable(plan, out) };
  } else {
    await post(client, channel, `:white_check_mark: ${plan.explanation}\nAffected *${out.affectedRows}* rows.\n\`${plan.sql}\``);
    return { spoken: `Done. ${plan.explanation}` };
  }
}

// Short spoken summary of a query result — same shape the voice agent uses.
function speakable(plan, out) {
  if (plan.kind !== 'read') return `Done. ${plan.explanation}`;
  if (!out.rows.length) return `${plan.explanation} No rows matched.`;
  const cols = Object.keys(out.rows[0]);
  if (out.rows.length === 1 && cols.length === 1) return `${plan.explanation} The answer is ${out.rows[0][cols[0]]}.`;
  const top = out.rows.slice(0, 3).map(r => cols.map(c => `${c} ${r[c]}`).join(', ')).join('; ');
  return `${plan.explanation} Top results: ${top}.` + (out.rows.length > 3 ? ` And ${out.rows.length - 3} more.` : '');
}

// URL buttons still emit an action event; ack it or Slack shows a warning icon on the button.
app.action('open_whiteboard', async ({ ack }) => { await ack(); });

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

async function handleDataGen(description, source, userId, channel, client) {
  // The AI router already judged the source; anything unclear falls back to asking the user.
  const which = source === 'real' || source === 'synthetic' ? source : 'ask';
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
        { text: 'Load table', action_id: 'load_simple', value: base, style: 'primary' },
        { text: 'Build pipeline', action_id: 'load_medallion', value: base },
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

// ─────────────────────────── voice clips → transcribe → answer → speak back ───────────────────────────

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

async function transcribeClip(file, client) {
  // Slack transcribes clips itself (free) but takes a few seconds — poll briefly.
  for (let i = 0; i < 8; i++) {
    const t = file.transcription;
    if (t?.status === 'complete' && t.preview?.content) return t.preview.content.replace(/\.{3}$/, '').trim();
    if (t?.status && t.status !== 'processing') break;
    await new Promise(r => setTimeout(r, 1500));
    file = (await client.files.info({ file: file.id })).file;
  }
  // Fallback: ElevenLabs Scribe speech-to-text.
  if (!process.env.ELEVENLABS_API_KEY) return null;
  const dl = await fetch(file.url_private_download, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
  const form = new FormData();
  form.append('model_id', 'scribe_v1');
  form.append('file', new Blob([await dl.arrayBuffer()], { type: file.mimetype || 'audio/mp4' }), file.name || 'clip.m4a');
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, body: form,
  });
  if (!r.ok) throw new Error(`ElevenLabs transcription failed: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).text?.trim() || null;
}

// ElevenLabs TTS → mp3 → uploaded back as a playable clip. A quota problem must never
// block the text answer that already posted, so failures here only log.
async function speakToChannel(text, channel, client, logger) {
  try {
    if (!process.env.ELEVENLABS_API_KEY || !text) return;
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 160));
    const mp3 = Buffer.from(await r.arrayBuffer());
    await client.files.uploadV2({
      channel_id: channel, file: mp3,
      filename: 'data-wizard-answer.mp3', title: '🪄 Data Wizard — spoken answer',
    });
  } catch (err) { logger?.warn?.(`voice reply skipped: ${err.message}`); }
}

async function handleVoiceClip(file, event, client, logger) {
  await post(client, event.channel_id, ':headphones: Got your voice note — transcribing…');
  const said = await transcribeClip(file, client);
  if (!said) { await post(client, event.channel_id, ":x: I couldn't transcribe that clip — try again, or type the question."); return; }
  await post(client, event.channel_id, `:studio_microphone: *You said:* "${said}"`);
  const result = await handleQuestion(said, event.user_id, event.channel_id, client);
  await speakToChannel(result?.spoken, event.channel_id, client, logger);
}

// ─────────────────────────── CSV / scanned-PDF upload → table or pipeline ───────────────────────────

app.event('file_shared', async ({ event, client, logger, context }) => {
  try {
    // Our own uploads (spoken answers, chart PNGs) fire file_shared too — never re-process them.
    if (event.user_id && event.user_id === context.botUserId) return;
    const info = await client.files.info({ file: event.file_id });
    const file = info.file;
    const name = file.name || '';
    const isCsv = /\.csv$/i.test(name);
    const isPdf = /\.pdf$/i.test(name);
    const isAudio = file.subtype === 'slack_audio' || /^audio\//.test(file.mimetype || '') || /\.(m4a|mp3|wav|ogg)$/i.test(name);
    if (isAudio) { await handleVoiceClip(file, event, client, logger); return; }
    if (!isCsv && !isPdf) return;

    const dl = await fetch(file.url_private_download, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });

    let csvText;
    if (isCsv) {
      csvText = await dl.text();
      if (csvText.trimStart().startsWith('<')) throw new Error('Slack returned HTML, not the file — check files:read scope');
    } else {
      // Scanned PDF: rasterize + OpenAI vision. Slow (~15s/page), so tell the user first.
      const buf = Buffer.from(await dl.arrayBuffer());
      if (buf.subarray(0, 4).toString() !== '%PDF') throw new Error('That did not download as a PDF — check files:read scope');
      await post(client, event.channel_id, `:mag: Reading *${name}* with OpenAI vision… (~15s per page)`);
      const r = await extractPdf(buf, {
        onProgress: async (p, n) => { if (n > 1) await post(client, event.channel_id, `   page ${p}/${n}…`); },
      });
      if (r.rows.length === 0) throw new Error('No table found in that scan.');
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
        { text: 'Load table', action_id: 'load_simple', value: base, style: 'primary' },
        { text: 'Build pipeline', action_id: 'load_medallion', value: base },
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
 * OpenAI reads the table's schema and chooses the chart type, dimension and measure; viz-builder
 * generates the .twb, embeds a CSV snapshot of the table, publishes to Tableau, and renders a PNG.
 * We post the PNG in-channel with a link to the live workbook.
 */
// Which of the existing tables does the message actually refer to? The model reads the
// message (typos, plurals, "the signups table" all work) — no name-matching rules.
async function tablesMentioned(text, all) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
      input: [{ role: 'user', content:
        `Existing tables: ${all.join(', ')}\n\nMessage: ${text}\n\n` +
        `Which of the existing tables does the message explicitly mention or unambiguously refer to? ` +
        `Reply JSON only: {"tables": ["..."]}. Use an empty list if it names none of them.` }],
    }),
  });
  if (!r.ok) throw new Error(`table detection ${r.status}`);
  const p = await r.json();
  const msg = (p.output || []).find(o => o.type === 'message');
  let t = ((msg?.content || []).find(c => c.type === 'output_text')?.text || '').replace(/```(json)?/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) t = t.slice(a, b + 1);
  const valid = new Set(all);
  return (JSON.parse(t).tables || []).filter(x => valid.has(x));
}

const pendingDash = new Map(); // userId -> original dashboard request, while we ask for the table

async function handleDashboard(text, userId, channel, client) {
  const ctx = ctxOf(userId);
  const { listTables: vizTables } = await import('../viz-builder/spec.js');
  const all = await vizTables(ctx.catalog, ctx.schema).catch(() => []);
  if (!all.length) {
    await post(client, channel, `:no_entry: No tables in *${ctx.catalog}.${ctx.schema}* to chart.`);
    return { spoken: `There are no tables in ${ctx.catalog}.${ctx.schema} to chart yet.` };
  }

  // The chart design is the model's judgment — but the TABLE is the user's call.
  // If the request doesn't anchor one, ask before building anything.
  let named = [];
  try { named = await tablesMentioned(text, all); } catch { /* fall through to asking */ }
  if (!named.length) {
    pendingDash.set(userId, text);
    await post(client, channel, 'Which table should this dashboard use?', [
      { type: 'section', text: { type: 'mrkdwn', text: ':bar_chart: *Which table should this dashboard use?* Pick one and I\'ll design the best chart for it.' } },
      { type: 'actions', elements: [{
        type: 'static_select', action_id: 'dash_pick_table',
        placeholder: { type: 'plain_text', text: 'Choose a table' },
        options: all.slice(0, 100).map(t => ({ text: { type: 'plain_text', text: t }, value: t })),
      }] },
    ]);
    return { spoken: 'Which table should the dashboard use? I posted the list — pick one and I will design the chart.' };
  }

  await buildDashboard(text, named, userId, channel, client);
  return { spoken: 'Publishing your dashboard — the chart will appear here in a moment.' };
}

app.action('dash_pick_table', async ({ ack, body, client }) => {
  await ack();
  const table = body.actions[0].selected_option.value;
  const text = pendingDash.get(body.user.id) || `create a dashboard with ${table}`;
  pendingDash.delete(body.user.id);
  await buildDashboard(`${text} — use the table ${table}`, [table], body.user.id, body.channel.id, client);
});

async function buildDashboard(text, candidates, userId, channel, client) {
  const ctx = ctxOf(userId);
  const status = await post(client, channel, ':bar_chart: Reading the table and choosing a chart…');
  const edit = t => client.chat.update({ channel, ts: status.ts, text: t }).catch(() => {});

  try {
    const { describeToSpec } = await import('../viz-builder/spec.js');
    const { buildAndDeploy, loadEnv } = await import('../viz-builder/deploy.js');
    const env = loadEnv();

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
  // A trigger_id dies 3 seconds after the click, but listTables can take far longer on a
  // cold Databricks warehouse (expired_trigger_id, modal never opens). Open a placeholder
  // within the window, then swap in the real form when the table list arrives.
  const opened = await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      title: plain(medallion ? 'Build pipeline' : 'Load data'),
      close: plain('Cancel'),
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: ':hourglass_flowing_sand: Waking the warehouse and listing your tables…' } }],
    },
  });
  const tables = await listTables(ctx.catalog, ctx.schema).catch(() => []);
  await client.views.update({
    view_id: opened.view.id,
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
