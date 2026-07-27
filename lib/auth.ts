// Application auth for the HTTP API.
//
// Threat model: anyone who can hit /api/* has full agent RCE as the server user.
//
// Modes (GROK_REMOTE_AUTH):
//   auto      (default) — smart pick based on bind address + env
//   tailnet   — no app password; trust Tailscale perimeter (bind 100.x and/or
//               client IP in 100.64.0.0/10). Best phone/iPad UX.
//   token     — require bearer / header / ?token= (Codex-remote-adjacent lock)
//   open      — allow everything (dev only; same as GROK_REMOTE_ALLOW_OPEN=1)
//   loopback  — only allow when bound to 127.0.0.1 (implicit for loopback bind)
//
// Token can still be set alongside tailnet as an *optional* second factor
// when GROK_REMOTE_TOKEN_REQUIRED=1.
//
// Clients (token mode) send (first match wins):
//   Authorization: Bearer <token>
//   X-Grok-Remote-Token: <token>
//   ?token=<token>   (EventSource / raw file GETs)

import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';

export type AuthMode = 'auto' | 'tailnet' | 'token' | 'open' | 'loopback';

export interface AuthConfig {
  mode: AuthMode;
  resolvedMode: Exclude<AuthMode, 'auto'>;
  token: string | null;
  /** When true, even tailnet mode requires a token. */
  tokenRequired: boolean;
  allowOpen: boolean;
  host: string;
  failClosed: boolean;
}

export interface AuthResult {
  ok: boolean;
  status: number;
  error?: string;
  mode: 'public' | 'token' | 'tailnet' | 'open' | 'denied';
}

export interface AuthPublicInfo {
  mode: AuthConfig['resolvedMode'];
  tokenRequired: boolean;
  /** Human hint for the UI. */
  hint: string;
}

