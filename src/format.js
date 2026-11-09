const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { red: wrap(31), green: wrap(32), yellow: wrap(33), blue: wrap(34), magenta: wrap(35), cyan: wrap(36), gray: wrap(90), bold: wrap(1) };

const INTENT_COLOR = { refund: c.magenta, order_tracking: c.cyan, account_issue: c.blue, other: c.gray };
export const intentTag = (i) => (INTENT_COLOR[i] || String)(String(i || '-').padEnd(14));

const ACTION = { draft: c.green('draft'), send: c.yellow('AUTO-SENT'), skip: c.gray('skipped'), label_only: c.yellow('label only'), error: c.red('error') };

export function formatRow(r) {
  if (r.action === 'skip') return `${c.gray('skip'.padEnd(14))} ${c.gray(String(r.from || r.messageId).slice(0, 34).padEnd(34))} ${c.gray(r.skipReason)}`;
  if (r.action === 'error' || (r.error && !r.intent)) return `${c.red('error'.padEnd(14))} ${String(r.from || r.messageId).padEnd(34)} ${c.red(r.error)}`;
  const flags = [r.escalate ? c.red('NEEDS HUMAN') : '', r.orderNumber ? `#${r.orderNumber}${r.orderVerified ? '' : c.yellow('?')}` : '', r.refund ? `refund:${r.refund.kind}` : '', r.error ? c.red(`gmail error: ${r.error}`) : '']
    .filter(Boolean)
    .join('  ');
  return `${intentTag(r.intent)} ${String(r.from).slice(0, 34).padEnd(34)} ${(ACTION[r.action] || r.action).padEnd(tty ? 19 : 10)} ${c.gray(`${r.classifiedBy}/${r.replySource || '-'}`)}  ${flags}`;
}

export function formatAnalysis({ classification: cl, lookup, decision, reply }, { showReply = true } = {}) {
  const lines = [
    `${c.bold('Intent')}      ${intentTag(cl.intent)} ${cl.sub_type}  (confidence ${cl.confidence}, by ${cl.source}${cl.model ? ` ${cl.model}` : ''})`,
    `${c.bold('Customer')}    language ${cl.language}, sentiment ${cl.sentiment}, anger ${cl.anger}/100, urgency ${cl.urgency}/100${cl.signals.length ? `, signals: ${cl.signals.join(', ')}` : ''}`,
    `${c.bold('Summary')}     ${cl.summary}`,
  ];
  if (lookup) {
    const o = lookup.order;
    lines.push(`${c.bold('Order')}       ${o ? `#${o.order_number} ${o.status}${lookup.verified ? '' : c.yellow(' (sender is not the order email: details withheld)')}` : c.yellow(lookup.error || `not found${cl.order_number ? ` (#${cl.order_number})` : ' (no order number in the email)'}`)}`);
  }
  const f = decision.facts;
  if (f.refund) lines.push(`${c.bold('Refund')}      ${f.refund.eligible === true ? c.green('eligible') : f.refund.eligible === false ? c.red('not eligible') : c.yellow('unknown')}: ${f.refund.reason}${f.refund.needsApproval ? c.yellow(' (needs approval)') : ''}`);
  if (f.tracking) lines.push(`${c.bold('Tracking')}    ${f.tracking.status}${f.tracking.carrier ? ` via ${f.tracking.carrier}` : ''}${f.tracking.tracking_number ? ` ${f.tracking.tracking_number}` : ''}${f.tracking.delayed ? c.yellow(' DELAYED') : ''}`);
  lines.push(`${c.bold('Decision')}    ${ACTION[decision.action] || decision.action}${decision.escalate ? `  ${c.red('NEEDS HUMAN')}: ${decision.reasons.join('; ')}` : ''}`);
  if (decision.action !== 'send' && decision.autoBlockers.length && !decision.autoBlockers.includes('REPLY_MODE=draft')) lines.push(c.gray(`            not auto-sent: ${decision.autoBlockers.join(', ')}`));
  if (reply && showReply) lines.push('', c.bold(`Reply (${reply.source}${reply.model ? ` ${reply.model}` : ''}):`), c.gray('─'.repeat(60)), reply.body, c.gray('─'.repeat(60)));
  return lines.join('\n');
}

export function summarize(rows) {
  const n = (f) => rows.filter(f).length;
  const handled = rows.filter((r) => r.intent);
  return `${rows.length} email(s): ${n((r) => r.action === 'draft')} drafted, ${n((r) => r.action === 'send')} auto-sent, ${n((r) => r.escalate)} need a human, ${n((r) => r.action === 'skip')} skipped, ${n((r) => r.error)} error(s). AI replies: ${n((r) => r.replySource === 'ai')}/${handled.length}.`;
}
