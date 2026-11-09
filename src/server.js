import crypto from 'node:crypto';
import express from 'express';
import { parseAddress, cleanText } from './email/mime.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** One inbox run at a time; a request that arrives mid-run queues exactly one follow-up run. */
export function createRunner(app) {
  let running = null;
  let again = false;
  let last = null;
  async function run(opts = {}) {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          const started = Date.now();
          const results = await app.processor.runOnce(opts);
          last = { at: new Date().toISOString(), ms: Date.now() - started, processed: results.length, errors: results.filter((r) => r.error).length };
          if (results.length) app.logger.info(`[run] ${results.length} email(s): ${results.map((r) => `${r.intent || r.action}${r.escalate ? '!' : ''}`).join(', ')}`);
        } while (again);
        return last;
      } catch (err) {
        last = { at: new Date().toISOString(), error: err.message };
        app.logger.error(`[run] ${err.message}`);
        return last;
      } finally {
        running = null;
      }
    })();
    return running;
  }
  return { run, get last() { return last; }, get busy() { return Boolean(running); } };
}

export function createServer(app, { pollIntervalSec = app.config.server.pollIntervalSec } = {}) {
  const server = express();
  const runner = app.processor ? createRunner(app) : null;
  const { apiKey } = app.config.server;
  server.disable('x-powered-by');
  server.use(express.json({ limit: '1mb' }));

  const auth = (req, res, next) => {
    if (!apiKey) return next();
    const got = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    return got && safeEqual(got, apiKey) ? next() : res.status(401).json({ error: 'invalid or missing API key (x-api-key header)' });
  };

  server.get('/health', (_req, res) => {
    const ai = app.ai ? app.ai.status() : [];
    res.json({
      ok: true,
      gmail: app.gmail ? app.gmail.kind : 'not configured',
      orders: app.orders?.name || 'none',
      replyMode: app.config.reply.mode,
      ai: app.ai ? { ready: ai.filter((t) => t.state === 'ready').length, cooling: ai.filter((t) => t.state === 'cooling').length, models: ai.map((t) => ({ id: t.id, state: t.state, avgMs: t.avgMs })) } : 'disabled',
      lastRun: runner?.last || null,
    });
  });

  // Classify and draft a reply for any email (helpdesk, n8n, Make, website form). No Gmail needed.
  server.post('/api/triage', auth, async (req, res) => {
    const b = req.body || {};
    const text = cleanText(b.body || b.text || '');
    if (!text && !b.subject) return res.status(400).json({ error: 'send at least "subject" or "body"' });
    const from = parseAddress(b.from || '');
    if (b.name) from.name = b.name;
    try {
      const email = { from, replyTo: null, subject: b.subject || '', text };
      const { classification, lookup, decision, reply } = await app.analyze(email, { threadCustomerMessages: Number(b.previousMessages || 0) + 1 });
      res.json({
        classification,
        order: lookup?.verified ? lookup.order : lookup?.found ? 'found but sender does not match the order email' : null,
        decision: { action: decision.action, escalate: decision.escalate, reasons: decision.reasons, refund: decision.facts.refund || null, tracking: decision.facts.tracking || null },
        reply,
      });
    } catch (err) {
      app.logger.error(`[api] triage: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  server.post('/api/run', auth, async (req, res) => {
    if (!runner) return res.status(503).json({ error: 'Gmail is not configured' });
    if (req.body?.dryRun) return res.json({ results: await app.processor.runOnce({ dryRun: true, limit: Number(req.body.limit) || undefined }) });
    res.json(await runner.run());
  });

  // Gmail push (Pub/Sub push subscription to https://host/webhooks/gmail?token=GMAIL_PUSH_TOKEN).
  // The notification only says "something changed", so we answer 204 at once and run the inbox query.
  server.post('/webhooks/gmail', (req, res) => {
    const token = app.config.gmail.pushToken;
    if (!token) return res.status(503).json({ error: 'set GMAIL_PUSH_TOKEN to accept Gmail push notifications' });
    if (!safeEqual(req.query.token || '', token)) return res.status(401).end();
    res.status(204).end();
    if (runner) runner.run();
  });

  server.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.type === 'entity.parse.failed' ? 'invalid JSON body' : err.message });
  });

  let timer = null;
  const origListen = server.listen.bind(server);
  server.listen = (...args) => {
    const http = origListen(...args);
    if (runner && pollIntervalSec > 0) {
      timer = setInterval(() => runner.run(), pollIntervalSec * 1000);
      timer.unref();
      runner.run();
    }
    http.on('close', () => timer && clearInterval(timer));
    return http;
  };
  server.runner = runner;
  return server;
}
