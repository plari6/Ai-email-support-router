import fs from 'node:fs';

/**
 * Order lookup. Every source returns the same normalised order:
 * { order_number, email, customer_name, status, carrier, tracking_number, tracking_url,
 *   ordered_at, shipped_at, delivered_at, estimated_delivery, total, currency, items[], final_sale }
 * status: processing | shipped | out_for_delivery | delivered | cancelled | refunded | unknown
 */

const norm = (v) => String(v || '').replace(/^#/, '').trim().toUpperCase();
const sameEmail = (a, b) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

export function normalizeOrder(o) {
  if (!o || typeof o !== 'object') return null;
  return {
    order_number: norm(o.order_number ?? o.orderNumber ?? o.number ?? o.name ?? o.id),
    email: String(o.email ?? o.customer_email ?? o.customer?.email ?? '').toLowerCase(),
    customer_name: o.customer_name ?? o.customerName ?? ([o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || ''),
    status: String(o.status || 'unknown').toLowerCase(),
    carrier: o.carrier || '',
    tracking_number: o.tracking_number || o.trackingNumber || '',
    tracking_url: o.tracking_url || o.trackingUrl || '',
    ordered_at: o.ordered_at || o.created_at || o.createdAt || '',
    shipped_at: o.shipped_at || '',
    delivered_at: o.delivered_at || '',
    estimated_delivery: o.estimated_delivery || o.estimatedDelivery || '',
    total: Number(o.total ?? o.total_price ?? 0),
    currency: o.currency || 'USD',
    items: (o.items || o.line_items || []).map((i) => ({ name: i.name || i.title || 'item', qty: Number(i.qty ?? i.quantity ?? 1), price: Number(i.price ?? 0), final_sale: Boolean(i.final_sale) })),
    final_sale: Boolean(o.final_sale) || (o.items || []).some((i) => i.final_sale),
  };
}

function fromList(list) {
  const orders = list.map(normalizeOrder).filter(Boolean);
  return {
    async findByNumber(n) {
      return orders.find((o) => o.order_number === norm(n)) || null;
    },
    async findByEmail(email) {
      return orders.filter((o) => sameEmail(o.email, email)).sort((a, b) => String(b.ordered_at).localeCompare(String(a.ordered_at)));
    },
  };
}

/** "now-5d" / "now+2d" -> ISO date (keeps the sample orders realistic whenever the demo runs). */
export function relativeDate(v, now = Date.now()) {
  const m = typeof v === 'string' && v.match(/^now([+-]\d+)d$/);
  return m ? new Date(now + Number(m[1]) * 864e5).toISOString() : v;
}

export function createJsonOrderSource(file) {
  let cache = null;
  let mtime = 0;
  const load = () => {
    const st = fs.statSync(file);
    if (!cache || st.mtimeMs !== mtime) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'), (_k, v) => relativeDate(v));
      cache = fromList(Array.isArray(data) ? data : data.orders || []);
      mtime = st.mtimeMs;
    }
    return cache;
  };
  return {
    name: `json:${file}`,
    findByNumber: (n) => load().findByNumber(n),
    findByEmail: (e) => load().findByEmail(e),
  };
}

/** Any HTTP endpoint (your backend, an n8n/Make webhook...). URL placeholders: {order} {email}. */
export function createHttpOrderSource({ url, token, fetchImpl = fetch }) {
  async function get(params) {
    const u = url.replace('{order}', encodeURIComponent(params.order || '')).replace('{email}', encodeURIComponent(params.email || ''));
    const res = await fetchImpl(u, { headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`order API ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.orders || (data.order ? [data.order] : [data]);
    return list.map(normalizeOrder).filter((o) => o && o.order_number);
  }
  return {
    name: `http:${new URL(url.replace(/[{}]/g, '')).host}`,
    async findByNumber(n) {
      return (await get({ order: norm(n) })).find((o) => o.order_number === norm(n)) || null;
    },
    async findByEmail(email) {
      return get({ email });
    },
  };
}

/** Shopify Admin REST API (custom app access token with read_orders). */
export function createShopifyOrderSource({ shop, token, apiVersion = '2025-10', fetchImpl = fetch }) {
  const base = `https://${shop}.myshopify.com/admin/api/${apiVersion}`;
  async function orders(query) {
    const res = await fetchImpl(`${base}/orders.json?${new URLSearchParams({ status: 'any', limit: '5', ...query })}`, {
      headers: { 'X-Shopify-Access-Token': token, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Shopify ${res.status}`);
    return ((await res.json()).orders || []).map(mapShopify);
  }
  return {
    name: `shopify:${shop}`,
    async findByNumber(n) {
      const list = await orders({ name: `#${norm(n)}` });
      return list.find((o) => o.order_number === norm(n)) || null;
    },
    async findByEmail(email) {
      return orders({ email });
    },
  };
}

export function mapShopify(o) {
  const f = (o.fulfillments || []).find((x) => x.tracking_number) || (o.fulfillments || [])[0] || {};
  const shipStatus = f.shipment_status; // in_transit | out_for_delivery | delivered | failure ...
  let status = 'processing';
  if (o.cancelled_at) status = 'cancelled';
  else if (o.financial_status === 'refunded') status = 'refunded';
  else if (shipStatus === 'delivered') status = 'delivered';
  else if (shipStatus === 'out_for_delivery') status = 'out_for_delivery';
  else if (o.fulfillment_status === 'fulfilled' || f.status === 'success') status = 'shipped';
  return normalizeOrder({
    order_number: String(o.name || o.order_number).replace(/^#/, ''),
    email: o.email || o.customer?.email,
    customer: o.customer,
    status,
    carrier: f.tracking_company || '',
    tracking_number: f.tracking_number || '',
    tracking_url: f.tracking_url || '',
    created_at: o.created_at,
    shipped_at: f.created_at || '',
    delivered_at: shipStatus === 'delivered' ? f.updated_at : '',
    total_price: o.total_price,
    currency: o.currency,
    line_items: o.line_items,
  });
}

export function createOrderSource(config, { fetchImpl = fetch } = {}) {
  const o = config.orders;
  const src = o.source || (o.shopifyShop && o.shopifyToken ? 'shopify' : o.apiUrl ? 'http' : o.file && fs.existsSync(o.file) ? 'json' : 'none');
  if (src === 'shopify') return createShopifyOrderSource({ shop: o.shopifyShop, token: o.shopifyToken, apiVersion: o.shopifyApiVersion, fetchImpl });
  if (src === 'http') return createHttpOrderSource({ url: o.apiUrl, token: o.apiToken, fetchImpl });
  if (src === 'json') return createJsonOrderSource(o.file);
  return null;
}

/**
 * Find the customer's order. Details are only shared when the sender's address matches the order
 * (so a stranger who guesses an order number learns nothing).
 * -> { order, found, verified, matchedBy: 'number'|'email'|null, error? }
 */
export async function lookupOrder(source, { orderNumber, email, requireEmailMatch = true }) {
  if (!source) return { order: null, found: false, verified: false, matchedBy: null, error: 'no order source configured' };
  try {
    if (orderNumber) {
      const order = await source.findByNumber(orderNumber);
      if (order) {
        const verified = !requireEmailMatch || sameEmail(order.email, email);
        return { order, found: true, verified, matchedBy: 'number' };
      }
    }
    if (email) {
      const list = await source.findByEmail(email);
      if (list.length) return { order: list[0], found: true, verified: true, matchedBy: 'email', others: list.length - 1, searchedNumber: orderNumber || null };
    }
    return { order: null, found: false, verified: false, matchedBy: null, searchedNumber: orderNumber || null };
  } catch (err) {
    return { order: null, found: false, verified: false, matchedBy: null, error: err.message };
  }
}
