/** Escalation alerts to Slack and/or any JSON webhook (n8n, Make, Zapier, Teams). Never throws. */

export function buildAlert(row, { gmailUrl } = {}) {
  return {
    type: 'email_escalation',
    at: row.at,
    from: row.from,
    subject: row.subject,
    intent: row.intent,
    subType: row.subType,
    orderNumber: row.orderNumber,
    anger: row.anger,
    reasons: row.reasons,
    summary: row.summary,
    action: row.action,
    link: gmailUrl || `https://mail.google.com/mail/u/0/#inbox/${row.threadId}`,
  };
}

export function alertText(a) {
  return `:rotating_light: *Support email needs a human* (${a.intent}${a.subType ? ` / ${a.subType}` : ''})\n*From:* ${a.from}\n*Subject:* ${a.subject}\n*Why:* ${a.reasons.join('; ')}\n*Summary:* ${a.summary || '-'}${a.orderNumber ? `\n*Order:* #${a.orderNumber}` : ''}\n${a.action === 'draft' ? 'A draft reply is ready in Gmail.' : ''} <${a.link}|Open in Gmail>`;
}

export function createNotifier({ slackWebhookUrl, webhookUrl, fetchImpl = fetch, logger }) {
  const post = async (url, body) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${res.status}`);
  };
  return {
    channels: [slackWebhookUrl && 'slack', webhookUrl && 'webhook'].filter(Boolean),
    async alert(row) {
      const a = buildAlert(row);
      const sent = [];
      for (const [name, fn] of [
        ['slack', slackWebhookUrl && (() => post(slackWebhookUrl, { text: alertText(a) }))],
        ['webhook', webhookUrl && (() => post(webhookUrl, a))],
      ]) {
        if (!fn) continue;
        try {
          await fn();
          sent.push(name);
        } catch (err) {
          logger?.warn(`[alert] ${name} failed: ${err.message}`);
        }
      }
      return sent;
    },
  };
}
