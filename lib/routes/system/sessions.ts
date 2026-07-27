// sessions routes.
//
// Grok CLI's `sessions list` is **cwd-scoped**. The server runs with
// cwd=install dir, so a naive shell-out always returns "No sessions found"
// even when ~/.grok/sessions is full of history from /root, agent cwds, etc.
//
// Primary source: ~/.grok/sessions/session_search.sqlite (cross-cwd index).
// Fallback: `grok sessions list` with cwd=$HOME.

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { send } from '../helpers.js';
import { runGrokText, errorToResponse } from '../../grok-cli.js';
import type { RouteRegistrar } from '../system.js';

interface SessionItem {
  sessionId: string;
  created: string;
  updated: string;
  status: string;
  summary: string;
  cwd?: string;
  source?: 'sqlite' | 'cli';
}

export function register(add: RouteRegistrar): void {
  add('GET', '/api/system/sessions', listHandler);
}

function clampLimit(raw: string | null): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  if (n > 200) return 200;
  return n;
}

function parseSessions(raw: unknown): SessionItem[] {
  const items: SessionItem[] = [];
  if (!raw || typeof raw !== 'string') return items;
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
    const sessionId = cols[0];
    if (!sessionId || !/^[0-9a-f-]{8,}$/i.test(sessionId)) continue;
    items.push({
      sessionId,
      created: cols[1] || '',
      updated: cols[2] || '',
      status:  cols[3] || '',
      summary: cols.slice(4).join(' ') || '',
      source: 'cli',
    });
  }
  return items;
}

function dbPath(): string {
  return path.join(os.homedir(), '.grok', 'sessions', 'session_search.sqlite');
}

function escapeSqlLike(s: string): string {
  return s.replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Read cross-cwd sessions from Grok's FTS index DB. */
function listFromSqlite(q: string, limit: number): SessionItem[] | null {
  const db = dbPath();
  if (!fs.existsSync(db)) return null;

  // Use system sqlite3 CLI (always present on this host) to avoid adding a dep.
  // updated_at appears to be unix seconds or ms — normalize both.
  let sql: string;
  if (q) {
    const like = `%${escapeSqlLike(q)}%`;
    sql =
      `SELECT session_id, cwd, updated_at, title FROM session_docs ` +
      `WHERE title LIKE '${like}' ESCAPE '\\' OR content LIKE '${like}' ESCAPE '\\' OR session_id LIKE '${like}' ESCAPE '\\' ` +
      `ORDER BY updated_at DESC LIMIT ${limit};`;
  } else {
    sql =
      `SELECT session_id, cwd, updated_at, title FROM session_docs ` +
      `ORDER BY updated_at DESC LIMIT ${limit};`;
  }

  const r = spawnSync('sqlite3', ['-separator', '\t', db, sql], {
    encoding: 'utf8',
    timeout: 8000,
    env: process.env,
  });
  if (r.status !== 0) {
    process.stderr.write(`[sessions] sqlite3 failed: ${(r.stderr || r.stdout || '').slice(0, 400)}\n`);
    return null;
  }
  const out = (r.stdout || '').trim();
  if (!out) return [];

  const items: SessionItem[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [sessionId, cwd, updatedRaw, ...titleParts] = line.split('\t');
    if (!sessionId || !/^[0-9a-f-]{8,}$/i.test(sessionId)) continue;
    let updated = '';
    const n = parseInt(updatedRaw || '', 10);
    if (Number.isFinite(n) && n > 0) {
      // Heuristic: ms vs s
      const ms = n > 1e12 ? n : n * 1000;
      try { updated = new Date(ms).toISOString().slice(0, 10); } catch { updated = String(n); }
    }
    items.push({
      sessionId,
      created: updated,
      updated,
      status: cwd && cwd.includes('.grok-remote') ? 'remote-agent' : 'local',
      summary: (titleParts.join('\t') || '').trim() || '(no summary)',
      cwd: cwd || '',
      source: 'sqlite',
    });
  }
  return items;
}

async function listFromCli(q: string, limit: number): Promise<{ raw: string; items: SessionItem[] }> {
  // Critical: use HOME so we don't inherit the server install cwd (empty).
  const home = os.homedir();
  const args = q
    ? ['sessions', 'search', '-n', String(limit), q]
    : ['sessions', 'list',   '-n', String(limit)];
  const raw = await runGrokText(args, { cwd: home, timeoutMs: 25_000 });
  return { raw, items: parseSessions(raw) };
}

async function listHandler(_req: IncomingMessage, res: ServerResponse, urlObj: URL): Promise<void> {
  const q     = (urlObj.searchParams.get('q') || '').trim();
  const limit = clampLimit(urlObj.searchParams.get('limit'));

  try {
    const fromDb = listFromSqlite(q, limit);
    if (fromDb && fromDb.length > 0) {
      send(res, 200, {
        ok: true,
        source: 'sqlite',
        raw: `session_search.sqlite: ${fromDb.length} session(s)`,
        items: fromDb,
      });
      return;
    }

    // Empty DB or sqlite missing → fall back to CLI from $HOME.
    const { raw, items } = await listFromCli(q, limit);
    // If CLI also empty but DB existed with 0 rows, still report honestly.
    send(res, 200, {
      ok: true,
      source: fromDb ? 'sqlite+cli' : 'cli',
      raw,
      items,
    });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}
