#!/usr/bin/env node
import fs from 'node:fs';
import { Command } from 'commander';
import { loadDotenv, loadConfig, gmailProblems } from '../src/config.js';
import { createApp, createServer } from '../src/index.js';
import { runAuthFlow } from '../src/gmail/auth.js';
import { ensureLabels } from '../src/gmail/client.js';
import { labelNames } from '../src/policy.js';
import { cleanText, parseAddress } from '../src/email/mime.js';
import { formatAnalysis, formatRow, summarize, c } from '../src/format.js';
import { createLogger } from '../src/logger.js';

loadDotenv();

const program = new Command();
program
  .name('email-router')
  .description('AI Email Support Router: sorts Gmail support mail (refunds, order tracking, account issues) and drafts grounded replies.')
  .version('1.0.0')
  .option('--no-ai', 'keyword rules + templates only (no LLM calls)')
  .option('--simulate-outage <providers>', 'pretend these AI providers are down, e.g. "gemini" or "gemini,groq"')
  .option('-v, --verbose', 'debug logging');

function build(cmd, extra = {}) {
  const o = cmd.optsWithGlobals();
  const level = o.verbose ? 'debug' : o.json ? 'error' : process.env.LOG_LEVEL || 'info';
  return { o, app: createApp({ noAi: o.ai === false, simulate: o.simulateOutage ? String(o.simulateOutage).split(',') : [], logger: createLogger(level), ...extra }) };
}

function requireGmail(app) {
  if (app.processor) return;
  console.error(c.red('Gmail is not connected:'));
  for (const p of gmailProblems(app.config)) console.error(`  - ${p}`);
  console.error('See README "Connect Gmail", or try `email-router demo` (no account needed).');
  process.exit(2);
}

const out = (o, value, human) => console.log(o.json ? JSON.stringify(value, null, 2) : human());

function readText(words, o) {
  let text = words.join(' ');
  if (o.file) text = fs.readFileSync(o.file, 'utf8');
  if (!text && !process.stdin.isTTY) text = fs.readFileSync(0, 'utf8');
  return cleanText(text);
}

program
  .command('auth')
  .description('sign in to the support Gmail account once (saves a refresh token)')
  .action(async () => {
    const cfg = loadConfig();
    try {
      const t = await runAuthFlow({ clientId: cfg.gmail.clientId, clientSecret: cfg.gmail.clientSecret, port: cfg.gmail.authPort, tokenFile: cfg.gmail.tokenFile });
      console.log(c.green(`\nGmail connected. Refresh token saved to ${cfg.gmail.tokenFile}`));
      console.log(c.gray(`(For servers/Docker you can instead set GMAIL_REFRESH_TOKEN=${t.refresh_token.slice(0, 6)}... from that file.)`));
    } catch (err) {
      console.error(c.red(err.message));
      process.exit(1);
    }
  });

program
  .command('classify')
  .description('classify one email text (no Gmail needed)')
  .argument('[text...]', 'email text (or --file / stdin)')
  .option('-s, --subject <subject>', 'subject', '')
  .option('-f, --file <path>', 'read the text from a file')
  .option('--json', 'JSON output')
  .action(async (words, _x, cmd) => {
    const { o, app } = build(cmd);
    const text = readText(words, o);
    if (!text && !o.subject) {
      console.error('Nothing to classify. Example: email-router classify "Where is my order #1001?"');
      process.exit(2);
    }
    const r = await app.classifier.classify({ subject: o.subject, text });
    out(o, r, () => `${c.bold(r.intent)} / ${r.sub_type}  confidence ${r.confidence}  by ${r.source}${r.model ? ` (${r.model})` : ''}\norder: ${r.order_number || '-'}  language: ${r.language}  anger: ${r.anger}  signals: ${r.signals.join(', ') || '-'}\n${r.summary}`);
  });

program
  .command('draft')
  .description('full pipeline for one email text: classify, look up the order, apply policy, write the reply (no Gmail needed)')
  .argument('[text...]', 'email text (or --file / stdin)')
  .option('-s, --subject <subject>', 'subject', '')
  .option('--from <address>', 'sender, e.g. "Jane Doe <jane@example.com>" (used to verify the order)', '')
  .option('-f, --file <path>', 'read the text from a file')
  .option('--json', 'JSON output')
  .action(async (words, _x, cmd) => {
    const { o, app } = build(cmd);
    const text = readText(words, o);
    if (!text && !o.subject) {
      console.error('Nothing to draft. Example: email-router draft --from "Emma <emma.wilson@example.com>" "Where is my order #1001?"');
      process.exit(2);
    }
    const r = await app.analyze({ from: parseAddress(o.from), replyTo: null, subject: o.subject, text });
    out(o, r, () => formatAnalysis(r));
  });

