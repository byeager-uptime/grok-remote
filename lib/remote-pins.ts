// Durable "working on" / favorite pins for phone Remote list.
// Stored separately from agent meta so CLI-only sessions can be pinned
// before they are imported as agents.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FILE = path.join(os.homedir(), '.grok-remote', 'remote-pins.json');

interface PinStore {
  /** sessionId → ISO pin time (for stable ordering) */
  pins: Record<string, string>;
}

function readStore(): PinStore {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(raw) as PinStore;
    if (j && j.pins && typeof j.pins === 'object') return j;
  } catch { /* missing */ }
  return { pins: {} };
}

function writeStore(store: PinStore): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2) + '\n');
}

export function listPins(): Record<string, string> {
  return { ...readStore().pins };
}

export function isPinned(sessionId: string): boolean {
  return !!readStore().pins[sessionId];
}

export function setPinned(sessionId: string, pinned: boolean): { sessionId: string; pinned: boolean } {
  if (!sessionId) throw new Error('sessionId required');
  const store = readStore();
  if (pinned) store.pins[sessionId] = new Date().toISOString();
  else delete store.pins[sessionId];
  writeStore(store);
  return { sessionId, pinned };
}
