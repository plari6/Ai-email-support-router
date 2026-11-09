import fs from 'node:fs';
import { SAMPLE_EMAILS, createApp } from '../src/index.js';
import { createMockGmail } from '../src/gmail/mock.js';
import { analyzeWithRules } from '../src/rules.js';
import { silentLogger } from '../src/logger.js';

export const samples = () => JSON.parse(fs.readFileSync(SAMPLE_EMAILS, 'utf8'));

/** Env with no real keys: AI comes only from injected fake providers. */
export const baseEnv = (extra = {}) => ({ EMAIL_ROUTER_SKIP_DOTENV: '1', AI_HEDGE_MS: '0', AI_CHAIN: 'fake:one,fake:two', ...extra });

/** Fake provider: `fn(req)` returns text, an object (JSON-encoded) or an Error. */
export function fakeProvider(fn) {
  const calls = [];
  return {
    configured: true,
    calls,
    async complete(req) {
      calls.push(req);
      const out = fn(req);
      if (out instanceof Error) throw out;
      return { text: typeof out === 'string' ? out : JSON.stringify(out) };
    },
  };
}

const isClassify = (req) => String(req.system || '').startsWith('You are the triage step');
const userText = (req) => req.messages.map((m) => m.content).join('\n');

/**
 * A well-behaved fake model: classifies with the keyword rules (as if the AI agreed) and writes a
 * reply that uses the facts it was given. `over` lets a test change either answer.
 */
export function smartFake({ classify = {}, reply } = {}) {
  return fakeProvider((req) => {
    const text = userText(req);
    if (isClassify(req)) {
      const r = analyzeWithRules({ text });
      const { source, ...rest } = r;
      return { ...rest, confidence: 0.92, ...(typeof classify === 'function' ? classify(text) : classify) };
    }
    if (reply) return typeof reply === 'function' ? reply(text, req) : reply;
    const facts = JSON.parse(text.slice(text.indexOf('{'), text.indexOf('\n\nWrite the reply')));
    const t = facts.tracking;
    const parts = [`Hi ${String(facts.customer_name || '').split(' ')[0] || 'there'},`, `Thanks for your email about your ${facts.intent.replace('_', ' ')}.`];
    if (t?.tracking_number) parts.push(`Your tracking number is ${t.tracking_number}.`);
    if (facts.refund) parts.push(`Refund check: ${facts.refund.reason}.`);
    parts.push('Best regards,\nSam');
    return { body: parts.join('\n\n') };
  });
}

export function makeApp({ env = {}, provider, emails = samples(), noAi = false, ...rest } = {}) {
  const gmail = createMockGmail({ emails });
  const app = createApp({
    env: baseEnv(env),
    noAi,
    aiProviders: provider ? { fake: provider } : undefined,
    gmail,
    store: undefined,
    demo: true,
    logger: silentLogger,
    ...rest,
  });
  return { app, gmail };
}
