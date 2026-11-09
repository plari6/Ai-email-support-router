import { b64urlDecode, b64urlEncode } from '../email/mime.js';

/**
 * In-memory Gmail with the same interface as createGmailClient. Used by `demo` and tests.
 * Seed it with simple emails: { from, subject, body, html?, headers?, threadId?, labels? }.
 * Understands the query terms the router uses: in:inbox, is:unread, label:x, -label:x.
 */
export function createMockGmail({ address = 'support@demo-shop.com', emails = [], failOn = {} } = {}) {
  const labels = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { id: 'STARRED', name: 'STARRED', type: 'system' },
    { id: 'IMPORTANT', name: 'IMPORTANT', type: 'system' },
  ];
  const messages = [];
  const drafts = [];
  const sent = [];
  let seq = 0;

  function add(e) {
    seq += 1;
    const id = e.id || `m${String(seq).padStart(4, '0')}`;
    const headers = [
      { name: 'From', value: e.from },
      { name: 'To', value: e.to || address },
      { name: 'Subject', value: e.subject || '' },
      { name: 'Date', value: new Date(Date.now() - (100 - seq) * 60_000).toUTCString() },
      { name: 'Message-ID', value: `<${id}@mail.example>` },
      ...Object.entries(e.headers || {}).map(([name, value]) => ({ name, value })),
    ];
    const parts = [];
    if (e.body) parts.push({ mimeType: 'text/plain', body: { data: b64urlEncode(e.body), size: e.body.length } });
    if (e.html) parts.push({ mimeType: 'text/html', body: { data: b64urlEncode(e.html), size: e.html.length } });
    const msg = {
      id,
      threadId: e.threadId || `t${id}`,
      labelIds: e.labels || ['INBOX', 'UNREAD'],
      snippet: String(e.body || '').slice(0, 100),
      internalDate: String(Date.now() - (100 - seq) * 60_000),
      payload: { mimeType: 'multipart/alternative', headers, parts },
    };
    messages.push(msg);
    return msg;
  }
  emails.forEach(add);

  const labelByName = (n) => labels.find((l) => l.name.toLowerCase().replace(/[/\s]+/g, '-') === n.toLowerCase());
  function matches(msg, q) {
    for (const term of String(q || '').split(/\s+/).filter(Boolean)) {
      const neg = term.startsWith('-');
      const t = neg ? term.slice(1) : term;
      let hit = true;
      if (t === 'in:inbox') hit = msg.labelIds.includes('INBOX');
      else if (t === 'is:unread') hit = msg.labelIds.includes('UNREAD');
      else if (t.startsWith('label:')) {
        const l = labelByName(t.slice(6));
        hit = Boolean(l && msg.labelIds.includes(l.id));
      } else continue; // other operators (newer_than, category...) are ignored by the mock
      if (hit === neg) return false;
    }
    return true;
  }
  const fail = (op) => {
    if (failOn[op]) throw Object.assign(new Error(`mock ${op} failure`), { status: 500 });
  };
  const find = (id) => {
    const m = messages.find((x) => x.id === id);
    if (!m) throw Object.assign(new Error(`message ${id} not found`), { status: 404 });
    return m;
  };

  return {
    kind: 'mock',
    address,
    messages,
    drafts,
    sent,
    labels,
    addEmail: add,
    async getProfile() {
      return { emailAddress: address, messagesTotal: messages.length };
    },
    async listMessages({ q, maxResults = 25 } = {}) {
      fail('listMessages');
      return messages
        .filter((m) => matches(m, q))
        .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
        .slice(0, maxResults)
        .map(({ id, threadId }) => ({ id, threadId }));
    },
    async getMessage(id) {
      return structuredClone(find(id));
    },
    async getThread(id) {
      return { id, messages: structuredClone(messages.filter((m) => m.threadId === id)) };
    },
    async listLabels() {
      return labels.map((l) => ({ ...l }));
    },
    async createLabel(name) {
      if (labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error('exists'), { status: 409 });
      const l = { id: `Label_${labels.length + 1}`, name, type: 'user' };
      labels.push(l);
      return l;
    },
    async modifyMessage(id, { addLabelIds = [], removeLabelIds = [] }) {
      const m = find(id);
      m.labelIds = [...new Set([...m.labelIds.filter((l) => !removeLabelIds.includes(l)), ...addLabelIds])];
      return { id, labelIds: m.labelIds };
    },
    async createDraft({ raw, threadId }) {
      fail('createDraft');
      const d = { id: `d${drafts.length + 1}`, message: { id: `dm${drafts.length + 1}`, threadId }, raw, decoded: b64urlDecode(raw) };
      drafts.push(d);
      return { id: d.id, message: d.message };
    },
    async sendMessage({ raw, threadId }) {
      fail('sendMessage');
      const s = { id: `s${sent.length + 1}`, threadId, raw, decoded: b64urlDecode(raw) };
      sent.push(s);
      return { id: s.id, threadId, labelIds: ['SENT'] };
    },
    async watch({ topicName }) {
      return { historyId: '1', expiration: String(Date.now() + 7 * 864e5), topicName };
    },
    labelName(id) {
      return labels.find((l) => l.id === id)?.name;
    },
  };
}