program
  .command('run')
  .description('process new inbox mail once')
  .option('--dry-run', 'analyse and show replies, but do not create drafts, send, label or alert')
  .option('-q, --query <gmail query>', 'Gmail search (default GMAIL_QUERY)')
  .option('-l, --limit <n>', 'max emails', (v) => Number(v))
  .option('--show-replies', 'print each reply')
  .option('--json', 'JSON output')
  .action(async (_x, cmd) => {
    const { o, app } = build(cmd);
    requireGmail(app);
    const rows = await app.processor.runOnce({ dryRun: Boolean(o.dryRun), query: o.query, limit: o.limit });
    out(o, rows, () => printRows(rows, { showReplies: o.showReplies || o.dryRun, dryRun: o.dryRun }));
  });

program
  .command('message')
  .description('process one Gmail message by id')
  .argument('<id>', 'Gmail message id')
  .option('--dry-run', 'do not change Gmail')
  .option('--force', 'process even if it was handled before')
  .option('--json', 'JSON output')
  .action(async (id, _x, cmd) => {
    const { o, app } = build(cmd);
    requireGmail(app);
    const r = await app.processor.processMessage(id, { dryRun: Boolean(o.dryRun), force: Boolean(o.force) });
    out(o, r, () => printRows([r], { showReplies: true, dryRun: o.dryRun }));
  });

program
  .command('watch')
  .description('poll the inbox every N seconds (no public URL needed)')
  .option('-i, --interval <sec>', 'seconds between runs', (v) => Number(v), 120)
  .option('--dry-run', 'do not change Gmail')
  .action(async (_x, cmd) => {
    const { o, app } = build(cmd);
    requireGmail(app);
    const every = Math.max(30, o.interval);
    console.log(c.gray(`Watching ${app.config.gmail.query} every ${every}s (Ctrl+C to stop)`));
    for (;;) {
      try {
        const rows = await app.processor.runOnce({ dryRun: Boolean(o.dryRun) });
        if (rows.length) printRows(rows, { dryRun: o.dryRun });
      } catch (err) {
        console.error(c.red(`[watch] ${err.message}`));
      }
      await new Promise((r) => setTimeout(r, every * 1000));
    }
  });

program
  .command('serve')
  .description('HTTP server: GET /health, POST /api/triage, POST /api/run, POST /webhooks/gmail (Pub/Sub push)')
  .option('-p, --port <port>', 'port', (v) => Number(v))
  .option('--demo', 'use the in-memory demo inbox and sample orders')
  .action(async (_x, cmd) => {
    const { o, app } = build(cmd, { demo: Boolean(cmd.opts().demo) });
    const port = o.port || app.config.server.port;
    createServer(app).listen(port, () => {
      console.log(`email-router listening on http://localhost:${port}  (gmail: ${app.gmail?.kind || c.yellow('not configured')}, orders: ${app.orders?.name || 'none'}, reply mode: ${app.config.reply.mode}, polling: ${app.config.server.pollIntervalSec ? `${app.config.server.pollIntervalSec}s` : 'off'})`);
      if (!app.config.server.apiKey) console.log(c.yellow('API_KEY is not set: /api/* is open. Set it before exposing the server.'));
    });
  });

program
  .command('labels')
  .description('create the Gmail labels used by the router')
  .action(async (_x, cmd) => {
    const { app } = build(cmd);
    requireGmail(app);
    const ids = await ensureLabels(app.gmail, Object.values(labelNames(app.config.labels.prefix)));
    for (const [n, id] of Object.entries(ids)) console.log(`${c.green('✓')} ${n.padEnd(22)} ${c.gray(id)}`);
  });

program
  .command('gmail-watch')
  .description('register Gmail push notifications to GMAIL_PUBSUB_TOPIC (renew at least every 7 days)')
  .action(async (_x, cmd) => {
    const { app } = build(cmd);
    requireGmail(app);
    if (!app.config.gmail.pubsubTopic) {
      console.error('Set GMAIL_PUBSUB_TOPIC=projects/<project>/topics/<topic> first (see README "Real-time push").');
      process.exit(2);
    }
    const r = await app.gmail.watch({ topicName: app.config.gmail.pubsubTopic });
    console.log(c.green(`Watching INBOX. Expires ${new Date(Number(r.expiration)).toISOString()} (historyId ${r.historyId}).`));
  });

