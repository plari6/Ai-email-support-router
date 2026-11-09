import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { createRouterFromEnv } from './ai/index.js';
import { createTokenProvider } from './gmail/auth.js';
import { createGmailClient } from './gmail/client.js';
import { createMockGmail } from './gmail/mock.js';
import { createClassifier } from './classifier.js';
import { createComposer } from './composer.js';
import { createOrderSource, createJsonOrderSource } from './orders.js';
import { createProcessor } from './processor.js';
import { createNotifier } from './notify.js';
import { createStore } from './store.js';
import { createLogger } from './logger.js';

export const EXAMPLES = path.join(PROJECT_ROOT, 'examples');
export const SAMPLE_EMAILS = path.join(EXAMPLES, 'sample-emails.json');

export function loadProfile(file) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!p.company) throw new Error(`${file}: "company" is required`);
  return p;
}

/**
 * Build everything from env. Options let tests and the demo inject fakes:
 *  noAi, simulate[], aiProviders, gmail (client or mock), orders, store (or null file), fetchImpl, now
 */
export function createApp({ env = process.env, noAi = false, simulate = [], aiProviders, gmail, orders, store, demo = false, logger = createLogger(), fetchImpl = fetch, now } = {}) {
  const config = loadConfig(env);
  const profile = loadProfile(config.businessFile);
  const ai =
    noAi || config.ai.disabled
      ? null
      : createRouterFromEnv(env, {
          fetchImpl,
          simulate,
          providers: aiProviders,
          onEvent: (e) => {
            if (e.type === 'failure') logger.warn(`[ai] ${e.target} ${e.kind} -> next model`);
            else if (e.type === 'success') logger.debug(`[ai] ${e.target} ok in ${e.ms} ms`);
          },
        });

  const orderSource = orders !== undefined ? orders : demo ? createJsonOrderSource(path.join(EXAMPLES, 'orders.json')) : createOrderSource(config, { fetchImpl });
  let gmailClient = gmail;
  if (!gmailClient && demo) gmailClient = createMockGmail({ emails: JSON.parse(fs.readFileSync(SAMPLE_EMAILS, 'utf8')) });
  if (!gmailClient) {
    const tokens = createTokenProvider({ ...config.gmail, fetchImpl });
    if (tokens.configured) gmailClient = createGmailClient({ tokens, fetchImpl });
  }
  const st = store !== undefined ? store : createStore(demo ? null : path.join(config.dataDir, 'state.json'));
  const notifier = createNotifier({ ...config.notify, fetchImpl, logger });
  const classifier = createClassifier({ ai, logger });
  const composer = createComposer({ ai, profile, logger });
  const processor = gmailClient ? createProcessor({ gmail: gmailClient, classifier, composer, orders: orderSource, store: st, notifier, config, profile, logger, now }) : null;

  // Classify + draft without Gmail (CLI `draft`, POST /api/triage). Same pipeline, no side effects.
  const offline = createProcessor({ gmail: null, classifier, composer, orders: orderSource, store: st, notifier, config, profile, logger, now });

  return { config, profile, ai, gmail: gmailClient, orders: orderSource, store: st, notifier, classifier, composer, processor, analyze: offline.analyze, logger };
}

export { createServer } from './server.js';
