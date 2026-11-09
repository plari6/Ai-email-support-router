import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { PROJECT_ROOT } from '../src/config.js';
import { makeApp } from './helpers.js';

async function withServer(app, fn) {
  const http = createServer(app, { pollIntervalSec: 0 }).listen(0);
  await new Promise((r) => http.once('listening', r));
  const base = `http://127.0.0.1:${http.address().port}`;
  try {
    await fn(base);
  } finally {
    http.close();
  }
}

test('GET /health and POST /api/triage with API key', async () => {
  const { app } = makeApp({ noAi: true, env: { API_KEY: 'secret' } });
  await withServer(app, async (base) => {
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.gmail, 'mock');
    const body = JSON.stringify({ from: 'Emma Wilson <emma.wilson@example.com>', subject: 'where', body: 'Where is my order #1001?' });
    assert.equal((await fetch(`${base}/api/triage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401);
    const r = await (await fetch(`${base}/api/triage`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'secret' }, body })).json();
    assert.equal(r.classification.intent, 'order_tracking');
    assert.equal(r.order.order_number, '1001');
    assert.match(r.reply.body, /1Z999AA10123456784/);
    const bad = await fetch(`${base}/api/triage`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'secret' }, body: '{nope' });
    assert.equal(bad.status, 400);
  });
});

test('Gmail push webhook checks the token and triggers a run', async () => {
  const { app, gmail } = makeApp({ noAi: true, env: { GMAIL_PUSH_TOKEN: 'tok123' } });
  const server = createServer(app, { pollIntervalSec: 0 });
  const http = server.listen(0);
  await new Promise((r) => http.once('listening', r));
  const base = `http://127.0.0.1:${http.address().port}`;
  try {
    assert.equal((await fetch(`${base}/webhooks/gmail?token=wrong`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/webhooks/gmail?token=tok123`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":{"data":"e30="}}' })).status, 204);
    for (let i = 0; i < 50 && (server.runner.busy || !server.runner.last); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(server.runner.last.processed, 16);
    assert.equal(gmail.drafts.length, 14);
  } finally {
    http.close();
  }
});

const cli = (...args) =>
  spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'bin', 'email-router.js'), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, EMAIL_ROUTER_SKIP_DOTENV: '1', NO_COLOR: '1', DATA_DIR: path.join(PROJECT_ROOT, 'test', '.tmp-data') },
  });

test('CLI: demo, classify and draft work with no accounts', () => {
  const demo = cli('--no-ai', 'demo', '--json');
  assert.equal(demo.status, 0, demo.stderr);
  const d = JSON.parse(demo.stdout);
  assert.equal(d.drafts, 14);

  const c = cli('--no-ai', 'classify', '--json', 'I was charged twice for order #1005');
  assert.equal(c.status, 0, c.stderr);
  assert.equal(JSON.parse(c.stdout).sub_type, 'double_charge');

  const dr = cli('--no-ai', 'draft', '--from', 'Noah Brown <noah.brown@example.com>', 'Can I get a refund for order 1004?');
  assert.equal(dr.status, 0, dr.stderr);
  assert.match(dr.stdout, /not eligible/);
  assert.match(dr.stdout, /outside our 30-day return window/);
});

test('CLI: run without Gmail explains how to connect', () => {
  const r = cli('--no-ai', 'run');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /GMAIL_CLIENT_ID/);
});
