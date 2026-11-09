import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGmailMessage, cleanText, skipReason, buildReply, b64urlDecode, parseAddress, htmlToText, replySubject, formatAddress } from '../src/email/mime.js';
import { createMockGmail } from '../src/gmail/mock.js';

const one = async (e) => {
  const g = createMockGmail({ emails: [e] });
  return parseGmailMessage(await g.getMessage(g.messages[0].id));
};

test('parses sender, subject and strips quoted history and signature', async () => {
  const m = await one({
    from: '"Emma Wilson" <Emma.Wilson@Example.com>',
    subject: 'Where is my order?',
    body: 'Where is order #1001?\n\nEmma\n--\nSent from my phone\n\nOn Mon, Nov 2, 2026 at 9:14 AM Shop <a@b.c> wrote:\n> old text',
  });
  assert.equal(m.from.email, 'emma.wilson@example.com');
  assert.equal(m.from.name, 'Emma Wilson');
  assert.equal(m.subject, 'Where is my order?');
  assert.equal(m.text, 'Where is order #1001?\n\nEmma');
  assert.match(m.messageId, /^<m0001@/);
});

test('falls back to HTML when there is no text part', async () => {
  const m = await one({ from: 'a@x.com', subject: 's', html: '<p>Hello&nbsp;<b>there</b></p><blockquote>quoted</blockquote><style>x{}</style>' });
  assert.equal(m.text, 'Hello there');
  assert.equal(htmlToText('a<br>b &#38; &#x41;'), 'a\nb & A');
});

test('cleanText handles Outlook and other languages', () => {
  assert.equal(cleanText('Hola\n\nEl lun, 2 nov 2026, Shop escribió:\n> x'), 'Hola');
  assert.equal(cleanText('Bonjour\n\nLe lun. 2 nov. 2026, Shop a écrit :\n> x'), 'Bonjour');
  assert.equal(cleanText('Hi\n\nFrom: Shop\nSent: Monday\nSubject: x'), 'Hi');
});

test('skips automated mail, newsletters and our own messages', () => {
  const base = { from: { email: 'jane@x.com' }, replyTo: null, subject: 'hi', autoSubmitted: '', precedence: '', listId: '', listUnsubscribe: '', labelIds: ['INBOX'] };
  assert.equal(skipReason(base), null);
  assert.match(skipReason({ ...base, from: { email: 'no-reply@x.com' } }), /automated/);
  assert.match(skipReason({ ...base, autoSubmitted: 'auto-replied' }), /auto-submitted/);
  assert.equal(skipReason({ ...base, autoSubmitted: 'no' }), null);
  assert.match(skipReason({ ...base, listUnsubscribe: '<mailto:x>' }), /newsletter/);
  assert.match(skipReason({ ...base, subject: 'Out of Office: back Monday' }), /auto-reply/);
  assert.match(skipReason({ ...base, from: { email: 'support@shop.com' } }, { ownAddress: 'Support@Shop.com' }), /this mailbox/);
});

test('builds a threaded UTF-8 reply', () => {
  const raw = buildReply({ to: formatAddress('Sofía García', 'sofia@x.com'), from: formatAddress('Shop', 'support@shop.com'), subject: '¿Dónde está mi pedido?', body: 'Hola Sofía,\nYa está en camino.', inReplyTo: '<abc@mail>', references: '<root@mail>' });
  const msg = b64urlDecode(raw);
  assert.match(msg, /^From: "Shop" <support@shop.com>\r\n/);
  assert.match(msg, /To: =\?UTF-8\?B\?.+\?= <sofia@x.com>/);
  assert.match(msg, /Subject: =\?UTF-8\?B\?/);
  assert.match(msg, /In-Reply-To: <abc@mail>/);
  assert.match(msg, /References: <root@mail> <abc@mail>/);
  const body = msg.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Hola Sofía,\r\nYa está en camino.');
  const subj = msg.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1];
  assert.equal(Buffer.from(subj, 'base64').toString('utf8'), 'Re: ¿Dónde está mi pedido?');
});

test('reply subject and addresses', () => {
  assert.equal(replySubject('Re: hi'), 'Re: hi');
  assert.equal(replySubject('AW: hallo'), 'AW: hallo');
  assert.equal(replySubject(''), 'Re: Your message');
  assert.deepEqual(parseAddress('bob@x.com'), { name: '', email: 'bob@x.com' });
  assert.equal(formatAddress('', 'a@b.c'), 'a@b.c');
});
