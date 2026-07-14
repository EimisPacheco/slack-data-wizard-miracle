/**
 * Emails a Data Wizard answer (query table or dashboard chart) via Resend.
 *
 * Optional feature: if RESEND_API_KEY is absent, emailConfigured() is false and the caller tells
 * the user it isn't set up — nothing else breaks.
 *
 * Resend note: with an unverified domain you can only send FROM onboarding@resend.dev and TO your
 * own Resend account email. sendEmail() surfaces that 403 as a friendly message rather than a stack.
 */
import { Resend } from 'resend';

export const emailConfigured = () => !!process.env.RESEND_API_KEY;

const FROM = () => process.env.RESEND_FROM || 'Data Wizard <onboarding@resend.dev>';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const isNumeric = v => /^-?\d[\d,]*(\.\d+)?%?$/.test(String(v ?? '').trim());

/**
 * An inline-styled HTML table from a column list + row objects.
 * @param {Array<{name:string}>|string[]} cols
 * @param {Array<object|Array>} rows  keyed by column name, or arrays (same access as blocks.js)
 */
export function tableHtml(cols, rows) {
  const names = (cols || []).map(c => (typeof c === 'string' ? c : c.name));
  if (!names.length) return '<p style="color:#6b7280">No columns.</p>';
  const th = names.map(n =>
    `<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e3e6ea;font:600 13px system-ui;color:#1f2d3d">${esc(n)}</th>`).join('');
  const body = (rows || []).slice(0, 200).map((r, i) => {
    const bg = i % 2 ? '#fbfbf7' : '#ffffff';
    const tds = names.map((n, idx) => {
      const v = Array.isArray(r) ? r[idx] : r[n];
      const align = isNumeric(v) ? 'right' : 'left';
      return `<td style="text-align:${align};padding:8px 12px;border-bottom:1px solid #eef0f2;font:13px system-ui;color:#223">${esc(v ?? '—')}</td>`;
    }).join('');
    return `<tr style="background:${bg}">${tds}</tr>`;
  }).join('');
  const more = (rows || []).length > 200 ? `<p style="color:#6b7280;font:12px system-ui">Showing 200 of ${rows.length} rows.</p>` : '';
  return `<table style="border-collapse:collapse;width:100%;max-width:720px;border:1px solid #e3e6ea;border-radius:8px;overflow:hidden">`
    + `<thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>${more}`;
}

/** Wraps content in a simple branded shell. */
export function emailShell({ heading, note, bodyHtml, footer }) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2d3d;max-width:760px;margin:0 auto;padding:24px">
    <div style="font:700 18px system-ui;color:#2e7d32">🪄 Data Wizard</div>
    ${heading ? `<h2 style="font:650 20px system-ui;margin:14px 0 4px">${esc(heading)}</h2>` : ''}
    ${note ? `<p style="color:#374151;font:15px system-ui;white-space:pre-wrap">${esc(note)}</p>` : ''}
    <div style="margin:16px 0">${bodyHtml}</div>
    ${footer ? `<div style="margin-top:18px;padding-top:12px;border-top:1px solid #e3e6ea;color:#6b7280;font:12px ui-monospace,monospace">${footer}</div>` : ''}
    <div style="margin-top:16px;color:#9ca3af;font:11px system-ui">Sent from Data Wizard in Slack.</div>
  </div>`;
}

/** Sends via Resend. Throws Error with a clean message on failure. */
export async function sendEmail({ to, subject, html, attachments }) {
  if (!emailConfigured()) throw new Error('Email isn\'t set up — add RESEND_API_KEY to .env.');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: FROM(), to: [to], subject, html,
    ...(attachments?.length ? { attachments } : {}),
  });
  if (error) {
    const msg = error.message || JSON.stringify(error);
    // Unverified-domain restriction — the single most likely failure with a fresh key.
    if (/only send testing emails to your own|verify a domain|not allowed to send/i.test(msg)) {
      throw new Error(`Resend only lets you email your own account address until you verify a domain. (${msg})`);
    }
    throw new Error(`Resend: ${msg}`);
  }
  return { ok: true, id: data?.id };
}
