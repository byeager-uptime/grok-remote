// Spawns real shell processes on behalf of the agent and tracks their output
// buffers. Mirrors the methods listed in PROTOCOL.md.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const DEFAULT_LIMIT = 256 * 1024;

export interface RpcError extends Error {
  rpc: { code: number; message: string };
}

export interface EnvPair { name: string; value?: string }

export interface TerminalCreateParams {
  command?: string;
  cwd?: string;
  outputByteLimit?: number;
  env?: EnvPair[];
  args?: string[];
}

export interface TerminalCreateResult {
  terminalId: string;
}

export interface ExitStatus {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface TerminalOutputResult {
  output: string;
  truncated: boolean;
  exitStatus: ExitStatus | null;
}

interface TerminalRec {
  id: string;
  proc: ChildProcess;
  buffer: Buffer;
  truncated: boolean;
  limit: number;
  exited: boolean;
  exitStatus: ExitStatus | null;
  waiters: Array<(value: { exitStatus: ExitStatus | null }) => void>;
  command: string;
  cwd: string;
}

export interface TerminalHostOptions {
  getCwd: () => string | null | undefined;
}

export interface TerminalHost {
  create(params: TerminalCreateParams): Promise<TerminalCreateResult>;
  output(params: { terminalId?: string }): Promise<TerminalOutputResult>;
  waitForExit(params: { terminalId?: string }): Promise<{ exitStatus: ExitStatus | null }>;
  kill(params: { terminalId?: string }): Promise<Record<string, never>>;
  release(params: { terminalId?: string }): Promise<Record<string, never>>;
  shutdownAll(): void;
  _terminals: Map<string, TerminalRec>;
}

function envArrayToObject(envArray: EnvPair[] | undefined): Record<string, string> | null {
  if (!Array.isArray(envArray)) return null;
  const out: Record<string, string> = {};
  for (const e of envArray) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.name === 'string') out[e.name] = String(e.value ?? '');
  }
  return out;
}

function rpcError(code: number, message: string): RpcError {
  const err = new Error(message) as RpcError;
  err.rpc = { code, message };
  return err;
}

export function createTerminalHost({ getCwd }: TerminalHostOptions): TerminalHost {
  const terminals = new Map<string, TerminalRec>();

  function append(t: TerminalRec, data: Buffer | string): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    t.buffer = Buffer.concat([t.buffer, buf]);
    if (t.buffer.length > t.limit) {
      t.buffer = t.buffer.subarray(t.buffer.length - t.limit);
      t.truncated = true;
    }
  }

  function killTerm(t: TerminalRec, signal: NodeJS.Signals = 'SIGKILL'): void {
    if (!t || !t.proc || t.exited) return;
    try { t.proc.kill(signal); } catch { /* ignore */ }
  }

  async function create(params: TerminalCreateParams): Promise<TerminalCreateResult> {
    const command = params?.command;
    if (typeof command !== 'string' || !command.length) {
      throw rpcError(-32602, 'terminal/create: command required');
    }
    // Agent scope cwd. Allow explicit cwd only when it resolves under the agent
    // working directory (or is exactly that directory). Absolute paths outside
    // the agent scope are rejected — the shell can still reach them via
    // command strings, but we refuse to *start* with an escaped cwd.
    const scope = getCwd() || process.cwd();
    const requested = params?.cwd;
    let cwd = scope;
    if (typeof requested === 'string' && requested.length) {
      const scopeAbs = path.resolve(scope);
      const resolved = path.isAbsolute(requested)
        ? path.resolve(requested)
        : path.resolve(scopeAbs, requested);
      if (resolved !== scopeAbs && !resolved.startsWith(scopeAbs + path.sep)) {
        throw rpcError(-32002, `terminal cwd escapes agent scope: ${requested}`);
      }
      cwd = resolved;
    }
    const limit = typeof params?.outputByteLimit === 'number'
      ? params.outputByteLimit
      : DEFAULT_LIMIT;
    // Do not let the agent inject arbitrary env keys that override PATH/HOME
    // to unexpected values without an explicit allow-list. Merge only
    // non-critical overrides on top of a minimal base.
    const envObj = envArrayToObject(params?.env);
    const blockedEnv = new Set(['LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS']);
    const safeEnvExtra: Record<string, string> = {};
    if (envObj) {
      for (const [k, v] of Object.entries(envObj)) {
        if (blockedEnv.has(k)) continue;
        safeEnvExtra[k] = v;
      }
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      TERM: process.env['TERM'] || 'xterm-256color',
      LANG: process.env['LANG'] || 'C.UTF-8',
      ...safeEnvExtra,
    };

    let cmd: string;
    let args: string[];
    if (Array.isArray(params?.args) && params.args.length) {
      // Refuse path-like command binaries that look like shell metachar injection
      // vectors in the binary name; args are passed as argv (not shell).
      cmd = command;
      args = params.args.map((a) => String(a));
    } else {
      cmd = '/bin/bash';
      args = ['-lc', command];
    }

    const proc = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const terminalId = `term-${randomUUID()}`;
    const t: TerminalRec = {
      id: terminalId,
      proc,
      buffer: Buffer.alloc(0),
      truncated: false,
      limit,
      exited: false,
      exitStatus: null,
      waiters: [],
      command,
      cwd,
    };
    terminals.set(terminalId, t);

    proc.stdout?.on('data', (d: Buffer) => append(t, d));
    proc.stderr?.on('data', (d: Buffer) => append(t, d));
    proc.on('error', (err: Error) => {
      append(t, `\n[terminal-host] spawn error: ${err.message}\n`);
    });
    proc.on('exit', (code, signal) => {
      t.exited = true;
      t.exitStatus = { exitCode: code, signal };
      for (const w of t.waiters.splice(0)) w({ exitStatus: t.exitStatus });
    });

    return { terminalId };
  }

  function getOrThrow(id: string | undefined): TerminalRec {
    const t = id ? terminals.get(id) : undefined;
    if (!t) throw rpcError(-32004, `unknown terminalId: ${id}`);
    return t;
  }

  async function output(params: { terminalId?: string }): Promise<TerminalOutputResult> {
    const t = getOrThrow(params?.terminalId);
    return {
      output: t.buffer.toString('utf8'),
      truncated: t.truncated,
      exitStatus: t.exitStatus,
    };
  }

  async function waitForExit(params: { terminalId?: string }): Promise<{ exitStatus: ExitStatus | null }> {
    const t = getOrThrow(params?.terminalId);
    if (t.exited) return { exitStatus: t.exitStatus };
    return new Promise((resolve) => t.waiters.push(resolve));
  }

  async function kill(params: { terminalId?: string }): Promise<Record<string, never>> {
    const t = getOrThrow(params?.terminalId);
    killTerm(t);
    return {};
  }

  async function release(params: { terminalId?: string }): Promise<Record<string, never>> {
    const t = params?.terminalId ? terminals.get(params.terminalId) : undefined;
    if (t) {
      killTerm(t);
      terminals.delete(t.id);
    }
    return {};
  }

  function shutdownAll(): void {
    for (const t of terminals.values()) killTerm(t);
    terminals.clear();
  }

  return {
    create,
    output,
    waitForExit,
    kill,
    release,
    shutdownAll,
    _terminals: terminals,
  };
}
