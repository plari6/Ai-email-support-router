/**
 * Non-AI replies: used when every model fails, so a draft is always ready for the agent.
 * English only (the AI writes in the customer's language). Facts come from policy.decide().
 */

const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const money = (amount, currency) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount);
  } catch {
    return `${amount} ${currency || ''}`.trim();
  }
};
const date = (d) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
};

function orderLines(facts, profile) {
  if (facts.order_status === 'email_mismatch')
    return [`For your security I can only share order details with the email address used to place the order. Could you write to us from that address, or reply with the name and postcode on the order?`];
  if (facts.order_status === 'not_found') return [`I couldn't find an order with that number. Could you double-check it? It starts with # and is in your order confirmation email.`];
  if (facts.order_status === 'missing_number') return [`Could you send me your order number? You'll find it in your order confirmation email (it looks like #1001). That way I can look into it right away.`];
  return facts.searched_number ? [`I couldn't find order #${facts.searched_number} under your email address, so I've checked your most recent order, #${facts.order.order_number}.`] : [];
}

function tracking(facts, profile) {
  const t = facts.tracking;
  const o = facts.order;
  if (!t) return orderLines(facts, profile);
  const lines = [...orderLines(facts, profile)];
  const num = `#${o.order_number}`;
  if (t.status === 'processing') lines.push(`Your order ${num} is being prepared and hasn't shipped yet. Orders usually ship within ${profile.shipping?.processing_time || '1-2 business days'}, and you'll get a tracking link by email as soon as it leaves our warehouse.`);
  else if (t.status === 'delivered') {
    lines.push(`Our records show order ${num} was delivered${t.delivered_at ? ` on ${date(t.delivered_at)}` : ''}${t.carrier ? ` by ${t.carrier}` : ''}.`);
    if (facts.sub_type === 'missing_package') lines.push(`I'm sorry it hasn't reached you. Please check with neighbours and around the delivery spot; meanwhile I've asked our team to open a claim with the carrier and we'll update you within 1 business day.`);
  } else if (t.status === 'cancelled' || t.status === 'refunded') lines.push(`Order ${num} was ${t.status}, so it won't be shipped. Let me know if you'd like to place it again.`);
  else {
    lines.push(`${t.delayed ? 'Order' : 'Good news: order'} ${num} is ${t.status === 'out_for_delivery' ? 'out for delivery today' : 'on its way'}${t.carrier ? ` with ${t.carrier}` : ''}.`);
    if (t.tracking_number) lines.push(`Tracking number: ${t.tracking_number}${t.tracking_url ? `\nTrack it here: ${t.tracking_url}` : ''}`);
    if (t.delayed) lines.push(`I'm sorry it's taking longer than expected${t.estimated_delivery ? ` (it was due ${date(t.estimated_delivery)})` : ''}. Carriers are sometimes delayed by a few days; if there's no movement in 3 business days, reply here and we'll chase the carrier or send a replacement.`);
    else if (t.estimated_delivery) lines.push(`Estimated delivery: ${date(t.estimated_delivery)}.`);
  }
  return lines;
}

