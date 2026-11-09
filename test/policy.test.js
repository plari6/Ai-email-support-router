import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refundEligibility, trackingFacts, decide } from '../src/policy.js';
import { loadConfig } from '../src/config.js';
import { normalizeOrder } from '../src/orders.js';
import { loadProfile } from '../src/index.js';
import { baseEnv } from './helpers.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const ago = (d) => new Date(NOW - d * 864e5).toISOString();
const profile = loadProfile(loadConfig(baseEnv()).businessFile);
const order = (o) => normalizeOrder({ order_number: '1', email: 'a@x.com', status: 'delivered', delivered_at: ago(5), total: 80, currency: 'USD', items: [{ name: 'x', qty: 1, price: 80 }], ...o });
const cls = (o = {}) => ({ intent: 'refund', sub_type: 'refund_request', confidence: 0.92, anger: 20, urgency: 30, signals: [], needs_human: false, source: 'ai', language: 'en', ...o });

test('refund eligibility follows the policy', () => {
  const e = (o, c) => refundEligibility(order(o), cls(c), profile, NOW);
  assert.equal(e({}).kind, 'within_window');
  assert.equal(e({ delivered_at: ago(31) }).kind, 'outside_window');
  assert.equal(e({ delivered_at: ago(45) }, { sub_type: 'damaged_item' }).kind, 'defect_refund'); // 60-day window for faulty items
  assert.equal(e({ delivered_at: ago(61) }, { sub_type: 'damaged_item' }).kind, 'outside_window');
  assert.equal(e({ status: 'processing' }).kind, 'cancel_before_shipping');
  assert.equal(e({ status: 'shipped' }, { sub_type: 'cancel_order' }).kind, 'already_shipped');
  assert.equal(e({ status: 'refunded' }).eligible, false);
  assert.equal(e({ items: [{ name: 'x', final_sale: true }] }).kind, 'final_sale');
  assert.equal(e({ items: [{ name: 'x', final_sale: true }] }, { sub_type: 'damaged_item' }).kind, 'defect_refund');
  assert.equal(e({ total: 300 }).needsApproval, true); // over auto_approve_limit 250
  assert.equal(e({}, { sub_type: 'double_charge' }).needsApproval, true);
  assert.equal(refundEligibility(null, cls(), profile).eligible, null);
});

test('tracking facts: delay and tracking link', () => {
  const t = trackingFacts(order({ status: 'shipped', tracking_number: '1Z9', estimated_delivery: ago(2) }), profile, NOW);
  assert.equal(t.delayed, true);
  assert.equal(t.tracking_url, 'https://northwind-outfitters.example/track?n=1Z9');
  assert.equal(trackingFacts(order({ status: 'shipped', estimated_delivery: ago(-2) }), profile, NOW).delayed, false);
});

const email = (from = 'a@x.com', name = 'Ann Lee') => ({ from: { email: from, name }, replyTo: null });
const run = (c, lookup, extra = {}, env = {}) => decide({ classification: cls(c), lookup, email: email(extra.from), config: loadConfig(baseEnv(env)), profile, now: NOW, ...extra });
const found = (o) => ({ order: order(o), found: true, verified: true, matchedBy: 'number' });

test('calm refund within policy -> draft, no escalation', () => {
  const d = run({}, found({}));
  assert.equal(d.action, 'draft');
  assert.equal(d.escalate, false);
  assert.equal(d.facts.refund.kind, 'within_window');
  assert.equal(d.facts.customer_name, 'Ann Lee');
});

test('escalates threats, anger, repeat contact, VIPs, hacked accounts and missing parcels', () => {
  assert.match(run({ signals: ['chargeback'] }, found({})).reasons.join(), /chargeback/);
  assert.match(run({ anger: 90 }, found({})).reasons.join(), /very angry/);
  assert.match(run({}, found({}), { threadCustomerMessages: 3 }).reasons.join(), /several times/);
  assert.match(run({}, found({}), {}, { VIP_DOMAINS: 'x.com' }).reasons.join(), /VIP/);
  assert.match(run({ intent: 'account_issue', sub_type: 'hacked' }, null).reasons.join(), /compromise/);
  const missing = run({ intent: 'order_tracking', sub_type: 'where_is_my_order' }, found({ status: 'delivered' }));
  assert.equal(missing.facts.sub_type, 'missing_package');
  assert.equal(missing.escalate, true);
  assert.equal(missing.apologize, true);
});

test('order details are withheld when the sender is not the order email', () => {
  const d = run({ intent: 'order_tracking', sub_type: 'where_is_my_order' }, { order: order({}), found: true, verified: false, matchedBy: 'number' });
  assert.equal(d.facts.order_status, 'email_mismatch');
  assert.equal(d.facts.order, undefined);
  assert.equal(d.facts.tracking, undefined);
});

test('auto-send only in send mode, for allowed intents, with a verified order and AI classification', () => {
  const tracking = { intent: 'order_tracking', sub_type: 'where_is_my_order' };
  const shipped = found({ status: 'shipped', tracking_number: '1Z' });
  assert.equal(run(tracking, shipped).action, 'draft'); // default mode is draft
  const send = { REPLY_MODE: 'send' };
  assert.equal(run(tracking, shipped, {}, send).action, 'send');
  assert.equal(run({ ...tracking, confidence: 0.6 }, shipped, {}, send).action, 'draft');
  assert.equal(run({ ...tracking, source: 'rules' }, shipped, {}, send).action, 'draft');
  assert.equal(run(tracking, { found: false }, {}, send).action, 'draft');
  assert.equal(run({}, found({}), {}, send).action, 'draft'); // refund not in AUTO_SEND_INTENTS
  assert.equal(run({ ...tracking, anger: 95 }, shipped, {}, send).action, 'draft');
  assert.equal(run({ ...tracking, anger: 95 }, shipped, {}, { DRAFT_ON_ESCALATION: 'false' }).action, 'label_only');
});
