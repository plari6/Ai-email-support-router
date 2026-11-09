import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load `.env` from the current folder first, then from the project folder.
 * Values already in the environment win. EMAIL_ROUTER_SKIP_DOTENV=1 disables both (tests).
 */
export function loadDotenv(env = process.env) {
  if (env.EMAIL_ROUTER_SKIP_DOTENV === '1') return [];
  const loaded = [];
  for (const file of [path.resolve(process.cwd(), '.env'), path.join(PROJECT_ROOT, '.env')]) {
    if (!loaded.includes(file) && fs.existsSync(file)) {
      dotenv.config({ path: file, processEnv: env, quiet: true });
      loaded.push(file);
    }
  }
  return loaded;
}

const num = (v, d) => {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const list = (v, d = []) =>
  v === undefined || v === ''
    ? d
    : String(v)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
const resolve = (p) => (p ? path.resolve(PROJECT_ROOT, p) : '');

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(PROJECT_ROOT, 'data'));
  const labelPrefix = (env.LABEL_PREFIX ?? 'AI').trim();
  return {
    gmail: {
      clientId: (env.GMAIL_CLIENT_ID || '').trim(),
      clientSecret: (env.GMAIL_CLIENT_SECRET || '').trim(),
      refreshToken: (env.GMAIL_REFRESH_TOKEN || '').trim(),
      tokenFile: path.resolve(env.GMAIL_TOKEN_FILE || path.join(dataDir, 'gmail-token.json')),
      authPort: num(env.GMAIL_AUTH_PORT, 53682),
      // Gmail search for new support mail. The processed label is excluded automatically.
      query: env.GMAIL_QUERY || 'in:inbox is:unread newer_than:7d -category:promotions -category:social',
      maxPerRun: Math.max(1, num(env.GMAIL_MAX_PER_RUN, 25)),
      pubsubTopic: (env.GMAIL_PUBSUB_TOPIC || '').trim(),
      pushToken: (env.GMAIL_PUSH_TOKEN || '').trim(),
      fromName: (env.REPLY_FROM_NAME || '').trim(),
    },
    labels: {
      prefix: labelPrefix,
      markRead: bool(env.MARK_READ, false),
    },
    reply: {
      // draft = always leave a Gmail draft for an agent to review and send (safe default)
      // send  = send automatically when the safety checks pass, otherwise draft
      mode: (env.REPLY_MODE || 'draft').trim().toLowerCase() === 'send' ? 'send' : 'draft',
      autoSendIntents: list(env.AUTO_SEND_INTENTS, ['order_tracking']),
      autoSendMinConfidence: num(env.AUTO_SEND_MIN_CONFIDENCE, 0.85),
      draftOnEscalation: bool(env.DRAFT_ON_ESCALATION, true),
    },
    escalation: {
      vipDomains: list(env.VIP_DOMAINS),
      vipEmails: list(env.VIP_EMAILS),
      angerThreshold: num(env.ESCALATE_ANGER, 75),
    },
    orders: {
      source: (env.ORDERS_SOURCE || '').trim().toLowerCase(), // json | http | shopify | none ('' = auto)
      file: resolve(env.ORDERS_FILE || 'examples/orders.json'),
      apiUrl: (env.ORDERS_API_URL || '').trim(),
      apiToken: (env.ORDERS_API_TOKEN || '').trim(),
      shopifyShop: (env.SHOPIFY_SHOP || '').trim().replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, ''),
      shopifyToken: (env.SHOPIFY_ACCESS_TOKEN || '').trim(),
      shopifyApiVersion: (env.SHOPIFY_API_VERSION || '2025-10').trim(),
      requireEmailMatch: bool(env.REQUIRE_EMAIL_MATCH, true),
    },
    businessFile: resolve(env.BUSINESS_FILE || 'examples/business.json'),
    notify: {
      slackWebhookUrl: (env.SLACK_WEBHOOK_URL || '').trim(),
      webhookUrl: (env.ALERT_WEBHOOK_URL || '').trim(),
    },
    server: {
      port: num(env.PORT, 3000),
      apiKey: (env.API_KEY || '').trim(),
      pollIntervalSec: num(env.POLL_INTERVAL_SEC, 0),
    },
    dataDir,
    ai: { disabled: bool(env.AI_DISABLED) },
  };
}

/** Problems that stop live Gmail work. */
export function gmailProblems(config, { hasTokenFile = fs.existsSync(config.gmail.tokenFile) } = {}) {
  const g = config.gmail;
  const out = [];
  if (!g.clientId || !g.clientSecret) out.push('GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are missing (Google Cloud > APIs & Services > Credentials > OAuth client "Desktop app")');
  if (!g.refreshToken && !hasTokenFile) out.push('No Gmail refresh token yet: run `email-router auth` once to sign in');
  return out;
}
