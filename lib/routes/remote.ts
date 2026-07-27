// Phone Remote API — main sessions only, project groups, open/resume/new task.

import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';

import { send, readJsonBody } from './helpers.js';
import { listHostSessions, type HostSession } from '../session-index.js';
import { projectForCwd, groupSessionsByProject } from '../project-grouper.js';
import { deriveSessionStatus, type SessionTriageStatus } from '../session-status.js';
import type { AgentManager, PublicAgent } from '../agent-manager.js';
import { publicAuthInfo, type AuthConfig } from '../auth.js';
import { tailscaleIdentity } from './remote-host.js';

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
  source: string;
  local: boolean;
  model?: string;
  agentId?: string | null;
  connected?: boolean;
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

function toRow(s: HostSession): RemoteSessionRow {
  const project = projectForCwd(s.cwd);
  const agent = agentBySession(s.sessionId);
  const triage = deriveSessionStatus({
    connected: !!agent?.connected,
    inFlight: agent?.inFlight,
    agentStatus: agent?.status,
    lastSeen: agent?.lastSeen || s.updated,
    updated: s.updated,
    lastCompleted: !agent?.connected && (s.numMessages || 0) > 0,
  });
  return {
    sessionId: s.sessionId,
    title: s.summary && s.summary !== '(no summary)' ? s.summary : `Session ${s.sessionId.slice(0, 8)}`,
    cwd: s.cwd || project.cwd,
    projectId: project.id,
    projectLabel: project.label,
    status: triage,
    updated: s.updated,
    created: s.created,
    source: s.source,
    local: s.local,
    model: s.model || agent?.model || undefined,
    agentId: agent?.id || null,
    connected: !!agent?.connected,
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
      const rows = items.filter((s) => !s.isSubagent).map(toRow);
      const groups = groupSessionsByProject(rows).map((g) => ({
        projectId: g.project.id,
        projectLabel: g.project.label,
        cwd: g.project.cwd,
        isGit: g.project.isGit,
        sessions: g.sessions,
      }));
      // Sort groups: any stuck first, then by label
      groups.sort((a, b) => {
        const aStuck = a.sessions.some((s) => s.status === 'stuck') ? 0 : 1;
        const bStuck = b.sessions.some((s) => s.status === 'stuck') ? 0 : 1;
        if (aStuck !== bStuck) return aStuck - bStuck;
        return a.projectLabel.localeCompare(b.projectLabel);
      });
      const stuckCount = rows.filter((r) => r.status === 'stuck').length;
      sendJson(res, 200, {
        ok: true,
        sources,
        stuckCount,
        count: rows.length,
        sessions: rows,
        projects: groups,
        raw: raw.slice(0, 2000),
      });
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
      const agent = await manager.importHostSession({
        sessionId,
        name: typeof body.name === 'string' ? body.name : undefined,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        connect: body.connect !== false, // default connect for open
        seedHistory: true,
      });
      sendJson(res, 200, { ok: true, agent });
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
