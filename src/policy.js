/**
 * Business rules, decided in code (never by the model):
 *  - refund eligibility from the refund policy + order data
 *  - which facts the reply may use
 *  - escalation to a human, and whether a reply may be sent automatically
 */

const DAY = 864e5;

export function labelNames(prefix = 'AI') {
  const p = prefix ? `${prefix}/` : '';
  return {
    refund: `${p}Refund`,
    order_tracking: `${p}Order Tracking`,
    account_issue: `${p}Account`,
    other: `${p}Other`,
    needs_human: `${p}Needs Human`,
    auto_sent: `${p}Auto Sent`,
    drafted: `${p}Draft Ready`,
    processed: `${p}Processed`,
    skipped: `${p}Skipped`,
  };
}

const daysBetween = (from, to) => Math.floor((to - from) / DAY);

/** -> { eligible: true|false|null, kind, reason, needsApproval, daysSince, windowDays, amount } */
export function refundEligibility(order, cls, profile, now = Date.now()) {
  const pol = profile.refund_policy || {};
  const window = Number(pol.window_days ?? 30);
  const damagedWindow = Number(pol.damaged_window_days ?? window);
  const limit = Number(pol.auto_approve_limit ?? 0);
  const sub = cls.sub_type;
  if (!order) return { eligible: null, kind: 'unknown', reason: 'order not identified yet' };

  const amount = order.total || 0;
  const needsApproval = limit > 0 && amount > limit;
  const base = { amount, currency: order.currency, needsApproval, windowDays: window };

  if (order.status === 'refunded') return { ...base, eligible: false, kind: 'already_refunded', reason: 'this order was already refunded' };
  if (order.status === 'cancelled') return { ...base, eligible: false, kind: 'already_cancelled', reason: 'this order was already cancelled' };
  if (sub === 'double_charge') return { ...base, eligible: true, kind: 'billing_check', reason: 'possible duplicate charge: billing team must confirm', needsApproval: true };
  if (order.status === 'processing') return { ...base, eligible: true, kind: 'cancel_before_shipping', reason: 'order has not shipped yet, it can be cancelled for a full refund' };
  if (sub === 'cancel_order') return { ...base, eligible: false, kind: 'already_shipped', reason: 'order already shipped, so it cannot be cancelled; it can be returned once it arrives' };

  const ref = Date.parse(order.delivered_at || order.shipped_at || order.ordered_at);
  const daysSince = Number.isFinite(ref) ? daysBetween(ref, now) : null;
  const defect = sub === 'damaged_item' || sub === 'wrong_item';
  const win = defect ? damagedWindow : window;

  if (order.final_sale && !defect) return { ...base, eligible: false, kind: 'final_sale', reason: 'final-sale items cannot be returned unless faulty', daysSince };
  if (!['delivered', 'shipped', 'out_for_delivery'].includes(order.status)) return { ...base, eligible: null, kind: 'unknown_status', reason: `order status "${order.status}"`, daysSince };
  if (order.status !== 'delivered' && !defect) return { ...base, eligible: true, kind: 'return_after_delivery', reason: 'order is on its way; it can be returned for a refund once it arrives', daysSince };
  if (daysSince !== null && daysSince > win) return { ...base, eligible: false, kind: 'outside_window', reason: `delivered ${daysSince} days ago, the return window is ${win} days`, daysSince, windowDays: win };
  return { ...base, eligible: true, kind: defect ? 'defect_refund' : 'within_window', reason: defect ? 'faulty or wrong item: full refund or replacement, free return' : `within the ${win}-day return window`, daysSince, windowDays: win };
}

export function trackingFacts(order, profile, now = Date.now()) {
  if (!order) return null;
  const eta = Date.parse(order.estimated_delivery);
  const delayed = order.status !== 'delivered' && Number.isFinite(eta) && eta < now - DAY / 2;
  const tpl = profile.links?.tracking_template;
  const url = order.tracking_url || (tpl && order.tracking_number ? tpl.replace('{tracking}', encodeURIComponent(order.tracking_number)).replace('{carrier}', encodeURIComponent((order.carrier || '').toLowerCase())) : '');
  return {
    status: order.status,
    carrier: order.carrier,
    tracking_number: order.tracking_number,
    tracking_url: url,
    shipped_at: order.shipped_at,
    delivered_at: order.delivered_at,
    estimated_delivery: order.estimated_delivery,
    delayed,
  };
}

/** Public fields only: what the reply is allowed to mention about the order. */
export function orderFacts(order) {
  if (!order) return null;
  return {
    order_number: order.order_number,
    customer_name: order.customer_name,
    status: order.status,
    ordered_at: order.ordered_at,
    total: order.total,
    currency: order.currency,
    items: order.items.map((i) => `${i.qty} x ${i.name}`),
  };
}

