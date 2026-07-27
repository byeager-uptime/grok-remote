// Discover Grok sessions on this host.
//
// Sources (merged by sessionId, newest first):
//   1. `grok sessions list` with cwd=$HOME  (includes cloud "remote" rows)
//   2. Filesystem under ~/.grok/sessions/<encoded-cwd>/<uuid>/
//      (top-level only — skips .../subagents/<uuid>)
//   3. session_search.sqlite when present
//
// The FTS DB alone is incomplete (only recently indexed). CLI alone misses
// sessions whose cwd isn't $HOME when the CLI is wrong. Disk is ground truth
// for local content.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runGrokText } from './grok-cli.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HostSession {
  sessionId: string;
  created: string;
  updated: string;
  status: string;
  summary: string;
  cwd: string;
  source: 'cli' | 'disk' | 'sqlite' | 'merged';
  /** True when this is a subagent session nested under another session. */
  isSubagent: boolean;
  numMessages?: number;
  model?: string;
  local: boolean;
}

function sessionsRoot(): string {
  return path.join(os.homedir(), '.grok', 'sessions');
}

function decodeCwdKey(enc: string): string {
  try {
    return decodeURIComponent(enc);
  } catch {
    return enc;
  }
}

function parseCliTable(raw: string): HostSession[] {
  const items: HostSession[] = [];
  if (!raw || /no sessions found/i.test(raw.trim())) return items;
  const lines = raw.split('\n');
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^SESSION\s+ID/i.test(lines[i] || '')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return items;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = line.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (!cols.length) continue;
    const sessionId = cols[0] || '';
    if (!UUID_RE.test(sessionId)) continue;
    const status = (cols[3] || '').toLowerCase();
    items.push({
      sessionId,
      created: cols[1] || '',
      updated: cols[2] || '',
      status: cols[3] || '',
      summary: cols.slice(4).join(' ') || '(no summary)',
      cwd: '',
      source: 'cli',
      isSubagent: false,
      local: status === 'local',
    });
  }
  return items;
}

function readSummary(sessionDir: string): Partial<HostSession> | null {
  const p = path.join(sessionDir, 'summary.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      session_summary?: string;
      generated_title?: string;
      created_at?: string;
      updated_at?: string;
      last_active_at?: string;
      num_messages?: number;
      current_model_id?: string;
      info?: { id?: string; cwd?: string };
    };
    // Keep full ISO for relative time in Remote UI (was date-only → always "today").
    const created = j.created_at || '';
    const updated = j.last_active_at || j.updated_at || created;
    return {
      sessionId: j.info?.id,
      cwd: j.info?.cwd || '',
      summary: j.generated_title || j.session_summary || '(no summary)',
      created,
      updated: updated || created,
      numMessages: j.num_messages,
      model: j.current_model_id,
      local: true,
      status: 'local',
      source: 'disk',
      isSubagent: false,
    };
  } catch {
    return null;
  }
}

/**
 * Collect every session id that appears under a `subagents/` directory.
 * Those are child research/worker runs and must not show in the main phone list.
 */
export function collectSubagentIds(): Set<string> {
  const root = sessionsRoot();
  const ids = new Set<string>();
  let cwdKeys: string[] = [];
  try {
    cwdKeys = fs.readdirSync(root).filter((n) => !n.endsWith('.sqlite'));
  } catch {
    return ids;
  }
  for (const enc of cwdKeys) {
    const cwdDir = path.join(root, enc);
    let parents: string[] = [];
    try { parents = fs.readdirSync(cwdDir); } catch { continue; }
    for (const parent of parents) {
      if (!UUID_RE.test(parent)) continue;
      const subRoot = path.join(cwdDir, parent, 'subagents');
      let kids: string[] = [];
      try { kids = fs.readdirSync(subRoot); } catch { continue; }
      for (const kid of kids) {
        if (UUID_RE.test(kid)) ids.add(kid);
      }
    }
  }
  return ids;
}