const PUBLIC_EXACT = new Set([
  '/api/health',
  '/api/auth/status',
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

/** Tailscale userspace / CGNAT range 100.64.0.0/10. */
export function isTailscaleIp(ip: string | undefined | null): boolean {
  if (!ip) return false;
  // Strip IPv4-mapped IPv6 prefix.
  let addr = ip.trim();
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  // Zone id / brackets
  if (addr.startsWith('[')) {
    const end = addr.indexOf(']');
    if (end > 0) addr = addr.slice(1, end);
  }
  if (addr.includes('%')) addr = addr.split('%')[0] || addr;

  if (!net.isIPv4(addr)) return false;
  const parts = addr.split('.').map((x) => parseInt(x, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  const [a, b] = parts as [number, number, number, number];
  // 100.64.0.0 – 100.127.255.255
  return a === 100 && b >= 64 && b <= 127;
}

export function isTailscaleBind(host: string): boolean {
  return isTailscaleIp(host);
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

function parseMode(env: NodeJS.ProcessEnv): AuthMode {
  const raw = (env['GROK_REMOTE_AUTH'] || 'auto').trim().toLowerCase();
  if (raw === 'tailnet' || raw === 'tailscale' || raw === 'ts') return 'tailnet';
  if (raw === 'token' || raw === 'bearer') return 'token';
  if (raw === 'open' || raw === 'none' || raw === 'off') return 'open';
  if (raw === 'loopback' || raw === 'local') return 'loopback';
  return 'auto';
}

export function resolveMode(
  mode: AuthMode,
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): Exclude<AuthMode, 'auto'> {
  if (mode !== 'auto') {
    if (mode === 'tailnet') return 'tailnet';
    if (mode === 'token') return 'token';
    if (mode === 'open') return 'open';
    return 'loopback';
  }
  // auto:
  if (env['GROK_REMOTE_ALLOW_OPEN'] === '1') return 'open';
  if (isLoopbackHost(host)) return 'loopback';
  // Bound only on a Tailscale address → trust the mesh (best mobile UX).
  // A leftover token file does NOT force login here; set GROK_REMOTE_AUTH=token
  // or GROK_REMOTE_TOKEN_REQUIRED=1 for a second factor.
  if (isTailscaleBind(host)) return 'tailnet';
  // Explicit token request, or token present on a public bind.
  if (env['GROK_REMOTE_TOKEN_REQUIRED'] === '1' || readTokenFromEnv(env)) return 'token';
  // 0.0.0.0 / public bind with no token: still accept Tailscale peer IPs only.
  return 'tailnet';
}

export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  host: string = process.env['HOST'] || '0.0.0.0',
): AuthConfig {
  const mode = parseMode(env);
  const resolvedMode = resolveMode(mode, host, env);
  const token = readTokenFromEnv(env);
  const allowOpen = env['GROK_REMOTE_ALLOW_OPEN'] === '1' || resolvedMode === 'open';
  // Second factor: only when operator asks, or pure token mode.
  const tokenRequired =
    resolvedMode === 'token' ||
    (resolvedMode === 'tailnet' && env['GROK_REMOTE_TOKEN_REQUIRED'] === '1' && !!token);

  // Fail closed only when token mode has no secret configured.
  const failClosed = resolvedMode === 'token' && !token;

  return {
    mode,
    resolvedMode,
    token,
    tokenRequired,
    allowOpen,
    host,
    failClosed,
  };
}

/** Public status for the UI (no secrets). */
export function publicAuthInfo(cfg: AuthConfig): AuthPublicInfo {
  const mode = cfg.resolvedMode;
  const tokenRequired =
    mode === 'token' || (mode === 'tailnet' && cfg.tokenRequired && !!cfg.token);
  let hint = '';
  switch (mode) {
    case 'tailnet':
      hint = tokenRequired
        ? 'Tailscale + API token required'
        : 'Tailscale only — open the URL, no password';
      break;
    case 'token':
      hint = 'API token required';
      break;
    case 'open':
      hint = 'Open API (no auth)';
      break;
    case 'loopback':
      hint = 'Localhost only';
      break;
  }
  return { mode, tokenRequired: tokenRequired && !!cfg.token, hint };
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
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function clientIp(req: IncomingMessage): string {
  // Prefer direct socket peer (Tailscale path has no untrusted proxy).
  const ra = req.socket?.remoteAddress || '';
  // Optional: first X-Forwarded-For hop only when behind a trusted reverse proxy.
  // Disabled by default — enabling with untrusted proxies is unsafe.
  if (process.env['GROK_REMOTE_TRUST_PROXY'] === '1') {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (typeof raw === 'string' && raw.trim()) {
      return raw.split(',')[0]!.trim();
    }
  }
  return ra;
}

function checkToken(req: IncomingMessage, cfg: AuthConfig): AuthResult {
  if (!cfg.token) {
    return {
      ok: false,
      status: 503,
      error: 'token mode configured but GROK_REMOTE_TOKEN is empty',
      mode: 'denied',
    };
  }
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

export function checkAuth(
  req: IncomingMessage,
  urlPath: string,
  method: string,
  cfg: AuthConfig,
): AuthResult {
  if (isPublicApiPath(urlPath, method)) {
    return { ok: true, status: 200, mode: 'public' };
  }

  if (!urlPath.startsWith('/api/')) {
    return { ok: true, status: 200, mode: 'public' };
  }

  const mode = cfg.resolvedMode;
  const ip = clientIp(req);

  if (mode === 'open' || cfg.allowOpen) {
    return { ok: true, status: 200, mode: 'open' };
  }

  if (mode === 'loopback') {
    if (isLoopbackHost(cfg.host) || isTailscaleIp(ip) === false && (ip === '127.0.0.1' || ip === '::1')) {
      // Bound loopback: any client that reached us is local.
      if (isLoopbackHost(cfg.host)) return { ok: true, status: 200, mode: 'open' };
    }
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
      return { ok: true, status: 200, mode: 'open' };
    }
    return {
      ok: false,
      status: 403,
      error: 'loopback-only API',
      mode: 'denied',
    };
  }

  if (mode === 'token') {
    return checkToken(req, cfg);
  }

  // tailnet mode (default when bound to 100.x)
  if (mode === 'tailnet') {
    // Server bound exclusively to a Tailscale address: only the mesh can connect.
    // Still verify peer is 100.x when possible (defense in depth if bind changes).
    const peerOk =
      isTailscaleBind(cfg.host) ||
      isTailscaleIp(ip) ||
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip === '::ffff:127.0.0.1';

    if (!peerOk) {
      return {
        ok: false,
        status: 403,
        error:
          'tailnet-only API: connect over Tailscale (client IP not in 100.64.0.0/10). ' +
          `peer=${ip || 'unknown'}`,
        mode: 'denied',
      };
    }

    if (cfg.token && cfg.tokenRequired) {
      return checkToken(req, cfg);
    }
    return { ok: true, status: 200, mode: 'tailnet' };
  }

  return {
    ok: false,
    status: 503,
    error: 'auth misconfigured',
    mode: 'denied',
  };
}

/** Generate a high-entropy token suitable for GROK_REMOTE_TOKEN. */
export function generateToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function logAuthStartup(cfg: AuthConfig, log: (s: string) => void = console.log): void {
  const info = publicAuthInfo(cfg);
  log(
    `[grok-remote] auth: mode=${info.mode} tokenRequired=${info.tokenRequired} ` +
    `bind=${cfg.host} (${info.hint})`,
  );
  if (info.mode === 'open') {
    log('[grok-remote] auth: WARNING open API — anyone who can reach the port has RCE');
  }
  if (info.mode === 'tailnet' && !info.tokenRequired) {
    log('[grok-remote] auth: Tailscale is the login — open http://<magicdns>:7910 with no token');
  }
}
