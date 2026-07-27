// Map a session cwd to a folder/repo project key + display label.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ProjectInfo {
  /** Stable group id (folder name or git root basename). */
  id: string;
  /** Human label for the Projects list. */
  label: string;
  /** Absolute cwd used for grouping. */
  cwd: string;
  /** True when we resolved a .git root. */
  isGit: boolean;
}

const overridesPath = (): string =>
  path.join(os.homedir(), '.grok-remote', 'projects.json');

function loadOverrides(): Record<string, string> {
  try {
    const raw = fs.readFileSync(overridesPath(), 'utf8');
    const j = JSON.parse(raw) as Record<string, string>;
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** Walk up from cwd looking for a .git directory (file or dir). */
export function findGitRoot(start: string): string | null {
  let cur = path.resolve(start || '.');
  for (let i = 0; i < 24; i++) {
    const git = path.join(cur, '.git');
    try {
      if (fs.existsSync(git)) return cur;
    } catch { /* ignore */ }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function projectForCwd(cwd: string | null | undefined): ProjectInfo {
  const abs = path.resolve(cwd || os.homedir());
  const overrides = loadOverrides();
  if (overrides[abs]) {
    return { id: overrides[abs], label: overrides[abs], cwd: abs, isGit: false };
  }

  const gitRoot = findGitRoot(abs);
  if (gitRoot) {
    const base = path.basename(gitRoot) || 'repo';
    const label = stripEmoji(overrides[gitRoot] || base);
    return { id: base, label, cwd: gitRoot, isGit: true };
  }

  // Special-case agent workspaces under ~/.grok-remote/agents
  if (abs.includes(`${path.sep}.grok-remote${path.sep}agents${path.sep}`)) {
    return { id: 'grok-remote', label: 'grok-remote', cwd: abs, isGit: false };
  }

  const base = path.basename(abs) || 'home';
  // Prefer "root" over empty-looking labels for /
  const label = stripEmoji(abs === '/' ? 'root' : (overrides[abs] || base));
  return { id: label, label, cwd: abs, isGit: false };
}

function stripEmoji(s: string): string {
  return String(s || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/^\s+|\s+$/g, '')
    || 'project';
}

export function groupSessionsByProject<T extends { cwd?: string; sessionId: string }>(
  sessions: T[],
): Array<{ project: ProjectInfo; sessions: T[] }> {
  const map = new Map<string, { project: ProjectInfo; sessions: T[] }>();
  for (const s of sessions) {
    const project = projectForCwd(s.cwd);
    const key = project.id;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { project, sessions: [] };
      map.set(key, bucket);
    }
    bucket.sessions.push(s);
  }
  // Sort projects by most recently updated session if present
  const groups = [...map.values()];
  groups.sort((a, b) => a.project.label.localeCompare(b.project.label));
  return groups;
}