/**
 * Decide what happens to one email.
 * ctx: { classification, lookup, email, threadCustomerMessages, config, profile, now }
 */
export function decide({ classification: cls, lookup, email, threadCustomerMessages = 1, config, profile, now = Date.now() }) {
  const reasons = [];
  const signals = new Set(cls.signals);
  if (threadCustomerMessages >= 3) signals.add('repeat_contact');
  const sender = (email.replyTo?.email || email.from.email || '').toLowerCase();
  const domain = sender.split('@')[1] || '';
  const vip = config.escalation.vipEmails.includes(sender) || config.escalation.vipDomains.includes(domain);

  const personName = (n) => (n && !/\b(team|support|info|sales|newsletter|mail|service|noreply|admin|office|hello|contact)\b/i.test(n) ? n : '');
  const facts = { intent: cls.intent, sub_type: cls.sub_type, language: cls.language, customer_name: personName(email.from.name) || (lookup?.verified ? lookup.order.customer_name : '') };
  const needsOrder = cls.intent === 'refund' || cls.intent === 'order_tracking';
  if (needsOrder) {
    if (lookup?.found && lookup.verified) {
      facts.order = orderFacts(lookup.order);
      if (lookup.matchedBy === 'email' && lookup.searchedNumber) facts.searched_number = lookup.searchedNumber; // asked about an order we could not find; this is their latest
      if (cls.intent === 'order_tracking') {
        facts.tracking = trackingFacts(lookup.order, profile, now);
        // Customer asks where it is, but the carrier says delivered: treat as a missing package.
        if (facts.tracking.status === 'delivered' && ['where_is_my_order', 'delayed', 'missing_package'].includes(cls.sub_type)) facts.sub_type = 'missing_package';
      }
      if (cls.intent === 'refund') facts.refund = refundEligibility(lookup.order, cls, profile, now);
    } else if (lookup?.found && !lookup.verified) {
      facts.order_status = 'email_mismatch';
      reasons.push('order exists but the sender is not the order email: details withheld');
    } else {
      facts.order_status = cls.order_number ? 'not_found' : 'missing_number';
      if (lookup?.error && lookup.error !== 'no order source configured') reasons.push(`order lookup failed: ${lookup.error}`);
    }
  }

  // Escalation
  if (signals.has('legal_threat')) reasons.push('legal threat');
  if (signals.has('chargeback')) reasons.push('chargeback / bank dispute threat');
  if (signals.has('security') || cls.sub_type === 'hacked') reasons.push('possible account compromise');
  if (cls.anger >= config.escalation.angerThreshold) reasons.push(`very angry customer (anger ${cls.anger})`);
  if (signals.has('repeat_contact')) reasons.push('customer has contacted us several times');
  if (vip) reasons.push('VIP customer');
  if (cls.needs_human && !reasons.length) reasons.push(cls.reason || 'model flagged for a human');
  if (cls.sub_type === 'delete_account') reasons.push('account deletion must be confirmed by a person');
  if (facts.refund?.needsApproval) reasons.push(`refund ${facts.refund.amount} ${facts.refund.currency} needs approval`);
  if (facts.tracking && facts.sub_type === 'missing_package' && facts.tracking.status === 'delivered') reasons.push('package marked delivered but customer says it is missing: carrier claim');
  if (cls.intent === 'other') reasons.push('not a standard support request: route to the right person');

  const escalate = reasons.some((r) => !r.startsWith('order lookup failed') && !r.startsWith('order exists'));
  // Apologise only when something went wrong for the customer (not for a partnership enquiry).
  const apologize = escalate && cls.intent !== 'other' && (cls.anger >= 50 || signals.has('repeat_contact') || [...signals].some((s) => ['legal_threat', 'chargeback'].includes(s)) || facts.sub_type === 'missing_package');

  // Send automatically only when everything is safe and the client opted in.
  const r = config.reply;
  const autoBlockers = [];
  if (r.mode !== 'send') autoBlockers.push('REPLY_MODE=draft');
  if (!r.autoSendIntents.includes(cls.intent)) autoBlockers.push(`intent ${cls.intent} is not in AUTO_SEND_INTENTS`);
  if (cls.confidence < r.autoSendMinConfidence) autoBlockers.push(`confidence ${cls.confidence} < ${r.autoSendMinConfidence}`);
  if (escalate) autoBlockers.push('escalated');
  if (needsOrder && !facts.order) autoBlockers.push('order not verified');
  if (cls.source !== 'ai') autoBlockers.push('classified by rules only');

  const action = escalate && !r.draftOnEscalation ? 'label_only' : autoBlockers.length ? 'draft' : 'send';
  return { action, escalate, apologize, reasons, vip, signals: [...signals], facts, autoBlockers };
}
