/**
 * Email helpers: read a Gmail API message into plain fields, strip quoted history and
 * signatures, and build an RFC 2822 reply that Gmail threads correctly.
 */

export const b64urlDecode = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
export const b64urlEncode = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Walk the MIME tree and return { text, html, attachments }. */
export function extractBody(payload) {
  const out = { text: '', html: '', attachments: [] };
  const walk = (part) => {
    if (!part) return;
    const type = (part.mimeType || '').toLowerCase();
    if (part.filename) {
      out.attachments.push({ filename: part.filename, mimeType: type, size: part.body?.size || 0 });
    } else if (type === 'text/plain' && part.body?.data && !out.text) {
      out.text = b64urlDecode(part.body.data);
    } else if (type === 'text/html' && part.body?.data && !out.html) {
      out.html = b64urlDecode(part.body.data);
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return out;
}

/** "Jane Doe <jane@x.com>" -> { name: 'Jane Doe', email: 'jane@x.com' } */
export function parseAddress(value) {
  const s = String(value || '').trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  const e = s.match(/[^\s<>",;]+@[^\s<>",;]+/);
  return { name: '', email: e ? e[0].toLowerCase() : '' };
}

const QUOTE_MARKERS = [
  /^On .{4,200}wrote:\s*$/im, // Gmail / Apple Mail
  /^Le .{4,200}a écrit\s*:\s*$/im,
  /^El .{4,200}escribió:\s*$/im,
  /^Am .{4,200}schrieb .{0,100}:\s*$/im,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Forwarded message\s*-{2,}/im,
  /^From:\s.+\n(?:Sent|Date):\s/im, // Outlook
  /^_{10,}\s*$/m,
];
const SIGNATURE_MARKERS = [/^--\s*$/m, /^Sent from my (iPhone|iPad|Android|Samsung|mobile)/im, /^Get Outlook for /im];

/** Keep only what the customer wrote in this message: drop quoted history and signatures. */
export function cleanText(text) {
  let s = String(text || '').replace(/\r\n/g, '\n');
  for (const re of [...QUOTE_MARKERS, ...SIGNATURE_MARKERS]) {
    const m = s.match(re);
    if (m && m.index > 0) s = s.slice(0, m.index);
  }
  s = s
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const header = (headers, name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

/** Gmail API message (format=full) -> the fields the router needs. */
export function parseGmailMessage(msg) {
  const headers = msg.payload?.headers || [];
  const body = extractBody(msg.payload);
  const raw = body.text || htmlToText(body.html) || msg.snippet || '';
  const from = parseAddress(header(headers, 'From'));
  const replyTo = parseAddress(header(headers, 'Reply-To'));
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds || [],
    from,
    replyTo: replyTo.email ? replyTo : null,
    to: header(headers, 'To'),
    cc: header(headers, 'Cc'),
    subject: header(headers, 'Subject'),
    date: header(headers, 'Date'),
    messageId: header(headers, 'Message-ID') || header(headers, 'Message-Id'),
    references: header(headers, 'References'),
    autoSubmitted: header(headers, 'Auto-Submitted'),
    precedence: header(headers, 'Precedence'),
    listId: header(headers, 'List-Id'),
    listUnsubscribe: header(headers, 'List-Unsubscribe'),
    text: cleanText(raw),
    fullText: raw,
    attachments: body.attachments,
    internalDate: Number(msg.internalDate) || Date.now(),
  };
}

const NO_REPLY = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce[s]?|notifications?|alerts?)([+.@-]|$)/i;

/**
 * Why this message must NOT get an automatic reply (null = OK to reply).
 * Prevents loops with autoresponders, newsletters, bounces and our own sent mail.
 */
export function skipReason(email, { ownAddress = '' } = {}) {
  const sender = email.replyTo?.email || email.from.email;
  if (!sender) return 'no sender address';
  if (ownAddress && email.from.email === ownAddress.toLowerCase()) return 'sent by this mailbox';
  if (NO_REPLY.test(sender.split('@')[0])) return `automated sender (${sender})`;
  if (email.autoSubmitted && !/^no$/i.test(email.autoSubmitted.trim())) return `auto-submitted (${email.autoSubmitted})`;
  if (/^(bulk|list|junk|auto_reply)$/i.test(email.precedence.trim())) return `bulk mail (Precedence: ${email.precedence})`;
  if (email.listId || email.listUnsubscribe) return 'mailing list / newsletter';
  if (/^(auto(matic)? ?reply|out of (the )?office|autoreply|delivery status notification|undeliverable)/i.test(email.subject)) return 'auto-reply or bounce';
  if (email.labelIds.includes('SPAM') || email.labelIds.includes('SENT') || email.labelIds.includes('DRAFT')) return 'spam, sent or draft';
  return null;
}

/** RFC 2047 encode a header value when it is not plain ASCII. */
export function encodeHeader(value) {
  const s = String(value || '');
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

export function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^(re|aw|sv|antw|rif)\s*:/i.test(s) ? s : `Re: ${s || 'Your message'}`;
}

/** Build the base64url `raw` reply Gmail expects for drafts.create / messages.send. */
export function buildReply({ to, from, subject, body, inReplyTo, references }) {
  const refs = [references, inReplyTo].filter(Boolean).join(' ').trim();
  const lines = [
    from ? `From: ${from}` : null,
    `To: ${to}`,
    `Subject: ${encodeHeader(replySubject(subject))}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    refs ? `References: ${refs}` : null,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(body).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ].filter((l) => l !== null);
  return b64urlEncode(lines.join('\r\n'));
}

export function formatAddress(name, email) {
  const n = String(name || '').replace(/["\r\n]/g, '').trim();
  if (!n) return email;
  const enc = encodeHeader(n);
  return enc === n ? `"${n}" <${email}>` : `${enc} <${email}>`;
}