/** Walk ~/.grok/sessions for top-level session dirs (not under subagents/). */
export function listFromDisk(): HostSession[] {
  const root = sessionsRoot();
  const subIds = collectSubagentIds();
  const out: HostSession[] = [];
  let cwdKeys: string[] = [];
  try {
    cwdKeys = fs.readdirSync(root).filter((n) => n !== 'session_search.sqlite' && !n.endsWith('.sqlite'));
  } catch {
    return out;
  }

  for (const enc of cwdKeys) {
    const cwdDir = path.join(root, enc);
    let st: fs.Stats;
    try { st = fs.statSync(cwdDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const cwdDecoded = decodeCwdKey(enc);

    let entries: string[] = [];
    try { entries = fs.readdirSync(cwdDir); } catch { continue; }
    for (const name of entries) {
      if (!UUID_RE.test(name)) continue;
      // Even if a subagent was also mirrored as a top-level dir, hide it.
      if (subIds.has(name)) continue;
      const sessionDir = path.join(cwdDir, name);
      try {
        if (!fs.statSync(sessionDir).isDirectory()) continue;
      } catch { continue; }

      const fromSum = readSummary(sessionDir);
      let mtime = '';
      try {
        // Prefer chat_history mtime — reflects last CLI turn better than dir mtime
        const hist = path.join(sessionDir, 'chat_history.jsonl');
        if (fs.existsSync(hist)) mtime = fs.statSync(hist).mtime.toISOString();
        else mtime = fs.statSync(sessionDir).mtime.toISOString();
      } catch { /* ignore */ }

      out.push({
        sessionId: name,
        created: fromSum?.created || mtime,
        updated: fromSum?.updated || mtime,
        status: fromSum?.status || 'local',
        summary: fromSum?.summary || '(no summary)',
        cwd: fromSum?.cwd || cwdDecoded,
        source: 'disk',
        isSubagent: false,
        numMessages: fromSum?.numMessages,
        model: fromSum?.model,
        local: true,
      });
    }
  }
  return out;
}

export async function listFromCli(limit: number = 100, q: string = ''): Promise<{ raw: string; items: HostSession[] }> {
  const home = os.homedir();
  const args = q
    ? ['sessions', 'search', '-n', String(limit), q]
    : ['sessions', 'list', '-n', String(limit)];
  try {
    const raw = await runGrokText(args, { cwd: home, timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 });
    return { raw, items: parseCliTable(raw) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { raw: `cli error: ${msg}`, items: [] };
  }
}

function listFromSqlite(limit: number, q: string): HostSession[] {
  const db = path.join(sessionsRoot(), 'session_search.sqlite');
  if (!fs.existsSync(db)) return [];
  const esc = (s: string) => s.replace(/'/g, "''");
  let sql: string;
  if (q) {
    const like = `%${esc(q).replace(/%/g, '\\%')}%`;
    sql = `SELECT session_id, cwd, updated_at, title FROM session_docs WHERE title LIKE '${like}' OR content LIKE '${like}' OR session_id LIKE '${like}' ORDER BY updated_at DESC LIMIT ${limit};`;
  } else {
    sql = `SELECT session_id, cwd, updated_at, title FROM session_docs ORDER BY updated_at DESC LIMIT ${limit};`;
  }
  const r = spawnSync('sqlite3', ['-separator', '\t', db, sql], { encoding: 'utf8', timeout: 8000 });
  if (r.status !== 0) return [];
  const items: HostSession[] = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const [sessionId, cwd, updatedRaw, ...titleParts] = line.split('\t');
    if (!sessionId || !UUID_RE.test(sessionId)) continue;
    let updated = '';
    const n = parseInt(updatedRaw || '', 10);
    if (Number.isFinite(n) && n > 0) {
      const ms = n > 1e12 ? n : n * 1000;
      try { updated = new Date(ms).toISOString().slice(0, 10); } catch { /* ignore */ }
    }
    items.push({
      sessionId,
      created: updated,
      updated,
      status: (cwd || '').includes('.grok-remote') ? 'remote-agent' : 'local',
      summary: titleParts.join('\t').trim() || '(no summary)',
      cwd: cwd || '',
      source: 'sqlite',
      isSubagent: false,
      local: true,
    });
  }
  return items;
}

function sortKey(s: HostSession): number {
  // Prefer ISO-ish updated dates; fall back to session id time (UUIDv7).
  const d = Date.parse(s.updated || s.created || '');
  if (Number.isFinite(d)) return d;
  return 0;
}

export interface ListHostSessionsOpts {
  limit?: number;
  q?: string;
  includeSubagents?: boolean;
}

export async function listHostSessions(opts: ListHostSessionsOpts = {}): Promise<{
  items: HostSession[];
  raw: string;
  sources: string[];
}> {
  const limit = Math.min(Math.max(opts.limit || 50, 1), 200);
  const q = (opts.q || '').trim().toLowerCase();

  const subIds = collectSubagentIds();
  const includeSubs = !!opts.includeSubagents;

  const [cli, disk, sqlite] = await Promise.all([
    listFromCli(Math.max(limit, 100), opts.q || ''),
    Promise.resolve(listFromDisk()),
    Promise.resolve(listFromSqlite(Math.max(limit, 100), opts.q || '')),
  ]);

  const byId = new Map<string, HostSession>();
  const merge = (s: HostSession): void => {
    const isSub = s.isSubagent || subIds.has(s.sessionId);
    if (isSub && !includeSubs) return;
    const prev = byId.get(s.sessionId);
    if (!prev) {
      byId.set(s.sessionId, { ...s, isSubagent: isSub, source: s.source });
      return;
    }
    // Prefer non-empty fields; prefer disk titles/cwd; keep newest updated.
    byId.set(s.sessionId, {
      sessionId: s.sessionId,
      created: prev.created || s.created,
      updated: sortKey(s) >= sortKey(prev) ? (s.updated || prev.updated) : (prev.updated || s.updated),
      status: s.status || prev.status,
      summary:
        (s.summary && s.summary !== '(no summary)' ? s.summary : null) ||
        (prev.summary && prev.summary !== '(no summary)' ? prev.summary : null) ||
        '(no summary)',
      cwd: s.cwd || prev.cwd,
      source: 'merged',
      isSubagent: prev.isSubagent || isSub,
      numMessages: s.numMessages ?? prev.numMessages,
      model: s.model || prev.model,
      local: prev.local || s.local,
    });
  };

  for (const s of cli.items) merge(s);
  for (const s of disk) merge(s);
  for (const s of sqlite) merge(s);

  let items = [...byId.values()].filter((s) => includeSubs || !s.isSubagent);
  if (q) {
    items = items.filter((s) =>
      s.sessionId.toLowerCase().includes(q) ||
      (s.summary || '').toLowerCase().includes(q) ||
      (s.cwd || '').toLowerCase().includes(q) ||
      (s.status || '').toLowerCase().includes(q),
    );
  }
  items.sort((a, b) => sortKey(b) - sortKey(a));
  items = items.slice(0, limit);

  const raw = [
    `cli: ${cli.items.length} row(s)`,
    `disk: ${disk.length} top-level session dir(s)`,
    `sqlite: ${sqlite.length} indexed`,
    `merged: ${byId.size} unique → returning ${items.length}`,
    cli.raw ? `--- cli raw ---\n${cli.raw.slice(0, 4000)}` : '',
  ].filter(Boolean).join('\n');

  return {
    items,
    raw,
    sources: ['cli', 'disk', 'sqlite'],
  };
}

/**
 * Best-effort title when generated_title / summary is missing.
 * Pulls first real user_query from chat_history.jsonl.
 */
export function firstUserTitle(sessionDir: string): string | null {
  const histPath = path.join(sessionDir, 'chat_history.jsonl');
  if (!fs.existsSync(histPath)) return null;
  let raw: string;
  try { raw = fs.readFileSync(histPath, 'utf8'); } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: { type?: string; content?: unknown };
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const content = o.content;
    const texts: string[] = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; text?: string };
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      }
    }
    for (const t of texts) {
      const m = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
      const body = (m && m[1] ? m[1] : t).trim();
      if (!body) continue;
      if (body.startsWith('<user_info') || body.startsWith('<system-reminder') || body.includes('<system-reminder>')) continue;
      const one = body.replace(/\s+/g, ' ').slice(0, 90);
      if (one.length >= 3) return one;
    }
  }
  return null;
}

