import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, smartFake, samples } from './helpers.js';

const byFrom = (rows, who) => rows.find((r) => r.from?.startsWith(who));
const labelsOf = (gmail, id) => gmail.messages.find((m) => m.id === id).labelIds.map((l) => gmail.labelName(l));

test('full inbox run with AI: drafts, labels, escalations, skips', async () => {
  const { app, gmail } = makeApp({ provider: smartFake() });
  const rows = await app.processor.runOnce({ limit: 50 });
  assert.equal(rows.length, 16);
  assert.equal(rows.filter((r) => r.action === 'skip').length, 2);
  assert.equal(gmail.drafts.length, 14);
  assert.equal(gmail.sent.length, 0); // draft mode by default
  assert.ok(rows.filter((r) => r.intent).every((r) => r.classifiedBy === 'ai' && r.replySource === 'ai'));

  const emma = byFrom(rows, 'emma.wilson');
  assert.equal(emma.intent, 'order_tracking');
  assert.equal(emma.orderVerified, true);
  assert.deepEqual(labelsOf(gmail, emma.messageId).filter((l) => l.startsWith('AI/')).sort(), ['AI/Draft Ready', 'AI/Order Tracking', 'AI/Processed']);
  const draft = gmail.drafts.find((d) => d.message.threadId === emma.threadId);
  assert.match(draft.decoded, /To: "Emma Wilson" <emma.wilson@example.com>/);
  assert.match(draft.decoded, /In-Reply-To: <m0001@mail.example>/);
  assert.match(Buffer.from(draft.decoded.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'), /1Z999AA10123456784/);

  const james = byFrom(rows, 'james.taylor');
  assert.equal(james.escalate, true);
  assert.ok(labelsOf(gmail, james.messageId).includes('AI/Needs Human'));
  assert.ok(labelsOf(gmail, james.messageId).includes('STARRED'));

  assert.equal(byFrom(rows, 'random.person').orderVerified, false);
  assert.equal(byFrom(rows, 'noah.brown').refund.kind, 'outside_window');
  assert.ok(labelsOf(gmail, byFrom(rows, 'newsletter').messageId).includes('AI/Skipped'));
});

test('second run does nothing (idempotent), new mail is picked up', async () => {
  const { app, gmail } = makeApp({ noAi: true });
  await app.processor.runOnce({ limit: 50 });
  assert.equal((await app.processor.runOnce({ limit: 50 })).length, 0);
  gmail.addEmail({ from: 'Zoe <zoe@example.com>', subject: 'password', body: 'I forgot my password, please help' });
  const rows = await app.processor.runOnce({ limit: 50 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].intent, 'account_issue');
  assert.equal(gmail.drafts.length, 15);
});

test('dry run changes nothing', async () => {
  const { app, gmail } = makeApp({ noAi: true });
  const rows = await app.processor.runOnce({ dryRun: true, limit: 50 });
  assert.equal(rows.length, 16);
  assert.ok(rows.find((r) => r.reply));
  assert.equal(gmail.drafts.length, 0);
  assert.ok(gmail.messages.every((m) => m.labelIds.every((l) => ['INBOX', 'UNREAD'].includes(l))));
  assert.equal(app.store.history().length, 0);
});

test('send mode auto-sends only safe order-tracking replies', async () => {
  const { app, gmail } = makeApp({ provider: smartFake(), env: { REPLY_MODE: 'send' } });
  const rows = await app.processor.runOnce({ limit: 50 });
  const sent = rows.filter((r) => r.action === 'send');
  assert.deepEqual(sent.map((r) => r.from).sort(), ['emma.wilson@example.com', 'sofia.garcia@example.com']);
  assert.equal(gmail.sent.length, 2);
  for (const r of sent) assert.ok(labelsOf(gmail, r.messageId).includes('AI/Auto Sent') && !labelsOf(gmail, r.messageId).includes('UNREAD'));
  // Amira asked about a "delivered" parcel: escalated, so not auto-sent.
  assert.equal(byFrom(rows, 'amira.haddad').action, 'draft');
});

test('AI outage: rules + templates still answer everything', async () => {
  const down = smartFake({ classify: () => ({}), reply: () => Object.assign(new Error('503'), { status: 503 }) });
  down.complete = async () => {
    throw Object.assign(new Error('overloaded'), { status: 503, kind: 'overloaded' });
  };
  const { app, gmail } = makeApp({ provider: down });
  const rows = await app.processor.runOnce({ limit: 50 });
  assert.equal(gmail.drafts.length, 14);
  assert.ok(rows.filter((r) => r.intent).every((r) => r.classifiedBy === 'rules' && r.replySource === 'template'));
});

test('a failed draft is not marked processed, so it is retried', async () => {
  const { app, gmail } = makeApp({ noAi: true, emails: [samples()[0]] });
  gmail.createDraft = async () => {
    throw new Error('Gmail 500');
  };
  const [r] = await app.processor.runOnce();
  assert.match(r.error, /Gmail 500/);
  assert.ok(!labelsOf(gmail, r.messageId).includes('AI/Processed'));
  delete gmail.createDraft;
  const { createMockGmail } = await import('../src/gmail/mock.js');
  gmail.createDraft = createMockGmail().createDraft.bind(gmail);
  const again = await app.processor.runOnce();
  assert.equal(again.length, 1);
  assert.equal(again[0].action, 'draft');
});

test('escalations send an alert', async () => {
  const posted = [];
  const fetchImpl = async (url, o) => {
    posted.push([url, JSON.parse(o.body)]);
    return { ok: true, status: 200 };
  };
  const { app } = makeApp({ noAi: true, env: { SLACK_WEBHOOK_URL: 'https://hooks.slack.example/x', ALERT_WEBHOOK_URL: 'https://n8n.example/hook' }, fetchImpl, emails: [samples()[5]] });
  const [r] = await app.processor.runOnce();
  assert.equal(r.escalate, true);
  assert.deepEqual(r.alerted, ['slack', 'webhook']);
  assert.match(posted[0][1].text, /needs a human/);
  assert.equal(posted[1][1].orderNumber, '1006');
});

test('thread with 3 customer messages counts as repeat contact', async () => {
  const e = { from: 'Ann <ann@example.com>', subject: 'password', body: 'I forgot my password', threadId: 'tx' };
  const { app } = makeApp({ noAi: true, emails: [e, e, { ...e, body: 'Still waiting, I forgot my password' }] });
  const rows = await app.processor.runOnce();
  assert.ok(rows.every((r) => r.reasons.some((x) => /several times/.test(x))));
});
