const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal Gmail REST client over fetch (no googleapis SDK).
 * Interface shared with the in-memory mock in ./mock.js.
 */
export function createGmailClient({ tokens, fetchImpl = fetch, retries = 2, retryDelayMs = 800 }) {
  async function call(method, path, { query, body } = {}, attempt = 0) {
    const token = await tokens.getAccessToken();
    const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) {
      await tokens.getAccessToken({ force: true });
      return call(method, path, { query, body }, attempt + 1);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get?.('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : retryDelayMs * 2 ** attempt);
      return call(method, path, { query, body }, attempt + 1);
    }
    const text = await res.text();
    const data = text ? safeJson(text) : {};
    if (!res.ok) throw new GmailError(`Gmail ${method} ${path} -> ${res.status}: ${data?.error?.message || text.slice(0, 200)}`, { status: res.status, body: data });
    return data;
  }

  return {
    kind: 'gmail',
    async getProfile() {
      return call('GET', '/profile');
    },
    async listMessages({ q, maxResults = 25 } = {}) {
      const out = [];
      let pageToken;
      do {
        const data = await call('GET', '/messages', { query: { q: q || '', maxResults: String(Math.min(100, maxResults - out.length)), ...(pageToken ? { pageToken } : {}) } });
        out.push(...(data.messages || []));
        pageToken = data.nextPageToken;
      } while (pageToken && out.length < maxResults);
      return out.slice(0, maxResults);
    },
    async getMessage(id) {
      return call('GET', `/messages/${encodeURIComponent(id)}`, { query: { format: 'full' } });
    },
    async getThread(id) {
      return call('GET', `/threads/${encodeURIComponent(id)}`, { query: { format: 'metadata', metadataHeaders: 'From' } });
    },
    async listLabels() {
      return (await call('GET', '/labels')).labels || [];
    },
    async createLabel(name) {
      return call('POST', '/labels', { body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
    },
    async modifyMessage(id, { addLabelIds = [], removeLabelIds = [] }) {
      return call('POST', `/messages/${encodeURIComponent(id)}/modify`, { body: { addLabelIds, removeLabelIds } });
    },
    async createDraft({ raw, threadId }) {
      return call('POST', '/drafts', { body: { message: { raw, threadId } } });
    },
    async sendMessage({ raw, threadId }) {
      return call('POST', '/messages/send', { body: { raw, threadId } });
    },
    async watch({ topicName, labelIds = ['INBOX'] }) {
      return call('POST', '/watch', { body: { topicName, labelIds, labelFilterBehavior: 'INCLUDE' } });
    },
  };
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}

/** Create any missing labels and return { name: id }. Nested labels use "/" (e.g. "AI/Refund"). */
export async function ensureLabels(gmail, names) {
  const existing = await gmail.listLabels();
  const map = Object.fromEntries(existing.map((l) => [l.name.toLowerCase(), l.id]));
  const out = {};
  for (const name of names) {
    // Parents first so Gmail shows them nested.
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const n = parts.slice(0, i).join('/');
      if (!map[n.toLowerCase()]) {
        try {
          const l = await gmail.createLabel(n);
          map[n.toLowerCase()] = l.id;
        } catch (err) {
          if (err.status !== 409) throw err; // 409 = created meanwhile
          const again = await gmail.listLabels();
          for (const l of again) map[l.name.toLowerCase()] = l.id;
        }
      }
    }
    out[name] = map[name.toLowerCase()];
  }
  return out;
}

/** Gmail search syntax for a label name: lower case, "/" and spaces become "-". */
export const labelQuery = (name) => `label:${name.toLowerCase().replace(/[/\s]+/g, '-')}`;