/** Find on-disk session directory for a session id (any cwd). */
export function findSessionDir(sessionId: string): string | null {
  if (!UUID_RE.test(sessionId)) return null;
  const root = sessionsRoot();
  let cwdKeys: string[] = [];
  try { cwdKeys = fs.readdirSync(root); } catch { return null; }
  for (const enc of cwdKeys) {
    const candidate = path.join(root, enc, sessionId);
    try {
      if (fs.statSync(candidate).isDirectory() && fs.existsSync(path.join(candidate, 'summary.json'))) {
        return candidate;
      }
    } catch { /* continue */ }
    // also under subagents of other sessions (rare for import)
    try {
      const parent = path.join(root, enc);
      for (const sid of fs.readdirSync(parent)) {
        if (!UUID_RE.test(sid)) continue;
        const sub = path.join(parent, sid, 'subagents', sessionId);
        try {
          if (fs.statSync(sub).isDirectory()) return sub;
        } catch { /* continue */ }
      }
    } catch { /* continue */ }
  }
  return null;
}

/** True for harness / resume blobs that should never appear as phone chat turns. */
function isNoiseUserText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith('<user_info') || t.startsWith('<system-reminder')) return true;
  if (t.includes('<system-reminder>')) return true;
  // Compaction resume injection — huge and not a real user message
  if (/^This session is being continued from a previous conversation/i.test(t)) return true;
  if (t.includes('Full verbatim rollouts of previous segments')) return true;
  if (t.includes('## Available Skills') && t.length > 2000) return true;
  return false;
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') {
    const m = content.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
    if (m && m[1]) return m[1].trim();
    return isNoiseUserText(content) ? '' : content.trim();
  }
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      const t = b.text;
      // Prefer real user_query content only
      const m = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
      if (m && m[1]) {
        parts.push(m[1].trim());
        continue;
      }
      // Skip harness wrappers entirely (do not fall through)
      if (
        t.startsWith('<user_info') ||
        t.startsWith('<system-reminder') ||
        t.includes('<system-reminder>') ||
        t.startsWith('\n\n<system-reminder') ||
        t.includes('<agent_transcripts>') ||
        t.includes('## Available Skills')
      ) continue;
      // Only keep short freeform user text (not giant injected context)
      if (t.trim().length > 0 && t.trim().length < 4000 && !isNoiseUserText(t)) {
        parts.push(t.trim());
      }
    }
  }
  return parts.join('\n\n').trim();
}

