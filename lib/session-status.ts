// Derive phone-triage status for a main host session.

export type SessionTriageStatus = 'running' | 'waiting' | 'stuck' | 'done';

export interface StatusInput {
  /** Connected agent handle if any. */
  connected?: boolean;
  inFlight?: number;
  agentStatus?: string | null;
  /** ISO or date string of last activity. */
  lastSeen?: string | null;
  updated?: string | null;
  /** True when last known tool/turn failed. */
  lastFailed?: boolean;
  /** Session has no open tools and last turn completed. */
  lastCompleted?: boolean;
  /** Explicit permission wait. */
  awaitingPermission?: boolean;
  /**
   * False for cloud-only CLI "remote" rows with no files on this host.
   * Those are archives — never red "needs you" stuck.
   */
  hasLocalContent?: boolean;
}

const STUCK_MS = 45 * 60 * 1000; // 45m with no progress while "busy" → stuck

function ageMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  // Date-only strings (YYYY-MM-DD) parse as UTC midnight — still fine for day-scale triage.
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Date.now() - t;
}

/**
 * Heuristic status for the list chips.
 * Prefer live agent-handle signals; fall back to recency on disk.
 */
export function deriveSessionStatus(input: StatusInput): SessionTriageStatus {
  const status = (input.agentStatus || '').toLowerCase();
  const inFlight = typeof input.inFlight === 'number' ? input.inFlight : 0;
  const age = ageMs(input.lastSeen || input.updated);

  // Cloud archive / no host files: never "stuck" (can't resume mid-turn here).
  if (input.hasLocalContent === false && !input.connected) {
    return 'done';
  }

  if (input.awaitingPermission) return 'stuck';
  if (input.lastFailed && !input.connected) return 'stuck';

  if (input.connected) {
    if (inFlight > 0 || status === 'running' || status === 'starting') {
      if (age != null && age > STUCK_MS) return 'stuck';
      return 'running';
    }
    if (status === 'errored' || status === 'killed') return 'stuck';
    // connected + idle → ready for a nudge
    return 'waiting';
  }

  // Not connected: use history signals
  if (input.lastFailed) return 'stuck';
  if (status === 'errored' || status === 'killed') return 'stuck';

  // Mid-turn disconnect: recent host activity, incomplete work.
  // Do NOT use mere "agent imported" lastSeen — callers must pass host updated.
  if (!input.lastCompleted && age != null && age < 24 * 60 * 60 * 1000 && age > 30 * 60 * 1000) {
    return 'stuck';
  }

  if (input.lastCompleted || (age != null && age > 24 * 60 * 60 * 1000)) {
    return 'done';
  }

  // Default: ready for a nudge when opened
  return age != null && age < 6 * 60 * 60 * 1000 ? 'waiting' : 'done';
}

export function statusLabel(s: SessionTriageStatus): string {
  switch (s) {
    case 'running': return 'running';
    case 'waiting': return 'waiting';
    case 'stuck': return 'stuck';
    case 'done': return 'done';
  }
}
