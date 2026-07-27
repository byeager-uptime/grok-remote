// sessions routes — list every Grok session on this host and import into chats.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { send, readJsonBody } from '../helpers.js';
import { listHostSessions } from '../../session-index.js';
import type { RouteRegistrar } from '../system.js';
import { AgentManager } from '../../agent-manager.js';

// Lazy get of the singleton manager from server would create a cycle.
// Import handlers receive manager via module setter.
let managerRef: AgentManager | null = null;

export function setSessionsManager(m: AgentManager): void {
  managerRef = m;
}

export function register(add: RouteRegistrar): void {
  add('GET',  '/api/system/sessions',        listHandler);
  add('POST', '/api/system/sessions/import', importHandler);
  add('POST', '/api/system/sessions/sync',   syncHandler);
}

function clampLimit(raw: string | null): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  if (n > 200) return 200;
  return n;
}

async function listHandler(_req: IncomingMessage, res: ServerResponse, urlObj: URL): Promise<void> {
  const q     = (urlObj.searchParams.get('q') || '').trim();
  const limit = clampLimit(urlObj.searchParams.get('limit'));

  try {
    const { items, raw, sources } = await listHostSessions({ q, limit });
    send(res, 200, {
      ok: true,
      source: sources.join('+'),
      raw,
      items: items.map((it) => ({
        sessionId: it.sessionId,
        created: it.created,
        updated: it.updated,
        status: it.status,
        summary: it.summary,
        cwd: it.cwd,
        source: it.source,
        local: it.local,
        numMessages: it.numMessages,
        model: it.model,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

async function importHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!managerRef) {
    send(res, 500, { ok: false, error: 'agent manager not ready' });
    return;
  }
  let body: { sessionId?: unknown; name?: unknown; cwd?: unknown; connect?: unknown };
  try {
    body = (await readJsonBody(req)) as typeof body;
  } catch (err) {
    send(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid body' });
    return;
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) {
    send(res, 400, { ok: false, error: 'sessionId required' });
    return;
  }
  try {
    const agent = await managerRef.importHostSession({
      sessionId,
      name: typeof body.name === 'string' ? body.name : undefined,
      cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
      connect: body.connect === true,
      seedHistory: true,
    });
    send(res, 200, { ok: true, agent });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

async function syncHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!managerRef) {
    send(res, 500, { ok: false, error: 'agent manager not ready' });
    return;
  }
  try {
    const result = await managerRef.syncHostSessions(50);
    send(res, 200, { ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}
