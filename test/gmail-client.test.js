import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGmailClient, ensureLabels, labelQuery } from '../src/gmail/client.js';
import { createTokenProvider, buildAuthUrl, writeTokenFile } from '../src/gmail/auth.js';

const json = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => body, text: async () => JSON.stringify(body) });

test('token provider refreshes, caches and explains invalid_grant', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'er-'));
  const file = path.join(dir, 'tok.json');
  writeTokenFile(file, { refresh_token: 'r1' });
  let calls = 0;
  let t = 0;
  const tokens = createTokenProvider({
    clientId: 'id',
    clientSecret: 's',
    tokenFile: file,
    now: () => t,
    fetchImpl: async (_u, o) => {
      calls++;
      assert.equal(o.body.get('refresh_token'), 'r1');
      return json(200, { access_token: `a${calls}`, expires_in: 3600 });
    },
  });
  assert.equal(tokens.configured, true);
  assert.equal(await tokens.getAccessToken(), 'a1');
  assert.equal(await tokens.getAccessToken(), 'a1');
  t = 3600_000;
  assert.equal(await tokens.getAccessToken(), 'a2');
  const bad = createTokenProvider({ clientId: 'id', clientSecret: 's', refreshToken: 'x', fetchImpl: async () => json(400, { error: 'invalid_grant' }) });
  await assert.rejects(bad.getAccessToken(), /run `email-router auth` again/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('auth URL asks for offline gmail.modify access with PKCE', () => {
  const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:1', state: 'st', codeChallenge: 'cc' }));
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.modify');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
});

test('client retries 401 with a fresh token and 429 with backoff, and pages lists', async () => {
  const seen = [];
  let forced = 0;
  const tokens = { getAccessToken: async ({ force } = {}) => (force ? (forced++, 'fresh') : forced ? 'fresh' : 'old') };
  const replies = [json(401, {}), json(429, {}, { 'retry-after': '0' }), json(200, { messages: [{ id: '1' }], nextPageToken: 'p2' }), json(200, { messages: [{ id: '2' }] })];
  const gmail = createGmailClient({
    tokens,
    retryDelayMs: 1,
    fetchImpl: async (u, o) => {
      seen.push([u, o.headers.authorization]);
      return replies.shift();
    },
  });
  const list = await gmail.listMessages({ q: 'in:inbox', maxResults: 10 });
  assert.deepEqual(list.map((m) => m.id), ['1', '2']);
  assert.equal(seen[0][1], 'Bearer old');
  assert.equal(seen[1][1], 'Bearer fresh');
  assert.match(seen[3][0], /pageToken=p2/);
  const err = createGmailClient({ tokens, retries: 0, fetchImpl: async () => json(403, { error: { message: 'Insufficient Permission' } }) });
  await assert.rejects(err.getProfile(), (e) => e.status === 403 && /Insufficient Permission/.test(e.message));
});

test('ensureLabels creates nested labels once', async () => {
  const labels = [{ id: 'L1', name: 'AI' }];
  const created = [];
  const gmail = {
    listLabels: async () => labels,
    createLabel: async (name) => {
      created.push(name);
      const l = { id: `L${labels.length + 1}`, name };
      labels.push(l);
      return l;
    },
  };
  const ids = await ensureLabels(gmail, ['AI/Refund', 'AI/Needs Human']);
  assert.deepEqual(created, ['AI/Refund', 'AI/Needs Human']);
  assert.equal(ids['AI/Refund'], 'L2');
  await ensureLabels(gmail, ['AI/Refund']);
  assert.equal(created.length, 2);
  assert.equal(labelQuery('AI/Needs Human'), 'label:ai-needs-human');
});
