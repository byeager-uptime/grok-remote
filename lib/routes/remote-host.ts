// Tiny host identity helper for /api/remote (avoids circular imports with server.ts).

import { spawnSync } from 'node:child_process';
import os from 'node:os';

export interface TailscaleIdentity {
  backend: string;
  dns: string;
  ip: string;
  hostname: string;
}

export function tailscaleIdentity(): TailscaleIdentity | null {
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as {
      Self?: { DNSName?: string; TailscaleIPs?: string[]; HostName?: string };
      BackendState?: string;
    };
    const self = j.Self || {};
    return {
      backend: j.BackendState || '',
      dns: (self.DNSName || '').replace(/\.$/, ''),
      ip: (self.TailscaleIPs && self.TailscaleIPs[0]) || '',
      hostname: self.HostName || os.hostname(),
    };
  } catch {
    return null;
  }
}
