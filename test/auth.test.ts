import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

import {
  checkAuth,
  isLoopbackHost,
  isPublicApiPath,
  isTailscaleIp,
  loadAuthConfig,
  generateToken,
  publicAuthInfo,
  resolveMode,
} from '../lib/auth.js';

function fakeReq(
  headers: Record<string, string | string[] | undefined> = {},
  url = '/api/agents',
  remoteAddress = '100.71.1.2',
): IncomingMessage {
  return {
    headers,
    url,
    socket: { remoteAddress },
  } as IncomingMessage;
}

test('isLoopbackHost recognizes loopback forms', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('100.92.95.79'), false);
});

test('isTailscaleIp matches CGNAT 100.64/10 only', () => {
  assert.equal(isTailscaleIp('100.64.0.1'), true);
  assert.equal(isTailscaleIp('100.92.95.79'), true);
  assert.equal(isTailscaleIp('100.127.255.255'), true);
  assert.equal(isTailscaleIp('100.63.255.255'), false);
  assert.equal(isTailscaleIp('100.128.0.1'), false);
  assert.equal(isTailscaleIp('8.8.8.8'), false);
  assert.equal(isTailscaleIp('::ffff:100.92.95.79'), true);
});

test('isPublicApiPath allows health and auth status', () => {
  assert.equal(isPublicApiPath('/api/health', 'GET'), true);
  assert.equal(isPublicApiPath('/api/auth/status', 'GET'), true);
  assert.equal(isPublicApiPath('/api/hello', 'GET'), false);
  assert.equal(isPublicApiPath('/api/agents', 'GET'), false);
});

test('auto mode on Tailscale bind → tailnet (no token needed even if file set)', () => {
  const cfg = loadAuthConfig(
    { GROK_REMOTE_TOKEN: 'sekrit' },
    '100.92.95.79',
  );
  assert.equal(cfg.resolvedMode, 'tailnet');
  assert.equal(cfg.tokenRequired, false);
  const ok = checkAuth(fakeReq({}, '/api/agents', '100.71.1.2'), '/api/agents', 'GET', cfg);
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'tailnet');
});

test('auto mode on loopback → open', () => {
  const cfg = loadAuthConfig({}, '127.0.0.1');
  assert.equal(cfg.resolvedMode, 'loopback');
  const ok = checkAuth(fakeReq({}, '/api/agents', '127.0.0.1'), '/api/agents', 'GET', cfg);
  assert.equal(ok.ok, true);
});

test('token mode requires bearer', () => {
  const cfg = loadAuthConfig({ GROK_REMOTE_AUTH: 'token', GROK_REMOTE_TOKEN: 'sekrit' }, '0.0.0.0');
  assert.equal(cfg.resolvedMode, 'token');
  const ok = checkAuth(fakeReq({ authorization: 'Bearer sekrit' }), '/api/agents', 'GET', cfg);
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'token');
  const bad = checkAuth(fakeReq({ authorization: 'Bearer wrong' }), '/api/agents', 'GET', cfg);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
});

test('token auth accepts query param', () => {
  const cfg = loadAuthConfig({ GROK_REMOTE_AUTH: 'token', GROK_REMOTE_TOKEN: 'sekrit' }, '0.0.0.0');
  const ok = checkAuth(fakeReq({}, '/api/agents/stream?token=sekrit'), '/api/agents/stream', 'GET', cfg);
  assert.equal(ok.ok, true);
});

test('health is always public', () => {
  const cfg = loadAuthConfig({ GROK_REMOTE_AUTH: 'token', GROK_REMOTE_TOKEN: 'sekrit' }, '0.0.0.0');
  const ok = checkAuth(fakeReq(), '/api/health', 'GET', cfg);
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'public');
});

test('tailnet rejects non-tailscale peers when not bound to 100.x', () => {
  const cfg = loadAuthConfig({ GROK_REMOTE_AUTH: 'tailnet' }, '0.0.0.0');
  const bad = checkAuth(fakeReq({}, '/api/agents', '8.8.8.8'), '/api/agents', 'GET', cfg);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 403);
});

test('tailnet + TOKEN_REQUIRED still needs token', () => {
  const cfg = loadAuthConfig(
    { GROK_REMOTE_AUTH: 'tailnet', GROK_REMOTE_TOKEN: 'sekrit', GROK_REMOTE_TOKEN_REQUIRED: '1' },
    '100.92.95.79',
  );
  assert.equal(cfg.tokenRequired, true);
  // Bound to a Tailscale address: peer can connect; token is the second factor.
  const needTok = checkAuth(fakeReq({}, '/api/agents', '100.71.1.2'), '/api/agents', 'GET', cfg);
  assert.equal(needTok.ok, false);
  assert.equal(needTok.status, 401);
  const ok = checkAuth(
    fakeReq({ authorization: 'Bearer sekrit' }, '/api/agents', '100.71.1.2'),
    '/api/agents', 'GET', cfg,
  );
  assert.equal(ok.ok, true);
});

test('ALLOW_OPEN forces open mode', () => {
  const cfg = loadAuthConfig({ GROK_REMOTE_ALLOW_OPEN: '1' }, '0.0.0.0');
  assert.equal(cfg.resolvedMode, 'open');
  const ok = checkAuth(fakeReq({}, '/api/agents', '8.8.8.8'), '/api/agents', 'GET', cfg);
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'open');
});

test('publicAuthInfo for tailnet', () => {
  const cfg = loadAuthConfig({ GROK_REMOTE_AUTH: 'tailnet' }, '100.92.95.79');
  const info = publicAuthInfo(cfg);
  assert.equal(info.mode, 'tailnet');
  assert.equal(info.tokenRequired, false);
  assert.match(info.hint, /Tailscale/i);
});

test('resolveMode helpers', () => {
  // 100.1.x is outside Tailscale CGNAT → auto falls through to tailnet peer-check mode
  assert.equal(resolveMode('auto', '100.1.2.3', {}), 'tailnet');
  assert.equal(resolveMode('auto', '100.92.95.79', {}), 'tailnet');
  assert.equal(resolveMode('auto', '127.0.0.1', {}), 'loopback');
  assert.equal(resolveMode('token', '100.92.95.79', {}), 'token');
});

test('generateToken produces high-entropy base64url', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});
