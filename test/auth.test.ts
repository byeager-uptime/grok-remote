import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

import {
  checkAuth,
  isLoopbackHost,
  isPublicApiPath,
  loadAuthConfig,
  generateToken,
} from '../lib/auth.js';

function fakeReq(headers: Record<string, string | string[] | undefined> = {}, url = '/api/agents'): IncomingMessage {
  return { headers, url } as IncomingMessage;
}

test('isLoopbackHost recognizes loopback forms', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('100.92.95.79'), false);
});

test('isPublicApiPath only allows health', () => {
  assert.equal(isPublicApiPath('/api/health', 'GET'), true);
  assert.equal(isPublicApiPath('/api/hello', 'GET'), false);
  assert.equal(isPublicApiPath('/api/agents', 'GET'), false);
});

test('token auth accepts Bearer header', () => {
  const cfg = loadAuthConfig({ GROK_REMOTE_TOKEN: 'sekrit' }, '0.0.0.0');
  const ok = checkAuth(fakeReq({ authorization: 'Bearer sekrit' }), '/api/agents', 'GET', cfg);
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'token');
});

test('token auth rejects wrong token', () => {
  const cfg = loadAuthConfig({ GROK_REMOTE_TOKEN: 'sekrit' }, '0.0.0.0');
  const bad = checkAuth(fakeReq({ authorization: 'Bearer wrong' }), '/api/agents', 'GET', cfg);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
});

test('token auth accepts query param', () => {
  const cfg = loadAuthConfig({ GROK_REMOTE_TOKEN: 'sekrit' }, '0.0.0.0');
  const ok = checkAuth(fakeReq({}, '/api/agents/stream?token=sekrit'), '/api/agents/stream', 'GET', cfg);
  assert.equal(ok.ok, true);
});

test('token auth accepts X-Grok-Remote-Token header', () => {
  const cfg = loadAuthConfig({ GROK_REMOTE_TOKEN: 'sekrit' }, '0.0.0.0');
  const ok = checkAuth(fakeReq({ 'x-grok-remote-token': 'sekrit' }), '/api/hello', 'GET', cfg);
  assert.equal(ok.ok, true);
});

test('health is always public even with token required', () => {
  const cfg = loadAuthConfig({ GROK_REMOTE_TOKEN: 'sekrit' }, '0.0.0.0');
  const ok = checkAuth(fakeReq(), '/api/health', 'GET', cfg);
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'public');
});

test('fail-closed on non-loopback without token', () => {
  const cfg = loadAuthConfig({}, '0.0.0.0');
  assert.equal(cfg.failClosed, true);
  const denied = checkAuth(fakeReq(), '/api/agents', 'GET', cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 503);
});

test('loopback without token is open', () => {
  const cfg = loadAuthConfig({}, '127.0.0.1');
  assert.equal(cfg.failClosed, false);
  const ok = checkAuth(fakeReq(), '/api/agents', 'GET', cfg);
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'open');
});

test('ALLOW_OPEN overrides fail-closed', () => {
  const cfg = loadAuthConfig({ GROK_REMOTE_ALLOW_OPEN: '1' }, '0.0.0.0');
  assert.equal(cfg.failClosed, false);
  const ok = checkAuth(fakeReq(), '/api/agents', 'GET', cfg);
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'open');
});

test('generateToken produces high-entropy base64url', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});
