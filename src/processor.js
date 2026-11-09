import { parseGmailMessage, skipReason, buildReply, formatAddress, parseAddress } from './email/mime.js';
import { ensureLabels, labelQuery } from './gmail/client.js';
import { lookupOrder } from './orders.js';
import { decide, labelNames } from './policy.js';

/**
 * The pipeline for one email:
 *   read -> skip automated mail -> classify -> look up order -> decide (policy) -> compose reply
 *   -> Gmail draft (or send) -> labels -> alert on escalation -> record.
 * The draft/send happens before the "Processed" label, so a failure is retried next run.
 */
export function createProcessor({ gmail, classifier, composer, orders, store, notifier, config, profile, logger, now = Date.now }) {
  const names = labelNames(config.labels.prefix);
  let labelIds = null;
  let ownAddress = '';

  async function init() {
    if (labelIds) return;
    ownAddress = (await gmail.getProfile()).emailAddress?.toLowerCase() || '';
    labelIds = await ensureLabels(gmail, Object.values(names));
  }

  /** Classify + look up + decide + compose. No side effects (used by the API and `draft`). */
  async function analyze(email, { threadCustomerMessages = 1 } = {}) {
    const classification = await classifier.classify({ from: email.from.email, subject: email.subject, text: email.text });
    const sender = email.replyTo?.email || email.from.email;
    const needsOrder = classification.intent === 'refund' || classification.intent === 'order_tracking';
    const lookup = needsOrder ? await lookupOrder(orders, { orderNumber: classification.order_number, email: sender, requireEmailMatch: config.orders.requireEmailMatch }) : null;
    const decision = decide({ classification, lookup, email, threadCustomerMessages, config, profile, now: now() });
    const reply = decision.action === 'label_only' ? null : await composer.compose({ email, facts: decision.facts, decision });
    return { classification, lookup, decision, reply };
  }

  async function countCustomerMessages(email) {
    try {
      const t = await gmail.getThread(email.threadId);
      const sender = email.from.email;
      return (t.messages || []).filter((m) => parseAddress((m.payload?.headers || []).find((h) => h.name.toLowerCase() === 'from')?.value).email === sender).length || 1;
    } catch {
      return 1;
    }
  }

  async function processMessage(id, { dryRun = false, force = false } = {}) {
    if (!force && store.has(id)) return { messageId: id, action: 'skip', skipReason: 'already processed' };
    await init();
    const email = parseGmailMessage(await gmail.getMessage(id));
    const base = { messageId: id, threadId: email.threadId, at: new Date(now()).toISOString(), from: email.from.email, subject: email.subject };

    const why = skipReason(email, { ownAddress });
    if (why) {
      if (!dryRun) {
        await gmail.modifyMessage(id, { addLabelIds: [labelIds[names.skipped], labelIds[names.processed]] });
        store.record({ ...base, action: 'skip', skipReason: why });
      }
      return { ...base, action: 'skip', skipReason: why };
    }

    const threadCustomerMessages = await countCustomerMessages(email);
    const { classification: c, lookup, decision, reply } = await analyze(email, { threadCustomerMessages });
    const row = {
      ...base,
      intent: c.intent,
      subType: c.sub_type,
      confidence: c.confidence,
      language: c.language,
      anger: c.anger,
      classifiedBy: c.source,
      model: c.model,
      orderNumber: lookup?.order?.order_number || c.order_number || null,
      orderVerified: Boolean(lookup?.verified),
      refund: decision.facts.refund ? { eligible: decision.facts.refund.eligible, kind: decision.facts.refund.kind } : undefined,
      escalate: decision.escalate,
      reasons: decision.reasons,
      summary: c.summary,
      action: decision.action,
      autoBlockers: decision.autoBlockers,
      replySource: reply?.source,
      reply: reply?.body,
    };
    if (dryRun) return { ...row, dryRun: true };

    try {
      if (reply) {
        const raw = buildReply({
          to: formatAddress(email.replyTo?.name || email.from.name, email.replyTo?.email || email.from.email),
          from: formatAddress(config.gmail.fromName || profile.company, ownAddress),
          subject: email.subject,
          body: reply.body,
          inReplyTo: email.messageId,
          references: email.references,
        });
        if (decision.action === 'send') row.sentId = (await gmail.sendMessage({ raw, threadId: email.threadId })).id;
        else row.draftId = (await gmail.createDraft({ raw, threadId: email.threadId })).id;
      }
      const add = [names[c.intent], names.processed, decision.action === 'send' ? names.auto_sent : reply ? names.drafted : null, decision.escalate ? names.needs_human : null]
        .filter(Boolean)
        .map((n) => labelIds[n]);
      if (decision.escalate) add.push('STARRED', 'IMPORTANT');
      const remove = decision.action === 'send' || config.labels.markRead ? ['UNREAD'] : [];
      await gmail.modifyMessage(id, { addLabelIds: add, removeLabelIds: remove });
    } catch (err) {
      logger.error(`[gmail] ${id}: ${err.message}`);
      return { ...row, error: err.message };
    }

    if (decision.escalate && notifier) row.alerted = await notifier.alert(row);
    const { reply: _omit, ...saved } = row;
    store.record({ ...saved, replyChars: reply?.body.length || 0 });
    return row;
  }

  /** Process new inbox mail once. Returns one row per message. */
  async function runOnce({ dryRun = false, query, limit, concurrency = 3 } = {}) {
    await init();
    const q = `${query || config.gmail.query} -${labelQuery(names.processed)}`;
    const list = await gmail.listMessages({ q, maxResults: limit || config.gmail.maxPerRun });
    // Gmail lists newest first; answer the oldest first.
    const ids = list
      .map((m) => m.id)
      .filter((id) => dryRun || !store.has(id))
      .reverse();
    const results = new Array(ids.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
        while (next < ids.length) {
          const i = next++;
          try {
            results[i] = await processMessage(ids[i], { dryRun });
          } catch (err) {
            logger.error(`[run] ${ids[i]}: ${err.message}`);
            results[i] = { messageId: ids[i], action: 'error', error: err.message };
          }
        }
      }),
    );
    return results;
  }

  return { init, analyze, processMessage, runOnce, labelNames: names, get ownAddress() { return ownAddress; } };
}
