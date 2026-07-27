// Phone Remote API — main sessions only, project groups, open/resume/new task.

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { send, readJsonBody } from './helpers.js';
import {
  listHostSessions,
  findSessionDir,
  firstUserTitle,
  type HostSession,
} from '../session-index.js';
import { projectForCwd, groupSessionsByProject } from '../project-grouper.js';
import { deriveSessionStatus, type SessionTriageStatus } from '../session-status.js';
import type { AgentManager, PublicAgent } from '../agent-manager.js';
import { publicAuthInfo, type AuthConfig } from '../auth.js';
import { tailscaleIdentity } from './remote-host.js';
import { isPinned, listPins, setPinned } from '../remote-pins.js';

let manager: AgentManager | null = null;
let authCfg: AuthConfig | null = null;

export function setRemoteDeps(m: AgentManager, auth: AuthConfig): void {
  manager = m;
  authCfg = auth;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, body);
}

interface RemoteSessionRow {
  sessionId: string;
  title: string;
  cwd: string;
  projectId: string;
  projectLabel: string;
  status: SessionTriageStatus;
  updated: string;
  created: string;
  /** Epoch ms for relative time ("5m", "12h"). */
  updatedAtMs: number;
  source: string;
  local: boolean;
  model?: string;
  agentId?: string | null;
  connected?: boolean;
  /** Manual "working on" pin for phone triage. */
  pinned: boolean;
}

function toMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function agentBySession(sessionId: string): PublicAgent | null {
  if (!manager) return null;
  for (const a of manager.list()) {
    if (a.id === sessionId || a.sessionId === sessionId || a.lastSessionId === sessionId) {
      return a;
    }
  }
  return null;
}

const titleCache = new Map<string, string>();

function resolveTitle(s: HostSession, agent: PublicAgent | null): string {
  const sum = (s.summary || '').trim();
  if (sum && sum !== '(no summary)' && sum !== '/status') return sum;
  if (sum === '/status') return 'Status check';
  if (agent?.name && !/^session-/i.test(agent.name) && !/^[0-9a-f]{8}$/i.test(agent.name)) {
    return agent.name;
  }
  const cached = titleCache.get(s.sessionId);
  if (cached) return cached;
  const dir = findSessionDir(s.sessionId);
  if (dir) {
    const first = firstUserTitle(dir);
    if (first) {
      titleCache.set(s.sessionId, first);
      return first;
    }
  }
  return `Session ${s.sessionId.slice(0, 8)}`;
}

function toRow(s: HostSession): RemoteSessionRow {
  const project = projectForCwd(s.cwd);
  const agent = agentBySession(s.sessionId);
  const live = !!agent?.connected;
  // Prefer live agent activity when connected; else host disk timestamps.
  const hostActivity = s.updated || s.created || null;
  const activityIso = live && agent?.lastSeen ? agent.lastSeen : hostActivity;
  const triage = deriveSessionStatus({
    connected: live,
    inFlight: agent?.inFlight,
    agentStatus: live ? agent?.status : null,
    lastSeen: live ? (agent?.lastSeen || hostActivity) : hostActivity,
    updated: hostActivity,
    lastCompleted: !live && ((s.numMessages || 0) > 0 || !s.local),
    hasLocalContent: s.local !== false && s.status !== 'remote',
  });

  return {
    sessionId: s.sessionId,
    title: resolveTitle(s, agent),
    cwd: s.cwd || project.cwd,
    projectId: project.id,
    projectLabel: project.label,
    status: triage,
    updated: s.updated,
    created: s.created,
    updatedAtMs: toMs(activityIso) || toMs(s.created),
    source: s.source,
    local: s.local,
    model: s.model || agent?.model || undefined,
    agentId: agent?.id || null,
    connected: live,
    pinned: isPinned(s.sessionId) || !!agent?.starred,
  };
}

