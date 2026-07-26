// Optional bearer-token gate for the HTTP API.
//
// Threat model: without this, anyone who can reach HOST:PORT has full remote
// code execution as the server user (spawn agents, shell via ACP, read/write
// files under agent cwd, self-update, install MCP servers, kill processes).
// Tailscale reduces exposure to the tailnet, but is not per-app auth.
//
// Enable by setting one of:
//   GROK_REMOTE_TOKEN=<secret>
//   GROK_REMOTE_TOKEN_FILE=/path/to/file   (file contents = secret, trimmed)
//
// Clients send the token via (first match wins):
//   Authorization: Bearer <token>
//   X-Grok-Remote-Token: <token>
//   ?token=<token>   (needed for EventSource / <img> / raw file GETs)
//
// When no token is configured:
//   - If HOST is loopback: allow (local-only install).
//   - If GROK_REMOTE_ALLOW_OPEN=1: allow with a stderr warning (explicit opt-out).
//   - Otherwise: reject non-public API requests (fail closed on non-loopback).

import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import crypto from 'node:crypto';

export interface AuthConfig {
  token: string | null;
  allowOpen: boolean;
  host: string;
  failClosed: boolean;
}

export interface AuthResult {
  ok: boolean;
  status: number;
  error?: string;
  mode: 'public' | 'token' | 'open' | 'denied';
}

const PUBLIC_EXACT = new Set([
  '/api/health',
]);

/** Paths that never require a token (static assets are handled outside /api). */
export function isPublicApiPath(urlPath: string, _method: string): boolean {
  const pathOnly = (urlPath || '').split('?')[0] || '';
  if (PUBLIC_EXACT.has(pathOnly)) return true;
  return false;
}

export function isLoopbackHost(host: string): boolean {
  const h = (host || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

function readTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = env['GROK_REMOTE_TOKEN'];
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct.trim();
  }
  const file = env['GROK_REMOTE_TOKEN_FILE'];
  if (typeof file === 'string' && file.trim().length > 0) {
    try {
      const raw = fs.readFileSync(file.trim(), 'utf8');
      const t = raw.trim();
      return t.length ? t : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  host: string = process.env['HOST'] || '0.0.0.0',
): AuthConfig {
  const token = readTokenFromEnv(env);
  const allowOpen = env['GROK_REMOTE_ALLOW_OPEN'] === '1';
  const loopback = isLoopbackHost(host);
  // Fail closed when bound to a non-loopback address and no token is set,
  // unless the operator explicitly opts into an open API.
  const failClosed = !token && !loopback && !allowOpen;
  return { token, allowOpen, host, failClosed };
}

function extractPresentedToken(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) return m[1].trim();
  }
  const hdr = req.headers['x-grok-remote-token'];
  if (typeof hdr === 'string' && hdr.trim()) return hdr.trim();
  if (Array.isArray(hdr) && hdr[0]) return String(hdr[0]).trim();

  try {
    const u = new URL(req.url || '/', 'http://x');
    const q = u.searchParams.get('token');
    if (q && q.trim()) return q.trim();
  } catch { /* ignore */ }
  return null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Still do a compare to reduce trivial timing oracles on length.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function checkAuth(
  req: IncomingMessage,
  urlPath: string,
  method: string,
  cfg: AuthConfig,
): AuthResult {
  if (isPublicApiPath(urlPath, method)) {
    return { ok: true, status: 200, mode: 'public' };
  }

  // Static / non-API: caller should not use this for those paths.
  if (!urlPath.startsWith('/api/')) {
    return { ok: true, status: 200, mode: 'public' };
  }

  if (cfg.token) {
    const presented = extractPresentedToken(req);
    if (!presented || !timingSafeEqualStr(presented, cfg.token)) {
      return {
        ok: false,
        status: 401,
        error: 'unauthorized: provide Authorization: Bearer <token>, X-Grok-Remote-Token, or ?token=',
        mode: 'denied',
      };
    }
    return { ok: true, status: 200, mode: 'token' };
  }

  if (isLoopbackHost(cfg.host) || cfg.allowOpen) {
    return { ok: true, status: 200, mode: 'open' };
  }

  if (cfg.failClosed) {
    return {
      ok: false,
      status: 503,
      error:
        'refusing unauthenticated API on non-loopback bind. ' +
        'Set GROK_REMOTE_TOKEN (or GROK_REMOTE_TOKEN_FILE), bind HOST=127.0.0.1, ' +
        'or explicitly set GROK_REMOTE_ALLOW_OPEN=1 (not recommended).',
      mode: 'denied',
    };
  }

  return { ok: true, status: 200, mode: 'open' };
}

/** Generate a high-entropy token suitable for GROK_REMOTE_TOKEN. */
export function generateToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function logAuthStartup(cfg: AuthConfig, log: (s: string) => void = console.log): void {
  if (cfg.token) {
    log('[grok-remote] auth: bearer token enabled (API requires token)');
    return;
  }
  if (isLoopbackHost(cfg.host)) {
    log('[grok-remote] auth: open API on loopback only (HOST=' + cfg.host + ')');
    return;
  }
  if (cfg.allowOpen) {
    log('[grok-remote] auth: WARNING open API on ' + cfg.host + ' (GROK_REMOTE_ALLOW_OPEN=1)');
    return;
  }
  log('[grok-remote] auth: fail-closed on non-loopback without token (set GROK_REMOTE_TOKEN)');
}
