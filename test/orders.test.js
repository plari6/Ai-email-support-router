import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createJsonOrderSource, createHttpOrderSource, createShopifyOrderSource, lookupOrder, relativeDate } from '../src/orders.js';
import { EXAMPLES } from '../src/index.js';

const json = createJsonOrderSource(path.join(EXAMPLES, 'orders.json'));

test('JSON source: by number with email check, and by email', async () => {
  const ok = await lookupOrder(json, { orderNumber: '#1001', email: 'Emma.Wilson@example.com' });
  assert.equal(ok.verified, true);
  assert.equal(ok.order.tracking_number, '1Z999AA10123456784');
  assert.ok(Date.parse(ok.order.estimated_delivery) > Date.now()); // "now+2d" resolved
  const stranger = await lookupOrder(json, { orderNumber: '1001', email: 'random@example.org' });
  assert.equal(stranger.found, true);
  assert.equal(stranger.verified, false);
  const byEmail = await lookupOrder(json, { orderNumber: null, email: 'liam.chen@example.com' });
  assert.equal(byEmail.order.order_number, '1002');
  assert.equal(byEmail.matchedBy, 'email');
  const wrongNumber = await lookupOrder(json, { orderNumber: '7777', email: 'liam.chen@example.com' });
  assert.equal(wrongNumber.searchedNumber, '7777');
  assert.equal((await lookupOrder(json, { orderNumber: '7777', email: 'nobody@x.com' })).found, false);
  assert.equal((await lookupOrder(null, { orderNumber: '1' })).error, 'no order source configured');
});

test('relative dates', () => {
  assert.equal(relativeDate('now-1d', Date.parse('2026-01-02T00:00:00Z')), '2026-01-01T00:00:00.000Z');
  assert.equal(relativeDate('2026-01-01'), '2026-01-01');
});

const res = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('HTTP source fills placeholders and sends the token', async () => {
  const seen = [];
  const src = createHttpOrderSource({
    url: 'https://api.shop.example/orders?number={order}&email={email}',
    token: 'tok',
    fetchImpl: async (u, o) => {
      seen.push([u, o.headers.authorization]);
      return res(200, { order: { number: 'A-1', customer_email: 'X@Y.com', status: 'shipped', trackingNumber: 'T1' } });
    },
  });
  const r = await lookupOrder(src, { orderNumber: 'a-1', email: 'x@y.com' });
  assert.equal(r.verified, true);
  assert.equal(r.order.tracking_number, 'T1');
  assert.deepEqual(seen[0], ['https://api.shop.example/orders?number=A-1&email=', 'Bearer tok']);
});

test('HTTP source errors are reported, not thrown', async () => {
  const src = createHttpOrderSource({ url: 'https://api.shop.example/o/{order}', fetchImpl: async () => res(500, {}) });
  assert.match((await lookupOrder(src, { orderNumber: '1', email: 'a@b.c' })).error, /500/);
});

test('Shopify orders are mapped to the common shape', async () => {
  let url;
  const src = createShopifyOrderSource({
    shop: 'demo',
    token: 'shpat',
    fetchImpl: async (u, o) => {
      url = u;
      assert.equal(o.headers['X-Shopify-Access-Token'], 'shpat');
      return res(200, {
        orders: [
          {
            name: '#1042',
            email: 'a@b.c',
            created_at: '2026-11-01T00:00:00Z',
            total_price: '59.00',
            currency: 'USD',
            fulfillment_status: 'fulfilled',
            customer: { first_name: 'Ann', last_name: 'Lee' },
            line_items: [{ title: 'Tent', quantity: 1, price: '59.00' }],
            fulfillments: [{ status: 'success', tracking_company: 'UPS', tracking_number: '1Z', tracking_url: 'https://ups.example/1Z', shipment_status: 'in_transit' }],
          },
        ],
      });
    },
  });
  const o = await src.findByNumber('1042');
  assert.match(url, /^https:\/\/demo\.myshopify\.com\/admin\/api\/2025-10\/orders\.json\?status=any&limit=5&name=%231042$/);
  assert.equal(o.status, 'shipped');
  assert.equal(o.customer_name, 'Ann Lee');
  assert.equal(o.total, 59);
  assert.equal(o.items[0].name, 'Tent');
  assert.equal(o.tracking_url, 'https://ups.example/1Z');
});