function extractAssistantText(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b && b.type === 'text' && b.text)
      .map((b) => b.text as string)
      .join('');
  }
  return text.trim();
}

/**
 * Convert a grok chat_history.jsonl into grok-remote history events so the
 * chat UI can replay prior turns without reconnecting.
 *
 * Phone UI wants a readable transcript of the CLI chat:
 * - real user_query only (no resume dumps / system-reminders)
 * - one assistant bubble per user turn (last substantial reply, not every status line)
 * - older user_query hooks from compaction segments when chat_history was compacted
 */
export function seedHistoryFromSession(sessionDir: string, agentId: string, append: (id: string, rec: Record<string, unknown>) => void): number {
  const histPath = path.join(sessionDir, 'chat_history.jsonl');
  let n = 0;

  // Note: compaction segments only have reliable user_query text, not answers.
  // Injecting them as orphan user bubbles confuses the phone transcript.
  // Instead, if compaction exists and chat_history is thin, add one marker turn.
  const compDir = path.join(sessionDir, 'compaction');
  let hasCompaction = false;
  try {
    hasCompaction = fs.existsSync(compDir) && fs.readdirSync(compDir).some((f) => /^segment_\d+\.md$/i.test(f));
  } catch { /* ignore */ }

  if (!fs.existsSync(histPath)) {
    if (hasCompaction) {
      append(agentId, {
        at: new Date().toISOString(),
        event: 'user_message',
        data: {
          text: '(Earlier CLI turns were compacted on the host. Open this session in the CLI/TUI for the full scrollback, or pull-up refresh after more live turns.)',
        },
      });
      n++;
    }
    return n;
  }
  let raw: string;
  try { raw = fs.readFileSync(histPath, 'utf8'); } catch { return n; }

  type RawTurn = { role: 'user' | 'asst'; text: string };
  const rawTurns: RawTurn[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: { type?: string; content?: unknown };
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'user') {
      const text = extractUserText(o.content);
      if (!text || isNoiseUserText(text)) continue;
      rawTurns.push({ role: 'user', text });
    } else if (o.type === 'assistant') {
      const text = extractAssistantText(o.content);
      if (!text) continue;
      rawTurns.push({ role: 'asst', text });
    }
  }

  // Collapse consecutive assistant status lines into the last substantial one
  // so Remote shows the answer, not every "Checking…" intermediate.
  const collapsed: RawTurn[] = [];
  let pendingAsst: string[] = [];
  const flushAsst = (): void => {
    if (!pendingAsst.length) return;
    // Prefer longest chunk (usually the real answer); fall back to last
    let best = pendingAsst[pendingAsst.length - 1]!;
    for (const p of pendingAsst) {
      if (p.length > best.length) best = p;
    }
    // If last is a short status and earlier is long, keep long; if last is long, keep last
    const last = pendingAsst[pendingAsst.length - 1]!;
    if (last.length >= 80 || last.length >= best.length * 0.6) best = last;
    collapsed.push({ role: 'asst', text: best });
    pendingAsst = [];
  };
  for (const t of rawTurns) {
    if (t.role === 'user') {
      flushAsst();
      // Dedupe against compaction-seeded same user text (recent overlap)
      collapsed.push(t);
    } else {
      pendingAsst.push(t.text);
    }
  }
  flushAsst();

  // Drop exact consecutive duplicate users (compaction + live overlap)
  const final: RawTurn[] = [];
  for (const t of collapsed) {
    const prev = final[final.length - 1];
    if (prev && prev.role === t.role && prev.text === t.text) continue;
    // Also skip user if same text appeared earlier (compaction seed + live)
    if (t.role === 'user' && final.some((x) => x.role === 'user' && x.text === t.text)) continue;
    final.push(t);
  }

  // If most of the CLI chat was compacted away, surface that honestly at the top
  if (hasCompaction && final.filter((t) => t.role === 'user').length <= 8) {
    append(agentId, {
      at: new Date().toISOString(),
      event: 'user_message',
      data: {
        text: '(Earlier turns in this CLI session were compacted on the host — Remote shows the live transcript below. Full scrollback is still on hermes-agent.)',
      },
    });
    n++;
  }

  for (const t of final) {
    if (t.role === 'user') {
      append(agentId, { at: new Date().toISOString(), event: 'user_message', data: { text: t.text } });
      n++;
    } else {
      append(agentId, {
        at: new Date().toISOString(),
        event: 'agent_message_chunk',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: t.text },
          },
        },
      });
      // Close the turn so UI doesn't fuse with next asst
      append(agentId, { at: new Date().toISOString(), event: 'prompt_complete', data: {} });
      n++;
    }
  }
  return n;
}