function refund(facts, profile) {
  const r = facts.refund;
  const o = facts.order;
  const pol = profile.refund_policy || {};
  if (!r) return orderLines(facts, profile);
  const lines = [...orderLines(facts, profile)];
  const num = `#${o.order_number}`;
  const time = pol.processing_time || '5-7 business days';
  const amount = money(r.amount, r.currency);
  switch (r.kind) {
    case 'already_refunded':
      lines.push(`Order ${num} has already been refunded to your ${pol.method || 'original payment method'}. Depending on your bank it can take ${time} to show on your statement.`);
      break;
    case 'already_cancelled':
      lines.push(`Order ${num} has already been cancelled, so you won't be charged for it. If you see a pending charge, it will drop off within a few days.`);
      break;
    case 'cancel_before_shipping':
      lines.push(`Order ${num} hasn't shipped yet, so we can cancel it and refund the full ${amount}. I've passed your request to our team and you'll get a confirmation email shortly.`);
      break;
    case 'already_shipped':
      lines.push(`Order ${num} has already shipped, so we can't cancel it any more. Once it arrives you can return it within ${pol.window_days || 30} days for a refund${profile.links?.returns_portal ? ` here: ${profile.links.returns_portal}` : ''}.`);
      break;
    case 'billing_check':
      lines.push(`I'm sorry about the duplicate charge on order ${num}. I've sent this to our billing team to confirm with the payment provider, and any extra charge will be refunded in full. We'll email you within 1 business day.`);
      break;
    case 'defect_refund':
      lines.push(`I'm really sorry your order ${num} arrived ${facts.sub_type === 'wrong_item' ? 'with the wrong item' : 'damaged'}. You're covered: we can send a replacement or refund you in full, and the return is free.`);
      lines.push(`Could you reply with a photo of the item and tell me whether you'd prefer a replacement or a refund?`);
      break;
    case 'within_window':
    case 'return_after_delivery':
      lines.push(`Your order ${num} is eligible for a refund under our ${pol.window_days || 30}-day return policy.${r.kind === 'return_after_delivery' ? ' Once it arrives, ' : ' '}You can start the return${profile.links?.returns_portal ? ` here: ${profile.links.returns_portal}` : ' by replying to this email'}. As soon as we receive the item, we'll refund ${amount} to your ${pol.method || 'original payment method'} within ${time}.`);
      break;
    case 'outside_window':
      lines.push(`I checked order ${num}: it was delivered ${r.daysSince} days ago, which is outside our ${r.windowDays}-day return window, so I'm not able to offer a refund.${pol.alternative ? ` ${pol.alternative}` : ''}`);
      break;
    case 'final_sale':
      lines.push(`Order ${num} includes final-sale items, which can't be returned unless they're faulty. If something is wrong with the item, reply with a photo and we'll make it right.`);
      break;
    default:
      lines.push(`I've passed your refund request for order ${num} to our team, and we'll get back to you within 1 business day.`);
  }
  if (r.needsApproval && r.kind !== 'billing_check') lines.push(`A member of our team will confirm the refund within 1 business day.`);
  return lines;
}

function account(facts, profile) {
  const l = profile.links || {};
  const map = {
    password_reset: [`You can reset your password here: ${l.reset_password || profile.website}. The link in the email is valid for 1 hour, so please check your spam folder if you don't see it.`],
    locked_out: [`Your account may be locked after several sign-in attempts. Please wait 15 minutes, then reset your password here: ${l.reset_password || profile.website}. If that doesn't work, reply and we'll unlock it for you.`],
    two_factor: [`If you can't get your verification code, check that your phone's time is set automatically and try again. If you've lost access to your authenticator, reply here and we'll verify your identity and reset two-factor authentication.`],
    email_change: [`You can update your email address in your account settings${l.account_settings ? `: ${l.account_settings}` : ''}. If you can't sign in to do it, reply from this address and we'll help.`],
    delete_account: [`We've received your request to delete your account. A member of our team will confirm the deletion and email you when it's done (usually within 2 business days).`],
    hacked: [`I'm sorry, that's worrying. Please reset your password right away: ${l.reset_password || profile.website}. Our security team has been alerted and will review your account and any recent orders, and contact you within a few hours.`],
    billing_update: [`You can update your payment method in your account settings${l.account_settings ? `: ${l.account_settings}` : ''}.`],
  };
  return [...(map[facts.sub_type] || map.password_reset), `For your security, we will never ask for your password or full card number.`];
}

function other(facts, profile) {
  return [`Thanks for reaching out. I've passed your message to the right person on our team, and we'll get back to you within ${profile.response_time || '1 business day'}.${profile.links?.help_center ? ` In the meantime, our help centre may have a quick answer: ${profile.links.help_center}` : ''}`];
}

export function templateReply({ facts, decision, profile }) {
  const name = firstName(facts.customer_name);
  const body = { order_tracking: tracking, refund, account_issue: account, other }[facts.intent](facts, profile);
  const lines = [`Hi${name ? ` ${name}` : ''},`, ''];
  if (decision.apologize && facts.intent !== 'account_issue' && facts.sub_type !== 'missing_package') lines.push(`I'm sorry for the trouble, and thank you for your patience. I've flagged your message to a senior member of our team, who will personally follow up.`, '');
  lines.push(body.join('\n\n'), '', profile.signature || `Best regards,\n${profile.company || 'The support team'}`);
  return lines.join('\n').trim();
}
