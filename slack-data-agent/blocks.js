/**
 * Block Kit builders for a richer agent UX, each paired with a classic-block fallback.
 *
 * The new agent blocks (card, data_table) are GA but their message-surface support isn't
 * formally documented, so postRich() tries the rich blocks and, if Slack rejects them,
 * re-posts the classic version. The UX upgrades where supported and never breaks where it isn't.
 */

const txt = (s, type = 'mrkdwn') => ({ type, text: String(s) });
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ── Card ─────────────────────────────────────────────────────────

/**
 * @param {object} o { emoji, title, body, subtext, buttons:[{text,action_id,value,style}] }
 * Card body is capped at 200 chars; longer content should go in an attached data_table.
 */
export function card(o) {
  const block = { type: 'card' };
  if (o.emoji) block.title = txt(`${o.emoji} ${o.title || ''}`.trim());
  else if (o.title) block.title = txt(o.title);
  if (o.subtitle) block.subtitle = txt(clip(o.subtitle, 150));
  if (o.body) block.body = txt(clip(o.body, 200));
  if (o.subtext) block.subtext = txt(clip(o.subtext, 200));
  if (o.buttons?.length) {
    block.actions = o.buttons.slice(0, 3).map(b => ({
      type: 'button',
      text: { type: 'plain_text', text: b.text },
      action_id: b.action_id,
      ...(b.value != null ? { value: String(b.value) } : {}),
      ...(b.style ? { style: b.style } : {}),
    }));
  }
  return block;
}

/** Classic equivalent: a section + a separate actions block. */
export function cardClassic(o) {
  const lines = [];
  if (o.title) lines.push(`*${o.emoji ? o.emoji + ' ' : ''}${o.title}*`);
  if (o.subtitle) lines.push(`_${o.subtitle}_`);
  if (o.body) lines.push(o.body);
  if (o.subtext) lines.push(o.subtext);
  const blocks = [{ type: 'section', text: txt(lines.join('\n')) }];
  if (o.buttons?.length) {
    blocks.push({ type: 'actions', elements: o.buttons.slice(0, 5).map(b => ({
      type: 'button', text: { type: 'plain_text', text: b.text },
      action_id: b.action_id, ...(b.value != null ? { value: String(b.value) } : {}), ...(b.style ? { style: b.style } : {}),
    })) });
  }
  return blocks;
}

// ── Data Table ───────────────────────────────────────────────────

/** Cell: numbers render right-aligned as raw_number, everything else as raw_text. */
function cell(v) {
  if (v == null || v === '') return { type: 'raw_text', text: '—' };
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) return { type: 'raw_number', value: Number(s), text: s };
  return { type: 'raw_text', text: clip(s, 120) };
}

/**
 * @param {string[]} columns
 * @param {Array<object|Array>} rows  row objects (keyed by column) or arrays
 * @param {string} caption  REQUIRED by Slack — omitting it fails with `invalid_blocks:
 *                          missing required field: caption`, which silently drops us to the
 *                          monospace fallback.
 * Slack limits: ≤100 data rows, ≤20 columns, ≤10k chars. We cap and report the rest.
 */
export function dataTable(columns, rows, caption = 'Results') {
  const cols = columns.slice(0, 20);
  const capped = rows.slice(0, 100);
  const headerRow = cols.map(c => ({ type: 'raw_text', text: clip(String(c), 60) }));
  const dataRows = capped.map(r => cols.map((c, i) =>
    cell(Array.isArray(r) ? r[i] : r[c])));
  return {
    type: 'data_table',
    caption: clip(String(caption || 'Results'), 75),
    rows: [headerRow, ...dataRows],
  };
}

/** Classic equivalent: a monospace fixed-width table in a section. */
export function tableClassic(columns, rows, max = 15) {
  if (!rows.length) return [{ type: 'section', text: txt('_no rows_') }];
  const get = (r, c, i) => String((Array.isArray(r) ? r[i] : r[c]) ?? '—');
  const shown = rows.slice(0, max);
  const w = {};
  columns.forEach((c, i) => { w[c] = Math.min(Math.max(c.length, ...shown.map(r => get(r, c, i).length)), 28); });
  const line = cells => cells.join('  ');
  const head = line(columns.map(c => clip(c, w[c]).padEnd(w[c])));
  const rule = line(columns.map(c => '─'.repeat(w[c])));
  const body = shown.map(r => line(columns.map((c, i) => clip(get(r, c, i), w[c]).padEnd(w[c]))));
  const more = rows.length > max ? `\n… ${rows.length - max} more rows` : '';
  return [{ type: 'section', text: txt('```\n' + [head, rule, ...body].join('\n') + more + '\n```') }];
}

// ── resilient poster ─────────────────────────────────────────────

/**
 * Posts rich blocks; if Slack rejects them (unsupported block on this surface), re-posts
 * the classic fallback so the message always lands.
 * @param richBlocks  array of new-style blocks (card/data_table/…)
 * @param classicBlocks  array of classic blocks (section/actions/…)
 */
export async function postRich(client, channel, text, richBlocks, classicBlocks) {
  try {
    return await client.chat.postMessage({ channel, text, blocks: richBlocks });
  } catch (err) {
    const code = err?.data?.error || err.message || '';
    if (/invalid_blocks|invalid_arguments|unsupported/i.test(code)) {
      return client.chat.postMessage({ channel, text, blocks: classicBlocks });
    }
    throw err;
  }
}