program
  .command('doctor')
  .description('check Gmail, order source, business profile, alerts and AI models')
  .option('--ping', 'send a tiny prompt to every AI model')
  .action(async (_x, cmd) => {
    const { o, app } = build(cmd);
    const ok = (b, label, detail = '') => console.log(`${b === true ? c.green('✓') : b === false ? c.red('✗') : c.yellow('!')} ${label}${detail ? c.gray(`  ${detail}`) : ''}`);
    ok(true, `Business profile`, `${app.profile.company} (${app.config.businessFile})`);
    if (app.gmail) {
      try {
        const p = await app.gmail.getProfile();
        ok(true, 'Gmail', `${p.emailAddress}, ${p.messagesTotal} messages`);
      } catch (err) {
        ok(false, 'Gmail', err.message);
      }
    } else gmailProblems(app.config).forEach((p) => ok(false, 'Gmail', p));
    if (app.orders) {
      try {
        await app.orders.findByNumber('0000000');
        ok(true, 'Orders', app.orders.name);
      } catch (err) {
        ok(false, 'Orders', `${app.orders.name}: ${err.message}`);
      }
    } else ok(null, 'Orders', 'no source: replies will ask for details instead of quoting order status');
    ok(app.notifier.channels.length ? true : null, 'Escalation alerts', app.notifier.channels.join(', ') || 'none (set SLACK_WEBHOOK_URL or ALERT_WEBHOOK_URL)');
    ok(true, 'Reply mode', app.config.reply.mode === 'send' ? `send (auto-send: ${app.config.reply.autoSendIntents.join(', ')} at confidence >= ${app.config.reply.autoSendMinConfidence})` : 'draft (agent reviews every reply)');
    if (!app.ai) return ok(null, 'AI', 'disabled: keyword rules + templates');
    for (const t of app.ai.status()) {
      if (!t.enabled) {
        console.log(`${c.gray('-')} ${t.id.padEnd(48)} ${c.gray(t.disabledReason || 'disabled')}`);
        continue;
      }
      if (!o.ping) {
        console.log(`${c.green('•')} ${t.id.padEnd(48)} ${c.gray('configured')}`);
        continue;
      }
      const started = Date.now();
      try {
        await app.ai.generate({ only: t.id, messages: [{ role: 'user', content: 'Reply with the word OK.' }], maxTokens: 1024, timeoutMs: 20_000 });
        console.log(`${c.green('✓')} ${t.id.padEnd(48)} ${Date.now() - started} ms`);
      } catch (err) {
        console.log(`${c.red('✗')} ${t.id.padEnd(48)} ${c.red(err.kind || '')} ${c.gray(String(err.message).slice(0, 90))}`);
      }
    }
  });

program
  .command('demo')
  .description('run the full pipeline on sample emails with an in-memory Gmail and sample orders (no accounts needed)')
  .option('--show-replies', 'print every reply')
  .option('--json', 'JSON output')
  .action(async (_x, cmd) => {
    const { o, app } = build(cmd, { demo: true });
    const rows = await app.processor.runOnce({ limit: 50 });
    if (o.json) return out(o, { rows, drafts: app.gmail.drafts.length, sent: app.gmail.sent.length }, () => '');
    console.log(c.bold(`\nDemo inbox: ${app.gmail.messages.length} emails  (AI: ${app.ai ? `${app.ai.enabledCount} model(s) with keys` : 'off'}, orders: sample file)\n`));
    printRows(rows, { showReplies: o.showReplies });
    console.log(c.gray(`\nIn Gmail this would leave ${app.gmail.drafts.length} draft(s) and ${app.gmail.sent.length} sent repl(ies). Labels used: ${[...new Set(app.gmail.messages.flatMap((m) => m.labelIds).map((id) => app.gmail.labelName(id)).filter((n) => n?.includes('/')))].join(', ')}`));
    if (!o.showReplies) console.log(c.gray('Add --show-replies to read every reply, or try: email-router --simulate-outage gemini demo'));
  });

program
  .command('stats')
  .description('totals from the local history')
  .option('-d, --days <n>', 'look back N days', (v) => Number(v), 7)
  .option('--json', 'JSON output')
  .action(async (_x, cmd) => {
    const { o, app } = build(cmd);
    const s = app.store.stats({ sinceMs: Date.now() - o.days * 864e5 });
    out(o, s, () =>
      [
        c.bold(`Last ${o.days} day(s): ${s.emails} email(s)`),
        `intents     ${JSON.stringify(s.intents)}`,
        `actions     ${JSON.stringify(s.actions)}`,
        `replies by  ${JSON.stringify(s.replySources)}`,
        `escalated   ${s.escalated}    auto-sent ${s.autoSent}    skipped ${s.skipped}    errors ${s.errors}`,
        c.green(`~${Math.round(s.estimatedMinutesSaved / 6) / 10} agent hours saved (6 min per reply)`),
      ].join('\n'),
    );
  });

program
  .command('history')
  .description('recent handled emails')
  .option('-l, --limit <n>', 'rows', (v) => Number(v), 20)
  .option('--json', 'JSON output')
  .action(async (_x, cmd) => {
    const { o, app } = build(cmd);
    const rows = app.store.history({ limit: o.limit });
    out(o, rows, () => (rows.length ? rows.map((r) => `${c.gray(r.at.slice(0, 16).replace('T', ' '))} ${formatRow(r)}`).join('\n') : 'No history yet.'));
  });

function printRows(rows, { showReplies = false, dryRun = false } = {}) {
  if (!rows.length) return console.log('No new emails.');
  for (const r of rows) {
    console.log(formatRow(r));
    if (r.subject && r.intent) console.log(c.gray(`               "${r.subject}"${r.escalate ? `  -> ${r.reasons.join('; ')}` : ''}`));
    if (showReplies && r.reply) console.log(`\n${r.reply.replace(/^/gm, '    ')}\n`);
  }
  console.log(`\n${summarize(rows)}${dryRun ? c.yellow('  (dry run: Gmail not changed)') : ''}`);
}

program.parseAsync().catch((err) => {
  console.error(c.red(err.message));
  process.exit(1);
});
