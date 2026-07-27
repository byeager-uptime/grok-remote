// PM2 ecosystem for grok-remote.
// Run `pm2 start ecosystem.config.cjs` (the installer does this for you).
//
// Security defaults for this fork (see SECURITY_AUDIT.md):
//   - Prefer GROK_REMOTE_TOKEN_FILE over empty token
//   - Bind HOST=0.0.0.0 only when you also set a token (fail-closed otherwise)
//   - Default HOST remains 127.0.0.1 if nothing is set

const fs = require('fs');
const path = require('path');
const os = require('os');

function readDotEnv(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const out = {};
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      out[t.slice(0, i)] = t.slice(i + 1);
    }
    return out;
  } catch {
    return {};
  }
}

const fileEnv = readDotEnv(path.join(__dirname, '.env.pm2'));
const defaultTokenFile = path.join(os.homedir(), '.grok-remote', 'token');

const HOST =
  process.env.HOST ||
  process.env.GROK_REMOTE_HOST ||
  fileEnv.HOST ||
  fileEnv.GROK_REMOTE_HOST ||
  '127.0.0.1';

// Only wire token file when auth mode asks for tokens.
const authMode = (process.env.GROK_REMOTE_AUTH || fileEnv.GROK_REMOTE_AUTH || 'auto').toLowerCase();
const tokenRequired =
  process.env.GROK_REMOTE_TOKEN_REQUIRED === '1' ||
  fileEnv.GROK_REMOTE_TOKEN_REQUIRED === '1' ||
  authMode === 'token';

const GROK_REMOTE_TOKEN_FILE = tokenRequired
  ? (process.env.GROK_REMOTE_TOKEN_FILE ||
     fileEnv.GROK_REMOTE_TOKEN_FILE ||
     (fs.existsSync(defaultTokenFile) ? defaultTokenFile : ''))
  : (process.env.GROK_REMOTE_TOKEN_FILE || fileEnv.GROK_REMOTE_TOKEN_FILE || '');

module.exports = {
  apps: [
    {
      name: 'grok-remote',
      script: 'server.ts',
      interpreter: 'node',
      // Resolve tsx from local node_modules (absolute) so PM2 cwd quirks cannot
      // break --import resolution.
      interpreter_args: `--import ${path.join(__dirname, 'node_modules/tsx/dist/esm/index.mjs')}`,
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: Number(process.env.PORT || fileEnv.PORT || 7910),
        HOST,
        GROK_REMOTE_HOST: HOST,
        // Default: Tailscale is the login when bound to 100.x (see lib/auth.ts).
        GROK_REMOTE_AUTH: process.env.GROK_REMOTE_AUTH || fileEnv.GROK_REMOTE_AUTH || 'auto',
        GROK_REMOTE_TOKEN: process.env.GROK_REMOTE_TOKEN || fileEnv.GROK_REMOTE_TOKEN || '',
        GROK_REMOTE_TOKEN_FILE,
        GROK_REMOTE_TOKEN_REQUIRED: process.env.GROK_REMOTE_TOKEN_REQUIRED || fileEnv.GROK_REMOTE_TOKEN_REQUIRED || '',
        GROK_REMOTE_ALLOW_OPEN: process.env.GROK_REMOTE_ALLOW_OPEN || fileEnv.GROK_REMOTE_ALLOW_OPEN || '',
      },
      out_file: './logs/grok-remote.out.log',
      error_file: './logs/grok-remote.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
