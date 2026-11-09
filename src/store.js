import fs from 'node:fs';
import path from 'node:path';

const MAX_HISTORY = 5000;
const MAX_IDS = 20000;

/**
 * JSON-file state: processed Gmail message ids (so a message is never answered twice) and
 * one history row per handled email (for `stats` / `history`). Atomic writes.
 * file = null -> in memory (demo, tests).
 */
export function createStore(file) {
  let state = { processed: {}, history: [] };
  if (file && fs.existsSync(file)) {
    try {
      state = { processed: {}, history: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      const bad = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, bad);
      console.warn(`[store] ${file} was unreadable (${err.message}); moved to ${bad}`);
    }
  }
  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, file);
  }
  return {
    file,
    has: (id) => Boolean(state.processed[id]),
    record(row) {
      state.processed[row.messageId] = row.at;
      const ids = Object.keys(state.processed);
      if (ids.length > MAX_IDS) for (const id of ids.slice(0, ids.length - MAX_IDS)) delete state.processed[id];
      state.history.push(row);
      if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
      save();
    },
    history({ limit = 20, sinceMs = 0 } = {}) {
      return state.history.filter((r) => Date.parse(r.at) >= sinceMs).slice(-limit).reverse();
    },
    stats({ sinceMs = 0, minutesSavedPerReply = 6 } = {}) {
      const rows = state.history.filter((r) => Date.parse(r.at) >= sinceMs);
      const by = (k) => rows.reduce((a, r) => ((a[r[k] ?? 'n/a'] = (a[r[k] ?? 'n/a'] || 0) + 1), a), {});
      const replied = rows.filter((r) => r.action === 'draft' || r.action === 'send');
      return {
        emails: rows.length,
        intents: by('intent'),
        actions: by('action'),
        replySources: by('replySource'),
        escalated: rows.filter((r) => r.escalate).length,
        autoSent: rows.filter((r) => r.action === 'send').length,
        skipped: rows.filter((r) => r.action === 'skip').length,
        errors: rows.filter((r) => r.error).length,
        estimatedMinutesSaved: replied.length * minutesSavedPerReply,
      };
    },
  };
}