export async function handleRemote(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  // Returns true if handled.
  if (!url.startsWith('/api/remote')) return false;

  if (url === '/api/remote/hello' && method === 'GET') {
    const ts = tailscaleIdentity();
    sendJson(res, 200, {
      ok: true,
      app: 'grok-remote',
      surface: 'phone-remote',
      host: ts?.hostname || os.hostname(),
      hostLabel: ts?.dns || ts?.hostname || os.hostname(),
      tailscale: ts,
      auth: authCfg ? publicAuthInfo(authCfg) : null,
    });
    return true;
  }

  if (url === '/api/remote/sessions' || url.startsWith('/api/remote/sessions?')) {
    if (method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return true;
    }
    const u = new URL(req.url || '/', 'http://x');
    const q = (u.searchParams.get('q') || '').trim();
    const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '50', 10) || 50, 1), 200);
    try {
      const { items, raw, sources } = await listHostSessions({
        q,
        limit,
        includeSubagents: false,
      });
      // listHostSessions already main-only after our filter
      const statusRank: Record<string, number> = { stuck: 0, running: 1, waiting: 2, done: 3 };
      const rows = items.filter((s) => !s.isSubagent).map(toRow);
      const sortSessions = (a: RemoteSessionRow, b: RemoteSessionRow): number => {
        // Pinned first, then status, then most recently touched
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const ra = statusRank[a.status] ?? 9;
        const rb = statusRank[b.status] ?? 9;
        if (ra !== rb) return ra - rb;
        return (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
      };
      // Within each project, pinned → triage → recency
      const groups = groupSessionsByProject(rows).map((g) => ({
        projectId: g.project.id,
        projectLabel: g.project.label,
        cwd: g.project.cwd,
        isGit: g.project.isGit,
        sessions: [...g.sessions].sort(sortSessions),
      }));
      // Sort groups: any pinned, then stuck, then local, then label
      groups.sort((a, b) => {
        const aPin = a.sessions.some((s) => s.pinned) ? 0 : 1;
        const bPin = b.sessions.some((s) => s.pinned) ? 0 : 1;
        if (aPin !== bPin) return aPin - bPin;
        const aStuck = a.sessions.some((s) => s.status === 'stuck') ? 0 : 1;
        const bStuck = b.sessions.some((s) => s.status === 'stuck') ? 0 : 1;
        if (aStuck !== bStuck) return aStuck - bStuck;
        const aLocal = a.sessions.some((s) => s.local) ? 0 : 1;
        const bLocal = b.sessions.some((s) => s.local) ? 0 : 1;
        if (aLocal !== bLocal) return aLocal - bLocal;
        return a.projectLabel.localeCompare(b.projectLabel);
      });
      const stuckCount = rows.filter((r) => r.status === 'stuck').length;
      const pinned = rows.filter((r) => r.pinned).sort(sortSessions);
      sendJson(res, 200, {
        ok: true,
        sources,
        stuckCount,
        pinnedCount: pinned.length,
        count: rows.length,
        sessions: rows,
        pinned,
        projects: groups,
        raw: raw.slice(0, 2000),
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // Pin / unpin a session for the phone "Working on" triage list
  const pinMatch = url.match(/^\/api\/remote\/sessions\/([^/]+)\/pin$/);
  if (pinMatch && method === 'POST') {
    const sessionId = decodeURIComponent(pinMatch[1] || '');
    let body: { pinned?: boolean } = {};
    try { body = (await readJsonBody(req)) as typeof body; } catch { /* empty */ }
    try {
      const pinned = typeof body.pinned === 'boolean' ? body.pinned : !isPinned(sessionId);
      const result = setPinned(sessionId, pinned);
      // Mirror onto agent meta when an agent shell exists
      if (manager) {
        const a = agentBySession(sessionId);
        if (a) {
          try {
            await manager.update(a.id, { starred: result.pinned });
          } catch { /* non-fatal */ }
        }
      }
      sendJson(res, 200, { ok: true, ...result, pins: listPins() });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // Serve a file from the host session dir (images generated in CLI chat, etc.)
  // GET /api/remote/sessions/:id/file?path=images/6.jpg
  {
    const u = new URL(req.url || '/', 'http://x');
    const fileMatch = u.pathname.match(/^\/api\/remote\/sessions\/([^/]+)\/file$/);
    if (fileMatch && method === 'GET') {
      const sessionId = decodeURIComponent(fileMatch[1] || '');
      const rel = String(u.searchParams.get('path') || '').trim();
      if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
        sendJson(res, 400, { ok: false, error: 'invalid path' });
        return true;
      }
      // Only allow simple relative paths under the session dir (images/, etc.)
      if (!/^[A-Za-z0-9._/-]+$/.test(rel) || rel.startsWith('/')) {
        sendJson(res, 400, { ok: false, error: 'invalid path' });
        return true;
      }
      try {
        const sessionDir = findSessionDir(sessionId);
        if (!sessionDir) {
          sendJson(res, 404, { ok: false, error: 'session not found' });
          return true;
        }
        const target = path.resolve(sessionDir, rel);
        if (!target.startsWith(path.resolve(sessionDir) + path.sep)) {
          sendJson(res, 400, { ok: false, error: 'path escapes session' });
          return true;
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          sendJson(res, 404, { ok: false, error: 'file not found' });
          return true;
        }
        const ext = path.extname(target).toLowerCase();
        const mime =
          ext === '.png' ? 'image/png'
            : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
              : ext === '.gif' ? 'image/gif'
                : ext === '.webp' ? 'image/webp'
                  : ext === '.svg' ? 'image/svg+xml'
                    : 'application/octet-stream';
        res.writeHead(200, {
          'content-type': mime,
          'cache-control': 'private, max-age=3600',
        });
        fs.createReadStream(target).pipe(res);
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
  }

  // Re-read CLI/host chat_history into Remote history (SSH turns while phone is open)
  const reseedMatch = url.match(/^\/api\/remote\/sessions\/([^/]+)\/reseed$/);
  if (reseedMatch && method === 'POST') {
    if (!manager) {
      sendJson(res, 500, { ok: false, error: 'manager not ready' });
      return true;
    }
    const sessionId = decodeURIComponent(reseedMatch[1] || '');
    try {
      const result = await manager.reseedFromHost(sessionId);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const openMatch = url.match(/^\/api\/remote\/sessions\/([^/]+)\/open$/);
  if (openMatch && method === 'POST') {
    if (!manager) {
      sendJson(res, 500, { ok: false, error: 'manager not ready' });
      return true;
    }
    const sessionId = decodeURIComponent(openMatch[1] || '');
    let body: { connect?: boolean; name?: string; cwd?: string } = {};
    try { body = (await readJsonBody(req)) as typeof body; } catch { /* empty ok */ }
    try {
      const { findSessionDir } = await import('../session-index.js');
      const sessionDir = findSessionDir(sessionId);
      const hasLocal = !!sessionDir;
      // Only auto-connect when we have a local session dir to resume.
      // Cloud-only archives open as disconnected shells with title only.
      const wantConnect = body.connect !== false && hasLocal;
      const agent = await manager.importHostSession({
        sessionId,
        name: typeof body.name === 'string' ? body.name : undefined,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        connect: wantConnect,
        seedHistory: true,
      });
      sendJson(res, 200, {
        ok: true,
        agent,
        hasLocalContent: hasLocal,
        sessionDir: sessionDir || null,
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (url === '/api/remote/tasks' && method === 'POST') {
    if (!manager) {
      sendJson(res, 500, { ok: false, error: 'manager not ready' });
      return true;
    }
    let body: { text?: string; cwd?: string; name?: string };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'bad body' });
      return true;
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      sendJson(res, 400, { ok: false, error: 'text required' });
      return true;
    }
    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : os.homedir();
    try {
      const agent = await manager.spawn({
        name: typeof body.name === 'string' ? body.name : text.slice(0, 60),
        cwd,
        connect: true,
      });
      // Fire first prompt
      await manager.prompt(agent.id, text);
      sendJson(res, 201, { ok: true, agent });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  sendJson(res, 404, { ok: false, error: `unknown remote route ${method} ${url}` });
  return true;
}
