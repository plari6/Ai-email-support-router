import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function readTokenFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeTokenFile(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(token, null, 2), { mode: 0o600 });
}

/**
 * Access tokens from a refresh token (env GMAIL_REFRESH_TOKEN or the token file written by `auth`).
 * Tokens are cached until a minute before they expire.
 */
export function createTokenProvider({ clientId, clientSecret, refreshToken, tokenFile, fetchImpl = fetch, now = Date.now }) {
  let cached = null;
  const getRefresh = () => refreshToken || readTokenFile(tokenFile)?.refresh_token || '';
  return {
    get configured() {
      return Boolean(clientId && clientSecret && getRefresh());
    },
    async getAccessToken({ force = false } = {}) {
      if (!force && cached && cached.expiresAt - 60_000 > now()) return cached.token;
      const rt = getRefresh();
      if (!clientId || !clientSecret || !rt) throw new Error('Gmail is not authorised: set GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET and run `email-router auth`');
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: rt, grant_type: 'refresh_token' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint = data.error === 'invalid_grant' ? ' (refresh token expired or revoked: run `email-router auth` again; apps in "Testing" mode expire tokens after 7 days)' : '';
        throw new Error(`Google token refresh failed: ${data.error || res.status} ${data.error_description || ''}${hint}`.trim());
      }
      cached = { token: data.access_token, expiresAt: now() + (data.expires_in || 3600) * 1000 };
      return cached.token;
    },
  };
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function buildAuthUrl({ clientId, redirectUri, state, codeChallenge, scopes = GMAIL_SCOPES }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${q}`;
}

/**
 * Desktop OAuth (loopback + PKCE): open the printed URL, sign in, and the refresh token is saved.
 * Resolves with the token response.
 */
export async function runAuthFlow({ clientId, clientSecret, port, tokenFile, log = console.log, fetchImpl = fetch, timeoutMs = 5 * 60_000 }) {
  if (!clientId || !clientSecret) throw new Error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first (OAuth client type "Desktop app")');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(12));
  const redirectUri = `http://127.0.0.1:${port}`;

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/') return res.writeHead(404).end();
      const err = u.searchParams.get('error');
      const ok = !err && u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ok ? '<h2>Gmail connected. You can close this tab.</h2>' : `<h2>Sign-in failed: ${err || 'state mismatch'}</h2>`);
      clearTimeout(timer);
      server.close();
      ok ? resolve(ok) : reject(new Error(`Google sign-in failed: ${err || 'state mismatch'}`));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for Google sign-in'));
    }, timeoutMs);
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(`\nOpen this URL in a browser signed in to the support mailbox:\n\n${buildAuthUrl({ clientId, redirectUri, state, codeChallenge: challenge })}\n`);
      log(`Waiting for Google to redirect to ${redirectUri} ...`);
    });
  });

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) throw new Error(`Token exchange failed: ${data.error || res.status} ${data.error_description || '(no refresh_token returned)'}`);
  writeTokenFile(tokenFile, { refresh_token: data.refresh_token, scope: data.scope, created_at: new Date().toISOString() });
  return data;
}
