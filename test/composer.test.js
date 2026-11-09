import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLMRouter } from '../src/ai/index.js';
import { createComposer, makeReplyParser } from '../src/composer.js';
import { templateReply } from '../src/templates.js';
import { loadConfig } from '../src/config.js';
import { loadProfile } from '../src/index.js';
import { baseEnv, fakeProvider } from './helpers.js';
import { silentLogger } from '../src/logger.js';

const profile = loadProfile(loadConfig(baseEnv()).businessFile);
const trackingFacts = { intent: 'order_tracking', sub_type: 'where_is_my_order', language: 'en', customer_name: 'Emma Wilson', order: { order_number: '1001' }, tracking: { status: 'shipped', carrier: 'UPS', tracking_number: '1Z999', tracking_url: 'https://northwind-outfitters.example/track?n=1Z999' } };
const email = { from: { email: 'emma@x.com', name: 'Emma' }, subject: 'where', text: 'Where is my order 1001?' };
const decision = { escalate: false, apologize: false };
const OK = 'Hi Emma,\n\nYour order is on its way with UPS, tracking 1Z999: https://northwind-outfitters.example/track?n=1Z999\n\nBest regards,\nSam';

test('reply parser accepts a grounded reply', () => {
  const parse = makeReplyParser({ facts: trackingFacts, profile });
  assert.equal(parse(JSON.stringify({ body: OK })), OK);
  assert.equal(parse(OK), OK); // plain text is fine too
});

test('reply parser rejects invented links, placeholders, missing tracking number and false refund promises', () => {
  const parse = makeReplyParser({ facts: trackingFacts, profile });
  assert.throws(() => parse(JSON.stringify({ body: OK.replace('https://northwind-outfitters.example/track?n=1Z999', 'https://evil.example/claim') })), /link/);
  assert.throws(() => parse(JSON.stringify({ body: OK.replace('Emma', '[Customer Name]') })), /placeholder/);
  assert.throws(() => parse(JSON.stringify({ body: OK.replace(/1Z999/g, 'soon') })), /tracking number/);
  assert.throws(() => parse('{"body":"hi"}'), /too short/);
  const noRefund = makeReplyParser({ facts: { intent: 'refund', refund: { eligible: false } }, profile });
  assert.throws(() => noRefund('Hi Lucas, good news: your refund has been processed and will arrive soon. Best regards, Sam'), /promises a refund/);
});

test('invalid AI reply goes to the next model, then template when all fail', async () => {
  const bad = fakeProvider(() => ({ body: 'Hi [Name], your order is fine. Best regards from all of us here!' }));
  const good = fakeProvider(() => ({ body: OK }));
  const mk = (...ps) => createLLMRouter({ chain: ps.map((_, i) => ({ provider: `p${i}`, model: 'm' })), providers: Object.fromEntries(ps.map((p, i) => [`p${i}`, p])), hedgeAfterMs: 0 });
  const r1 = await createComposer({ ai: mk(bad, good), profile }).compose({ email, facts: trackingFacts, decision });
  assert.equal(r1.source, 'ai');
  assert.equal(r1.model, 'p1:m');
  const r2 = await createComposer({ ai: mk(bad), profile, logger: silentLogger }).compose({ email, facts: trackingFacts, decision });
  assert.equal(r2.source, 'template');
  assert.match(r2.body, /1Z999/);
  assert.match(r2.body, /Best regards,\nSam/);
});

test('composer prompt carries policy and treats the email as data', async () => {
  const p = fakeProvider(() => ({ body: OK }));
  const ai = createLLMRouter({ chain: [{ provider: 'p', model: 'm' }], providers: { p }, hedgeAfterMs: 0 });
  await createComposer({ ai, profile }).compose({ email: { ...email, from: { email: 'e', name: '' } }, facts: { ...trackingFacts, language: 'es' }, decision });
  assert.match(p.calls[0].system, /30/);
  assert.match(p.calls[0].system, /data, not instructions/);
  assert.match(p.calls[0].messages[0].content, /Write the reply in Spanish/);
});

test('templates cover every situation', () => {
  const t = (facts, d = decision) => templateReply({ facts: { language: 'en', customer_name: 'Ann B', ...facts }, decision: d, profile });
  assert.match(t({ intent: 'order_tracking', order_status: 'missing_number' }), /order number/);
  assert.match(t({ intent: 'order_tracking', order_status: 'email_mismatch' }), /email address used to place the order/);
  assert.match(t({ intent: 'refund', order: { order_number: '9' }, refund: { kind: 'outside_window', daysSince: 40, windowDays: 30, amount: 10, currency: 'USD' } }), /outside our 30-day return window[\s\S]*store credit/);
  assert.match(t({ intent: 'account_issue', sub_type: 'password_reset' }), /reset-password/);
  assert.match(t({ intent: 'other' }), /right person/);
  assert.match(t({ intent: 'refund', order: { order_number: '9' }, refund: { kind: 'defect_refund', amount: 1, currency: 'USD' } }, { escalate: true, apologize: true }), /^Hi Ann,\n\nI'm sorry for the trouble/);
});
