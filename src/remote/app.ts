// Phone-first Remote shell — ChatGPT Remote visual language.
// Outline folder icons only. No emoji in project names or chrome.
// Only ship controls that do something. Live SSE for active threads.

import {
  iconBack, iconCompose, iconSearch, iconSend, iconMore,
  iconFolder, iconExternal, iconComputer, svgBtn,
} from './icons.js';

interface RemoteSession {
  sessionId: string;
  title: string;
  cwd: string;
  projectId: string;
  projectLabel: string;
  status: 'running' | 'waiting' | 'stuck' | 'done';
  updated: string;
  created: string;
  updatedAtMs?: number;
  source: string;
  local: boolean;
  model?: string;
  agentId?: string | null;
  connected?: boolean;
  pinned?: boolean;
}

interface ProjectGroup {
  projectId: string;
  projectLabel: string;
  cwd: string;
  isGit: boolean;
  sessions: RemoteSession[];
}

interface SessionsResponse {
  ok: boolean;
  stuckCount?: number;
  pinnedCount?: number;
  projects?: ProjectGroup[];
  pinned?: RemoteSession[];
  error?: string;
}

/**
 * Compact relative time: at most 2 digits + 1 unit letter.
 * 45s · 12m · 5h · 3d · 2w · 1y
 */
function formatAgo(ms: number | undefined | null): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${Math.min(99, Math.max(1, sec))}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${Math.min(99, min)}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${Math.min(99, hr)}h`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${Math.min(99, day)}d`;
  const week = Math.floor(day / 7);
  if (week < 52) return `${Math.min(99, week)}w`;
  const year = Math.floor(day / 365);
  return `${Math.min(99, Math.max(1, year))}y`;
}

type Route =
  | { name: 'home' }
  | { name: 'thread'; sessionId: string }
  | { name: 'new' };

interface HistEvent {
  event?: string;
  data?: {
    text?: string;
    update?: { content?: { text?: string }; sessionUpdate?: string };
    status?: string;
    message?: string;
  };
}

function parseRoute(): Route {
  const h = (location.hash || '#/remote').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[1] === 'new') return { name: 'new' };
  if ((parts[1] === 's' || parts[1] === 'session') && parts[2]) {
    return { name: 'thread', sessionId: decodeURIComponent(parts[2]) };
  }
  return { name: 'home' };
}

function navigate(hash: string): void {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { accept: 'application/json' } });
  const j = await r.json();
  if (!r.ok) throw new Error((j && (j as { error?: string }).error) || `HTTP ${r.status}`);
  return j as T;
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : '{}',
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j && (j as { error?: string }).error) || `HTTP ${r.status}`);
  return j as T;
}

function cleanLabel(s: string): string {
  return String(s || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/^\s+|\s+$/g, '')
    || 'project';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, unknown> | null,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = String(v);
      else if (k === 'html') node.innerHTML = String(v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** Escape + light markdown → HTML (headings, bold, code, lists, tables, images, links). */
function formatMessage(text: string, opts?: { sessionId?: string }): string {
  let s = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // fenced code
  s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code: string) =>
    `<pre class="rr-code">${code.replace(/^\n|\n$/g, '')}</pre>`);
  // inline code
  s = s.replace(/`([^`\n]+)`/g, '<code class="rr-icode">$1</code>');
  // images ![alt](src) — resolve session-relative paths (images/6.jpg) via Remote API
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    let url = src;
    if (
      opts?.sessionId &&
      !/^https?:\/\//i.test(src) &&
      !src.startsWith('data:') &&
      !src.startsWith('/')
    ) {
      url = `/api/remote/sessions/${encodeURIComponent(opts.sessionId)}/file?path=${encodeURIComponent(src)}`;
    }
    const safeAlt = alt.replace(/"/g, '&quot;');
    return `<img class="rr-img" src="${url}" alt="${safeAlt}" loading="lazy" decoding="async">`;
  });
  // bold / italic / strikethrough
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  // headings
  s = s.replace(/^######\s+(.+)$/gm, '<div class="rr-h6">$1</div>');
  s = s.replace(/^#####\s+(.+)$/gm, '<div class="rr-h6">$1</div>');
  s = s.replace(/^####\s+(.+)$/gm, '<div class="rr-h5">$1</div>');
  s = s.replace(/^###\s+(.+)$/gm, '<div class="rr-h5">$1</div>');
  s = s.replace(/^##\s+(.+)$/gm, '<div class="rr-h4">$1</div>');
  s = s.replace(/^#\s+(.+)$/gm, '<div class="rr-h4">$1</div>');
  // hr
  s = s.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr class="rr-hr">');
  // unordered + ordered list items
  s = s.replace(/^[-*]\s+(.+)$/gm, '<div class="rr-li">• $1</div>');
  s = s.replace(/^\d+\.\s+(.+)$/gm, '<div class="rr-li rr-li--num">$1</div>');
  // GFM tables (header + separator + rows); tolerate missing trailing |
  s = s.replace(/(?:^|\n)((?:\|.+\n)+)/g, (_m, block: string) => {
    const lines = block.trim().split('\n').filter(Boolean);
    if (lines.length < 2) return block;
    if (!/^\|?[\s:|-]+\|[\s:|-]*\|?$/.test(lines[1] || '')) return block;
    const parseRow = (line: string): string[] =>
      line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const head = parseRow(lines[0]!);
    if (head.length < 1) return block;
    const body = lines.slice(2).map(parseRow);
    let html = '<div class="rr-table-wrap"><table class="rr-table"><thead><tr>';
    for (const h of head) html += `<th>${h}</th>`;
    html += '</tr></thead><tbody>';
    for (const row of body) {
      html += '<tr>';
      for (let i = 0; i < head.length; i++) html += `<td>${row[i] ?? ''}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return `\n${html}\n`;
  });
  // links
  s = s.replace(
    /(https?:\/\/[^\s<&)]+)/g,
    '<a class="rr-link" href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  // paragraphs: double newlines
  s = s.split(/\n{2,}/).map((p) => {
    if (
      /^<(pre|div|ul|table|hr|img)/.test(p.trim()) ||
      p.includes('rr-table') ||
      p.includes('rr-hr') ||
      p.includes('rr-img')
    ) {
      return p;
    }
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join('');
  return s;
}

function userBubble(text: string): HTMLElement {
  return el('div', { class: 'rr-msg-user' }, text.slice(0, 4000));
}

function asstBubble(text: string, opts?: { showWho?: boolean; sessionId?: string }): HTMLElement {
  const box = el('div', { class: 'rr-msg-asst' });
  // ChatGPT is quiet — only label the first assistant turn in a streak
  if (opts?.showWho !== false) {
    box.appendChild(el('div', { class: 'rr-who' }, 'Grok'));
  }
  const body = el('div', { class: 'rr-body' }) as HTMLElement;
  body.innerHTML = formatMessage(text.slice(0, 16000), { sessionId: opts?.sessionId });
  box.appendChild(body);
  return box;
}

/** Collapse pure-repeat tokens: pongpongpong → pong */
function collapseRepeatedToken(s: string): string {
  const t = s.trim();
  if (t.length < 2 || t.length > 200) return t;
  const m = t.match(/^(.{1,40}?)\1+$/);
  return m ? m[1]! : t;
}

/**
 * Peel run-on fused short replies produced by reseed replaying chunks
 * without turn boundaries, e.g. "sendbtn-oknightoksendbtn-ok" → ["sendbtn-ok","nightok","sendbtn-ok"].
 */
function peelFusedShortReplies(text: string, knownShort: string[]): string[] {
  const t0 = text.trim();
  if (!t0 || /\s/.test(t0) || t0.length < 8) return [t0];
  const known = [...knownShort]
    .filter((k) => k.length >= 3 && k.length <= 48 && !/\s/.test(k))
    .sort((a, b) => b.length - a.length);
  // Known short reply embedded mid-string → split there first
  for (const k of known) {
    const idx = t0.indexOf(k, 1);
    if (idx > 0) {
      const first = t0.slice(0, idx);
      const rest = t0.slice(idx);
      return [first, ...peelFusedShortReplies(rest, knownShort)].filter(Boolean);
    }
  }
  for (const k of known) {
    if (t0.startsWith(k) && t0.length > k.length) {
      return [k, ...peelFusedShortReplies(t0.slice(k.length), knownShort)].filter(Boolean);
    }
  }
  return [t0];
}

/**
 * Parse NDJSON history into ordered turns.
 * Strong dedupe: seed/SSE/reseed often leave short duplicate asst lines
 * ("pong"×2) and fused short replies ("sendbtn-oknightoksendbtn-ok").
 */
function parseHistoryTurns(raw: string): Array<{ role: 'user' | 'asst'; text: string }> {
  const turns: Array<{ role: 'user' | 'asst'; text: string }> = [];
  let asst = '';
  const flush = (): void => {
    const t = asst.trim();
    if (t) turns.push({ role: 'asst', text: collapseRepeatedToken(t) });
    asst = '';
  };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev: HistEvent;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.event === 'user_message' && ev.data?.text) {
      flush();
      turns.push({ role: 'user', text: String(ev.data.text).trim() });
    } else if (ev.event === 'agent_message_chunk') {
      const t = ev.data?.update?.content?.text;
      if (t) asst += String(t);
    } else if (ev.event === 'prompt_complete' || ev.event === 'prompt_result') {
      flush();
    }
  }
  flush();

  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const out: typeof turns = [];
  const seenAsstShort = new Set<string>();
  const shortAssts: string[] = [];

  for (const t of turns) {
    let cur = t.role === 'asst'
      ? { ...t, text: collapseRepeatedToken(t.text) }
      : { ...t, text: t.text.trim() };
    if (!cur.text) continue;

    // Defuse run-on short replies into the first new token for this turn
    if (cur.role === 'asst') {
      const parts = peelFusedShortReplies(cur.text, shortAssts);
      if (parts.length >= 2) {
        // Prefer first part that is not an exact repeat of a prior short asst;
        // fall back to first part.
        const fresh = parts.find((p) => !seenAsstShort.has(norm(p))) || parts[0]!;
        cur = { role: 'asst', text: fresh };
      }
    }

    const prev = out[out.length - 1];

    // Drop exact consecutive duplicates (user or asst)
    if (prev && prev.role === cur.role && norm(prev.text) === norm(cur.text)) continue;

    if (cur.role === 'asst') {
      // Prefix / containment: keep longer form only
      if (prev && prev.role === 'asst') {
        const a = prev.text;
        const b = cur.text;
        if (b.startsWith(a) || a.startsWith(b)) {
          if (b.length >= a.length) out[out.length - 1] = cur;
          continue;
        }
        // Fused short replies: pure concat of prior assts
        if (b.length < 120) {
          let isFused = false;
          for (let i = 0; i < shortAssts.length && !isFused; i++) {
            for (let j = 0; j < shortAssts.length; j++) {
              const x = shortAssts[i]!;
              const y = shortAssts[j]!;
              if (b === x + y || b === y + x || b === x + y + x || b === y + x + y) {
                isFused = true;
                break;
              }
            }
          }
          if (isFused) continue;
          // starts with prior short asst + more garbage
          for (const x of shortAssts) {
            if (x.length >= 3 && b.startsWith(x) && b.length > x.length && b.length < x.length + 48) {
              const rest = b.slice(x.length);
              if (shortAssts.some((y) => rest === y || rest.startsWith(y))) {
                isFused = true;
                break;
              }
            }
          }
          if (isFused) continue;
        }
      }

      // Short identical assistant replies anywhere (seed garbage)
      if (cur.text.length <= 64) {
        const key = norm(cur.text);
        if (seenAsstShort.has(key)) continue;
        seenAsstShort.add(key);
        shortAssts.push(cur.text);
      }
    }

    if (prev && prev.role === 'user' && cur.role === 'user' && norm(prev.text) === norm(cur.text)) {
      continue;
    }

    out.push(cur);
  }
  return out;
}

export class RemoteApp {
  root: HTMLElement;
  hostLabel = 'hermes-agent';
  projects: ProjectGroup[] = [];
  pinned: RemoteSession[] = [];
  stuckCount = 0;
  loading = false;
  error: string | null = null;
  collapsed = new Set<string>();
  /** Hide cloud archives behind a toggle by default (phone triage = local first). */
  showCloudArchives = false;
  searchQuery = '';
  searchOpen = false;
  private _es: EventSource | null = null;
  private _threadAgentId: string | null = null;
  private _liveAsstEl: HTMLElement | null = null;
  private _liveAsstText = '';
  private _statusEl: HTMLElement | null = null;
  /** True once this user turn already received assistant text (SSE or poll). */
  private _turnGotAsst = false;
  private _listPoll: ReturnType<typeof setInterval> | null = null;
  private _histPoll: ReturnType<typeof setInterval> | null = null;
  private _sending = false;
  private _vvBound = false;
  private _visBound = false;
  private _lastHistFingerprint = '';
  private _hostHistMtimeMs = 0;
  private _threadScroll: HTMLElement | null = null;
  /** Last assistant text painted from history — used to ignore SSE replay. */
  private _seedAsstTail = '';
  /** Suppress stream chunks that only re-deliver seeded history. */
  private _streamPriming = false;
  /**
   * Only paint SSE agent_message_chunk when true.
   * False after open/refresh (history already painted); true after user send
   * or when opening an already-running agent. Prevents fused replay bubbles
   * like nightok+sendbtn-ok → "nightoksendbtn-ok".
   */
  private _acceptStream = false;
  /** Current thread session id — used to resolve images/6.jpg etc. */
  private _threadSessionId: string | null = null;

  constructor() {
    this.root = el('div', { class: 'rr-app' });
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
    window.addEventListener('hashchange', () => void this.render());
    this.bindVisualViewport();
    void this.bootstrap();
  }

  /**
   * iOS PWA keyboard + status-bar layout.
   * Pin the shell to visualViewport so the header never slides under the
   * Dynamic Island and the composer sits flush above the keyboard.
   */
  private bindVisualViewport(): void {
    if (this._vvBound) return;
    this._vvBound = true;
    const apply = (): void => {
      const vv = window.visualViewport;
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      document.documentElement.style.setProperty('--rr-vvh', `${Math.round(h)}px`);
      document.documentElement.style.setProperty('--rr-vvo', `${Math.round(top)}px`);
      // Keyboard open if the visual viewport is meaningfully shorter than layout.
      const kb = (window.innerHeight - h) > 120 || (vv != null && vv.height < window.innerHeight * 0.75);
      document.body.classList.toggle('rr-kb', kb);
    };
    apply();
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    // focusin/out covers cases where visualViewport lags
    window.addEventListener('focusin', (ev) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
        document.body.classList.add('rr-kb');
        // After keyboard animates, re-measure
        setTimeout(apply, 50);
        setTimeout(apply, 300);
      }
    });
    window.addEventListener('focusout', () => {
      setTimeout(() => {
        apply();
        // Clear kb class if nothing focused
        const a = document.activeElement as HTMLElement | null;
        if (!a || (a.tagName !== 'INPUT' && a.tagName !== 'TEXTAREA')) {
          // re-apply will set based on size; don't force off early
        }
      }, 100);
    });
  }

  private openOverflowMenu(items: Array<{ label: string; action: () => void; danger?: boolean }>): void {
    const close = (): void => { backdrop.remove(); };
    const sheet = el('div', { class: 'rr-menu-sheet' });
    for (const it of items) {
      const b = el('button', {
        class: it.danger ? 'rr-menu-item rr-menu-item--danger' : 'rr-menu-item',
        type: 'button',
      }, it.label) as HTMLButtonElement;
      b.onclick = () => { close(); it.action(); };
      sheet.appendChild(b);
    }
    const cancel = el('button', { class: 'rr-menu-cancel', type: 'button' }, 'Cancel') as HTMLButtonElement;
    cancel.onclick = close;
    sheet.appendChild(cancel);
    const backdrop = el('div', { class: 'rr-menu-backdrop' }, sheet);
    backdrop.onclick = (ev) => { if (ev.target === backdrop) close(); };
    this.root.appendChild(backdrop);
  }

  /**
   * Pull-to-refresh.
   * - mode 'down': classic pull-down at top (session list)
   * - mode 'up': pull-up at bottom of thread (chat is usually scrolled to latest)
   */
  private attachPullToRefresh(
    scroll: HTMLElement,
    onRefresh: () => Promise<void>,
    mode: 'down' | 'up' = 'down',
  ): void {
    const ptr = el('div', {
      class: mode === 'up' ? 'rr-ptr rr-ptr--bottom' : 'rr-ptr',
    }, mode === 'up' ? 'Pull up to refresh' : 'Pull to refresh');
    if (mode === 'up') scroll.appendChild(ptr);
    else scroll.prepend(ptr);

    let startY = 0;
    let pulling = false;
    let armed = false;
    const idleLabel = mode === 'up' ? 'Pull up to refresh' : 'Pull to refresh';

    const atBottom = (): boolean =>
      scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 24;
    const atTop = (): boolean => scroll.scrollTop <= 0;

    scroll.addEventListener('touchstart', (ev) => {
      if (mode === 'down' && !atTop()) { pulling = false; return; }
      if (mode === 'up' && !atBottom()) { pulling = false; return; }
      startY = ev.touches[0]?.clientY || 0;
      pulling = true;
      armed = false;
    }, { passive: true });

    scroll.addEventListener('touchmove', (ev) => {
      if (!pulling) return;
      const y = ev.touches[0]?.clientY || 0;
      const dy = y - startY;
      // down: finger moves down (dy>0) at top; up: finger moves up (dy<0) at bottom
      const dist = mode === 'down' ? dy : -dy;
      const inZone = mode === 'down' ? atTop() : atBottom();
      if (dist > 12 && inZone) {
        ptr.classList.add('rr-ptr--active');
        if (dist > 56) {
          ptr.textContent = 'Release to refresh';
          ptr.classList.add('rr-ptr--ready');
          armed = true;
        } else {
          ptr.textContent = idleLabel;
          ptr.classList.remove('rr-ptr--ready');
          armed = false;
        }
      }
    }, { passive: true });

    scroll.addEventListener('touchend', () => {
      if (!pulling) return;
      pulling = false;
      const doIt = armed;
      ptr.classList.remove('rr-ptr--active', 'rr-ptr--ready');
      ptr.textContent = idleLabel;
      if (doIt) {
        ptr.classList.add('rr-ptr--active');
        ptr.textContent = 'Refreshing…';
        void onRefresh().finally(() => {
          ptr.classList.remove('rr-ptr--active');
          ptr.textContent = idleLabel;
        });
      }
      armed = false;
    }, { passive: true });
  }

  private stopHistPoll(): void {
    if (this._histPoll) {
      clearInterval(this._histPoll);
      this._histPoll = null;
    }
  }

  /** Content fingerprint — stable across reseed rewrites of identical transcript. */
  private turnsFingerprint(turns: Array<{ role: string; text: string }>): string {
    if (!turns.length) return '0';
    const head = turns.slice(0, 3).map((t) => `${t.role}:${t.text.slice(0, 40)}`).join('|');
    const tail = turns.slice(-5).map((t) => `${t.role}:${t.text.slice(0, 80)}`).join('|');
    return `${turns.length}:${head}::${tail}`;
  }

  /** While a thread is open: poll history + refresh on tab focus so long-lived PWAs stay current. */
  private startThreadSync(agentId: string, scroll: HTMLElement): void {
    this.stopHistPoll();
    this._threadScroll = scroll;
    const sessionId = this._threadSessionId || agentId;

    const sync = async (reason: string): Promise<void> => {
      if (parseRoute().name !== 'thread') return;
      if (this._sending || this._liveAsstText) return; // don't clobber live stream mid-token
      try {
        // Reseed only when host chat_history may have changed.
        // Reseeding every poll rewrote history and caused the 20–30s scroll jump.
        if (reason === 'poll' || reason === 'visibility') {
          try {
            const r = await apiPost<{ hostMtimeMs?: number }>(
              `/api/remote/sessions/${encodeURIComponent(sessionId)}/reseed`,
              {},
            );
            if (typeof r.hostMtimeMs === 'number') {
              if (r.hostMtimeMs === this._hostHistMtimeMs && reason === 'poll') {
                return; // host unchanged
              }
              this._hostHistMtimeMs = r.hostMtimeMs;
            }
          } catch { /* no local dir */ }
        }
        const histRes = await fetch(`/api/agents/${encodeURIComponent(agentId)}/history?turns=200`, {
          headers: { accept: 'application/x-ndjson' },
        });
        if (!histRes.ok) return;
        const raw = await histRes.text();
        const turns = parseHistoryTurns(raw);
        const fp = this.turnsFingerprint(turns);
        if (fp === this._lastHistFingerprint) return;
        this._lastHistFingerprint = fp;
        const prevTop = scroll.scrollTop;
        const prevHeight = scroll.scrollHeight;
        const nearBottom = prevTop + scroll.clientHeight >= prevHeight - 80;
        this.paintTurns(scroll, turns, { skipQuote: true });
        requestAnimationFrame(() => {
          if (nearBottom) {
            scroll.scrollTop = scroll.scrollHeight;
          } else {
            const delta = scroll.scrollHeight - prevHeight;
            if (Math.abs(delta) < 8) scroll.scrollTop = prevTop;
            else scroll.scrollTop = Math.max(0, prevTop);
          }
        });
        if (reason === 'visibility') this.toast('Conversation updated');
      } catch { /* ignore */ }
    };

    this._histPoll = setInterval(() => { void sync('poll'); }, 25_000);

    if (!this._visBound) {
      this._visBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this._threadAgentId) {
          void sync('visibility');
          // Re-open SSE after background (iOS often kills EventSource)
          if (this._threadAgentId && this._threadScroll) {
            this.connectStream(this._threadAgentId, this._threadScroll);
          }
        }
      });
    }
  }

  private startListPoll(): void {
    if (this._listPoll) return;
    this._listPoll = setInterval(() => {
      if (parseRoute().name !== 'home') return;
      void this.loadSessionsQuiet().then(() => {
        if (parseRoute().name === 'home') this.renderHome();
      });
    }, 20000);
  }

  /** Background refresh — no loading flash. */
  async loadSessionsQuiet(): Promise<void> {
    try {
      const data = await apiGet<SessionsResponse>('/api/remote/sessions?limit=50');
      this.projects = (data.projects || []).map((g) => ({
        ...g,
        projectLabel: cleanLabel(g.projectLabel),
      }));
      this.pinned = data.pinned || [];
      this.stuckCount = data.stuckCount || 0;
      this.error = null;
    } catch { /* keep last good list */ }
  }

  async togglePin(sessionId: string, next: boolean): Promise<void> {
    try {
      await apiPost(`/api/remote/sessions/${encodeURIComponent(sessionId)}/pin`, { pinned: next });
      await this.loadSessionsQuiet();
      if (parseRoute().name === 'home') this.renderHome();
      this.toast(next ? 'Pinned — Working on' : 'Unpinned');
    } catch (e) {
      this.toast(e instanceof Error ? e.message : 'Pin failed');
    }
  }

  private renderSessionRow(s: RemoteSession, scroll: HTMLElement, opts?: { inWorkingOn?: boolean }): void {
    const row = el('div', { class: `rr-thread-row${s.pinned ? ' rr-thread-row--pinned' : ''}` });
    const thr = el('button', { class: 'rr-thread', type: 'button' }) as HTMLButtonElement;
    thr.onclick = () => navigate(`#/remote/s/${encodeURIComponent(s.sessionId)}`);
    // Always status dot on the left — pin lives only on the right (no double ★)
    thr.appendChild(el('span', { class: `rr-st rr-st--${s.status}` }));
    thr.appendChild(el('span', { class: 'rr-thread-t' }, s.title));
    const ago = formatAgo(s.updatedAtMs);
    if (ago) thr.appendChild(el('span', { class: 'rr-ago' }, ago));
    row.appendChild(thr);

    // Pin control — separate hit target, does not open thread
    const pinBtn = el('button', {
      class: `rr-pin-btn${s.pinned ? ' rr-pin-btn--on' : ''}`,
      type: 'button',
      'aria-label': s.pinned ? 'Unpin session' : 'Pin session',
      title: s.pinned ? 'Unpin' : 'Pin as working on',
    }, s.pinned ? '★' : '☆') as HTMLButtonElement;
    pinBtn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this.togglePin(s.sessionId, !s.pinned);
    };
    row.appendChild(pinBtn);
    if (opts?.inWorkingOn) row.setAttribute('data-working-on', '1');
    scroll.appendChild(row);
  }

  private stopListPoll(): void {
    if (this._listPoll) {
      clearInterval(this._listPoll);
      this._listPoll = null;
    }
  }

  private closeStream(): void {
    if (this._es) {
      try { this._es.close(); } catch { /* ignore */ }
      this._es = null;
    }
    this.stopHistPoll();
    this._liveAsstEl = null;
    this._liveAsstText = '';
    this._statusEl = null;
    this._threadAgentId = null;
    this._turnGotAsst = false;
    this._threadScroll = null;
    this._lastHistFingerprint = '';
    this._hostHistMtimeMs = 0;
    this._seedAsstTail = '';
    this._streamPriming = false;
    this._acceptStream = false;
    // keep _threadSessionId — soft reconnect still needs image URL resolution
  }

  async bootstrap(): Promise<void> {
    try {
      const hello = await apiGet<{ hostLabel?: string; host?: string }>('/api/remote/hello');
      const raw = hello.hostLabel || hello.host || 'hermes-agent';
      this.hostLabel = raw.replace(/\.$/, '').split('.')[0] || raw;
    } catch { /* keep default */ }
    await this.loadSessions();
    await this.render();
  }

  async loadSessions(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const data = await apiGet<SessionsResponse>('/api/remote/sessions?limit=50');
      this.projects = (data.projects || []).map((g) => ({
        ...g,
        projectLabel: cleanLabel(g.projectLabel),
      }));
      this.pinned = data.pinned || [];
      this.stuckCount = data.stuckCount || 0;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.projects = [];
      this.pinned = [];
    } finally {
      this.loading = false;
    }
  }

  async render(): Promise<void> {
    this.closeStream();
    const route = parseRoute();
    this.root.replaceChildren();
    if (route.name === 'thread') {
      this.stopListPoll();
      await this.renderThread(route.sessionId);
      return;
    }
    if (route.name === 'new') {
      this.stopListPoll();
      this.renderNewTask();
      return;
    }
    this.startListPoll();
    this.renderHome();
  }

  private toast(msg: string): void {
    const t = el('div', { class: 'rr-toast' }, msg);
    this.root.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  renderHome(): void {
    // Safe to re-call from search/filter without full route render
    this.root.replaceChildren();
    const header = el('div', { class: 'rr-header rr-header--simple' });
    // Left: search (real action). Right: ⋯ menu (refresh lives there + pull-to-refresh).
    const searchBtn = svgBtn(iconSearch(), 'rr-circ', 'Search sessions');
    searchBtn.onclick = () => {
      this.searchOpen = !this.searchOpen;
      if (!this.searchOpen) this.searchQuery = '';
      this.renderHome();
    };
    header.appendChild(searchBtn);
    header.appendChild(
      el('div', { class: 'rr-header-center' },
        el('div', { class: 'rr-header-title' }, 'Remote'),
        el('div', { class: 'rr-header-host' },
          el('span', { class: 'rr-host-dot' }),
          (() => {
            const span = document.createElement('span');
            span.innerHTML = iconComputer();
            span.style.display = 'inline-flex';
            return span;
          })(),
          this.hostLabel,
        ),
      ),
    );
    const moreHome = svgBtn(iconMore(), 'rr-circ', 'More options');
    moreHome.onclick = () => this.openOverflowMenu([
      {
        label: 'Refresh sessions',
        action: () => { void this.loadSessions().then(() => this.render()); },
      },
      {
        label: this.searchOpen ? 'Hide search' : 'Search sessions',
        action: () => {
          this.searchOpen = !this.searchOpen;
          if (!this.searchOpen) this.searchQuery = '';
          this.renderHome();
        },
      },
      { label: 'New task', action: () => navigate('#/remote/new') },
      {
        label: 'Reload app',
        action: () => { location.reload(); },
      },
      {
        label: 'Advanced console',
        action: () => { location.hash = '#/advanced'; location.reload(); },
      },
    ]);
    header.appendChild(moreHome);

    const scroll = el('div', { class: 'rr-scroll' });
    this.attachPullToRefresh(scroll, async () => {
      await this.loadSessions();
      this.renderHome();
      this.toast('Sessions refreshed');
    });
    scroll.appendChild(el('h1', { class: 'rr-h1' }, 'Projects'));

    if (this.searchOpen) {
      const wrap = el('div', { class: 'rr-search-wrap' });
      const inp = document.createElement('input');
      inp.type = 'search';
      inp.className = 'rr-search-input';
      inp.placeholder = 'Filter sessions';
      inp.value = this.searchQuery;
      inp.autocomplete = 'off';
      inp.setAttribute('aria-label', 'Filter sessions');
      // Debounced re-render so agent-browser / typing don't thrash mid-keystroke
      let t: ReturnType<typeof setTimeout> | null = null;
      inp.oninput = () => {
        this.searchQuery = inp.value;
        if (t) clearTimeout(t);
        t = setTimeout(() => {
          const q = this.searchQuery;
          this.renderHome();
          const again = this.root.querySelector('.rr-search-input') as HTMLInputElement | null;
          if (again) {
            again.value = q;
            this.searchQuery = q;
            again.focus();
            const len = again.value.length;
            again.setSelectionRange(len, len);
          }
        }, 180);
      };
      wrap.appendChild(inp);
      scroll.appendChild(wrap);
      requestAnimationFrame(() => inp.focus());
    }

    if (this.stuckCount > 0) {
      scroll.appendChild(el('div', { class: 'rr-banner' },
        `${this.stuckCount} need${this.stuckCount === 1 ? 's' : ''} you`,
      ));
    }

    const q = this.searchQuery.trim().toLowerCase();
    const filterSession = (s: RemoteSession): boolean => {
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q) ||
        (s.cwd || '').toLowerCase().includes(q)
      );
    };

    // Split local vs cloud archive for phone triage.
    // Pinned sessions live only in "Working on" — do not also list them under projects.
    type G = ProjectGroup;
    const pinnedIds = new Set(this.pinned.map((p) => p.sessionId));
    const localGroups: G[] = [];
    const cloudGroups: G[] = [];
    for (const g of this.projects) {
      const localS = g.sessions.filter(
        (s) => s.local !== false && filterSession(s) && !pinnedIds.has(s.sessionId),
      );
      const cloudS = g.sessions.filter(
        (s) => s.local === false && filterSession(s) && !pinnedIds.has(s.sessionId),
      );
      if (localS.length) localGroups.push({ ...g, sessions: localS });
      if (cloudS.length) cloudGroups.push({ ...g, sessions: cloudS });
    }

    const pinnedFiltered = this.pinned.filter(filterSession);

    const renderGroups = (groups: G[], prefix: string): void => {
      for (const g of groups) {
        const collapseKey = `${prefix}:${g.projectId}`;
        const collapsed = this.collapsed.has(collapseKey);
        const row = el('div', { class: 'rr-proj-row' });
        const head = el('button', { class: 'rr-proj-head', type: 'button' }) as HTMLButtonElement;
        head.innerHTML = iconFolder();
        head.appendChild(el('span', { class: 'rr-proj-name' }, cleanLabel(g.projectLabel)));
        const chev = el('span', { class: 'rr-proj-chev', 'aria-hidden': 'true' }, collapsed ? '▸' : '▾');
        head.appendChild(chev);
        head.onclick = () => {
          if (this.collapsed.has(collapseKey)) this.collapsed.delete(collapseKey);
          else this.collapsed.add(collapseKey);
          this.renderHome();
        };
        const ext = document.createElement('button');
        ext.type = 'button';
        ext.className = 'rr-proj-ext';
        ext.setAttribute('aria-label', 'Show project path');
        ext.innerHTML = iconExternal();
        ext.onclick = (ev) => {
          ev.stopPropagation();
          this.toast(g.cwd || cleanLabel(g.projectLabel));
        };
        row.appendChild(head);
        row.appendChild(ext);
        scroll.appendChild(row);

        if (collapsed) continue;
        for (const s of g.sessions) this.renderSessionRow(s, scroll);
      }
    };

    // Hierarchy: Working on → On this host → cloud archive (footer of list)
    if (pinnedFiltered.length && !this.loading) {
      scroll.appendChild(el('div', { class: 'rr-section-label rr-section-label--pin' }, 'Working on'));
      for (const s of pinnedFiltered) this.renderSessionRow(s, scroll, { inWorkingOn: true });
    }

    if (this.loading && !this.projects.length) {
      scroll.appendChild(el('div', { class: 'rr-muted' }, 'Loading…'));
    } else if (this.error && !this.projects.length) {
      scroll.appendChild(el('div', { class: 'rr-error' }, this.error));
      const retry = el('button', { class: 'rr-btn', type: 'button' }, 'Retry') as HTMLButtonElement;
      retry.onclick = () => void this.bootstrap();
      scroll.appendChild(retry);
    } else if (!localGroups.length && !cloudGroups.length && !pinnedFiltered.length) {
      scroll.appendChild(el('div', { class: 'rr-muted' },
        q ? 'No sessions match your search.' : 'No main sessions yet. Start work on the host or use New.',
      ));
    } else {
      if (localGroups.length) {
        if (pinnedFiltered.length || cloudGroups.length) {
          scroll.appendChild(el('div', { class: 'rr-section-label' }, 'On this host'));
        }
        renderGroups(localGroups, 'local');
      }
      // Cloud at end of scroll content (not between Working on and host).
      // Extra bottom padding on .rr-scroll keeps toggle above sticky dock.
      if (cloudGroups.length) {
        const n = cloudGroups.reduce((a, g) => a + g.sessions.length, 0);
        const toggle = el('button', {
          class: 'rr-archive-toggle',
          type: 'button',
        }, this.showCloudArchives
          ? `Hide cloud archive (${n})`
          : `Show cloud archive (${n})`) as HTMLButtonElement;
        toggle.onclick = () => {
          this.showCloudArchives = !this.showCloudArchives;
          this.renderHome();
        };
        scroll.appendChild(toggle);
        if (this.showCloudArchives) renderGroups(cloudGroups, 'cloud');
      }
    }

    const bottom = el('div', { class: 'rr-bottom' });
    const hostPill = el('button', { class: 'rr-chats-pill', type: 'button' }) as HTMLButtonElement;
    hostPill.textContent = this.hostLabel;
    hostPill.title = 'Refresh session list';
    hostPill.onclick = () => void this.loadSessions().then(() => this.render());
    const actions = el('div', { class: 'rr-bottom-actions' });
    // No dead mic — only real controls (New task)
    const neu = svgBtn(iconCompose(), 'rr-circ rr-circ--white', 'New task');
    neu.onclick = () => navigate('#/remote/new');
    actions.appendChild(neu);
    bottom.appendChild(hostPill);
    bottom.appendChild(actions);

    const foot = el('div', { class: 'rr-foot' });
    const adv = el('a', { href: '#/advanced', class: 'rr-adv-link' }, 'Advanced console') as HTMLAnchorElement;
    adv.addEventListener('click', (ev) => {
      ev.preventDefault();
      location.hash = '#/advanced';
      location.reload();
    });
    foot.appendChild(adv);

    this.root.appendChild(header);
    this.root.appendChild(scroll);
    this.root.appendChild(bottom);
    this.root.appendChild(foot);
  }

  private paintTurns(scroll: HTMLElement, turns: Array<{ role: 'user' | 'asst'; text: string }>, opts?: {
    stuckLabel?: string | null;
    infoBanner?: string | null;
    skipQuote?: boolean;
  }): void {
    // Keep pull-to-refresh nodes if present (top and/or bottom)
    const ptrs = [...scroll.querySelectorAll('.rr-ptr')];
    scroll.replaceChildren();
    for (const p of ptrs) {
      if (p.classList.contains('rr-ptr--bottom')) continue; // re-append after content
      scroll.appendChild(p);
    }
    const bottomPtrs = ptrs.filter((p) => p.classList.contains('rr-ptr--bottom'));
    if (opts?.stuckLabel) {
      scroll.appendChild(el('div', { class: 'rr-soft-stuck' }, opts.stuckLabel));
    }
    if (opts?.infoBanner) {
      scroll.appendChild(el('div', { class: 'rr-info-banner' }, opts.infoBanner));
    }
    // Quote only for long first user messages that are not already fully in the bubble
    if (!opts?.skipQuote) {
      const firstUser = turns.find((t) => t.role === 'user');
      const asstCount = turns.filter((t) => t.role === 'asst').length;
      if (firstUser && asstCount >= 1 && firstUser.text.length > 200) {
        const q = firstUser.text;
        scroll.appendChild(el('div', { class: 'rr-quote' },
          `"${q.slice(0, 280)}${q.length > 280 ? '…' : ''}"`,
        ));
      }
    }
    if (!turns.length) {
      scroll.appendChild(el('div', { class: 'rr-muted' },
        'No messages yet. Type a nudge below.',
      ));
    } else {
      let lastRole: 'user' | 'asst' | null = null;
      const sid = this._threadSessionId || undefined;
      for (const t of turns) {
        if (t.role === 'user') {
          scroll.appendChild(userBubble(t.text));
        } else {
          // Quiet ChatGPT-style: "Grok" only on first asst after a user
          scroll.appendChild(asstBubble(t.text, { showWho: lastRole !== 'asst', sessionId: sid }));
        }
        lastRole = t.role;
      }
    }
    const lastAsst = [...turns].reverse().find((t) => t.role === 'asst');
    this._seedAsstTail = lastAsst?.text || '';
    this._liveAsstEl = null;
    this._liveAsstText = '';
    for (const p of bottomPtrs) scroll.appendChild(p);
  }

  private insertBeforeBottomPtr(scroll: HTMLElement, node: HTMLElement): void {
    const bottom = scroll.querySelector('.rr-ptr--bottom');
    if (bottom) scroll.insertBefore(node, bottom);
    else scroll.appendChild(node);
  }

  private appendLiveAsst(scroll: HTMLElement, chunk: string): void {
    // Hard gate: do not paint stream until a new user turn (or running open).
    // SSE reconnect often replays every historical agent_message_chunk and
    // would otherwise fuse them into a garbage bubble after seeded history.
    if (!this._acceptStream && !this._sending) return;

    // Extra safety while priming after connect
    if (this._streamPriming && !this._sending && !this._turnGotAsst && this._seedAsstTail) {
      const next = (this._liveAsstText + chunk).trim();
      const seed = this._seedAsstTail.trim();
      if (
        !next ||
        seed === next ||
        seed.endsWith(next) ||
        seed.endsWith(chunk.trim()) ||
        (next.length <= 64 && seed.includes(next))
      ) {
        return;
      }
    }
    const nearBottom =
      scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 120;
    this._liveAsstText += chunk;
    this._turnGotAsst = true;
    const sid = this._threadSessionId || undefined;
    if (!this._liveAsstEl) {
      this._liveAsstEl = asstBubble(this._liveAsstText, { showWho: true, sessionId: sid });
      this.insertBeforeBottomPtr(scroll, this._liveAsstEl);
    } else {
      const body = this._liveAsstEl.querySelector('.rr-body') as HTMLElement | null;
      if (body) body.innerHTML = formatMessage(this._liveAsstText.slice(0, 16000), { sessionId: sid });
    }
    // Never yank the user mid-read (was jumping every poll / stream tick)
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  private setStatus(scroll: HTMLElement, text: string | null): void {
    const nearBottom =
      scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 120;
    if (this._statusEl) {
      this._statusEl.remove();
      this._statusEl = null;
    }
    if (!text) return;
    this._statusEl = el('div', { class: 'rr-muted rr-live-status' }, text);
    this.insertBeforeBottomPtr(scroll, this._statusEl);
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  private connectStream(agentId: string, scroll: HTMLElement): void {
    // Preserve seed tail across reconnect (closeStream clears agent id only)
    const seedTail = this._seedAsstTail;
    this.closeStream();
    this._seedAsstTail = seedTail;
    this._threadAgentId = agentId;
    this._streamPriming = true;
    window.setTimeout(() => { this._streamPriming = false; }, 1200);
    const es = new EventSource(`/api/agents/${encodeURIComponent(agentId)}/stream`);
    this._es = es;

    // Server writes named SSE events: event: agent_message_chunk\ndata: {...payload}
    // Payload is the ring entry's `data` field (not the wrapper).
    const onNamed = (name: string, raw: string): void => {
      let data: HistEvent['data'] & {
        text?: string;
        status?: string;
        message?: string;
        update?: { content?: { text?: string } };
      };
      try { data = JSON.parse(raw); } catch { return; }

      if (name === 'agent_message_chunk') {
        const t = data?.update?.content?.text || data?.text;
        if (t) {
          this.setStatus(scroll, null);
          this.appendLiveAsst(scroll, String(t));
          // Keep view pinned to streaming tokens when user is following live
          const nearBottom =
            scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 120;
          if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
        }
        return;
      }
      if (name === 'agent_status') {
        const st = data?.status || '';
        if (st === 'running' || st === 'starting') {
          this.setStatus(scroll, 'Working on host…');
        } else if (st === 'idle' || st === 'disconnected') {
          this.setStatus(scroll, null);
        } else if (st === 'errored') {
          this.setStatus(scroll, null);
          scroll.appendChild(el('div', { class: 'rr-error' }, data?.message || 'Agent error'));
        }
        return;
      }
      if (name === 'error') {
        scroll.appendChild(el('div', { class: 'rr-error' }, data?.message || 'Error'));
        return;
      }
      if (name === 'prompt_complete' || name === 'prompt_result') {
        this.setStatus(scroll, null);
        // Keep painted bubble; next user send resets buffer.
      }
    };

    for (const name of [
      'agent_message_chunk',
      'agent_status',
      'error',
      'prompt_complete',
      'prompt_result',
      'user_message',
    ]) {
      es.addEventListener(name, (ev) => {
        const me = ev as MessageEvent;
        if (me.data) onNamed(name, String(me.data));
      });
    }
    // Fallback for unnamed events (full ring wrapper)
    es.onmessage = (msg) => {
      if (!msg.data) return;
      try {
        const wrapped = JSON.parse(msg.data) as { event?: string; data?: unknown };
        if (wrapped.event && wrapped.data != null) {
          onNamed(wrapped.event, JSON.stringify(wrapped.data));
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => {
      // browser will retry; don't spam UI
    };
  }

  async renderThread(sessionId: string): Promise<void> {
    // CRITICAL: never stack chrome. Soft-refresh and pull-up used to re-append
    // a full shell → triple headers/composers (user dogfood screenshot).
    this.closeStream();
    this.root.replaceChildren();
    this._threadSessionId = sessionId;

    let title = sessionId.slice(0, 8);
    let listStatus: RemoteSession['status'] | null = null;
    let isLocalList = true;
    let isPinned = this.pinned.some((p) => p.sessionId === sessionId);
    for (const g of this.projects) {
      const hit = g.sessions.find((s) => s.sessionId === sessionId);
      if (hit) {
        title = hit.title;
        listStatus = hit.status;
        isLocalList = hit.local !== false;
        if (hit.pinned) isPinned = true;
        break;
      }
    }

    // ChatGPT Remote: single shell — absolute header + composer, scroll fills middle
    const shell = el('div', { class: 'rr-thread-shell' });

    const header = el('div', { class: 'rr-thread-header rr-thread-header--simple' });
    const back = svgBtn(iconBack(), 'rr-circ', 'Back');
    back.onclick = () => navigate('#/remote');
    header.appendChild(back);
    const titles = el('div', { class: 'rr-thread-titles' },
      el('div', { class: 'rr-t1', id: 'rr-t1' }, title),
      el('div', { class: 'rr-t2', id: 'rr-t2' }, this.hostLabel),
    );
    header.appendChild(titles);
    const actions = el('div', { class: 'rr-header-actions' });
    const neu = svgBtn(iconCompose(), 'rr-circ', 'New task');
    neu.onclick = () => navigate('#/remote/new');
    const moreBtn = svgBtn(iconMore(), 'rr-circ', 'More options');
    moreBtn.onclick = () => {
      this.openOverflowMenu([
        {
          label: 'Refresh conversation',
          action: () => { void softRefresh(); },
        },
        {
          label: isPinned ? 'Unpin from Working on' : 'Pin as Working on',
          action: () => { void this.togglePin(sessionId, !isPinned); },
        },
        { label: 'New task', action: () => navigate('#/remote/new') },
        {
          label: 'Copy session id',
          action: () => {
            void navigator.clipboard?.writeText(sessionId).then(
              () => this.toast('Session id copied'),
              () => this.toast(sessionId),
            );
          },
        },
        { label: 'Reload app', action: () => { location.reload(); } },
        {
          label: 'Advanced console',
          action: () => { location.hash = '#/advanced'; location.reload(); },
        },
      ]);
    };
    actions.appendChild(neu);
    actions.appendChild(moreBtn);
    header.appendChild(actions);

    const scroll = el('div', { class: 'rr-scroll rr-thread-scroll', id: 'rr-thread-body' });
    scroll.appendChild(el('div', { class: 'rr-muted' }, 'Opening…'));

    // Single-row ChatGPT composer (tools inline, not a tall two-tier stack)
    const input = document.createElement('textarea');
    input.rows = 1;
    input.placeholder = `Work on ${this.hostLabel}`;
    input.setAttribute('enterkeyhint', 'send');
    input.setAttribute('inputmode', 'text');
    input.autocomplete = 'off';
    input.autocapitalize = 'sentences';
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(Math.max(input.scrollHeight, 24), 96)}px`;
    });

    // No dead attach (+) until implemented — only send (honest chrome)
    const sendBtn = svgBtn(iconSend(), 'rr-circ rr-circ--send', 'Send');
    // ChatGPT-like single pill: input | send
    const work = el('div', { class: 'rr-work-wrap' },
      el('div', { class: 'rr-work-bar rr-work-bar--row' }, input, sendBtn),
    );

    const jump = el('button', {
      class: 'rr-jump-latest',
      type: 'button',
      'aria-label': 'Jump to latest',
      html: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    }) as HTMLButtonElement;
    jump.onclick = () => { scroll.scrollTop = scroll.scrollHeight; };
    scroll.addEventListener('scroll', () => {
      const nearBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 100;
      jump.classList.toggle('rr-jump-latest--show', !nearBottom);
    }, { passive: true });

    shell.appendChild(header);
    shell.appendChild(scroll);
    shell.appendChild(jump);
    shell.appendChild(work);
    this.root.appendChild(shell);

    let agentId = sessionId;

    const softRefresh = async (): Promise<void> => {
      if (!agentId) return;
      try {
        // Pull latest CLI/SSH turns from host disk into remote history first
        try {
          const r = await apiPost<{ hostMtimeMs?: number }>(
            `/api/remote/sessions/${encodeURIComponent(sessionId)}/reseed`,
            {},
          );
          if (typeof r.hostMtimeMs === 'number') this._hostHistMtimeMs = r.hostMtimeMs;
        } catch { /* cloud-only or no dir — ignore */ }
        const histRes = await fetch(`/api/agents/${encodeURIComponent(agentId)}/history?turns=200`, {
          headers: { accept: 'application/x-ndjson' },
        });
        if (!histRes.ok) throw new Error('history failed');
        const raw = await histRes.text();
        const turns = parseHistoryTurns(raw);
        this._lastHistFingerprint = this.turnsFingerprint(turns);
        this.paintTurns(scroll, turns, { skipQuote: true });
        if (!scroll.querySelector('.rr-ptr--bottom')) {
          this.attachPullToRefresh(scroll, softRefresh, 'up');
        }
        requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
        this.connectStream(agentId, scroll);
        this._acceptStream = false; // history is source of truth until next send
        this.startThreadSync(agentId, scroll);
        this.toast('Conversation refreshed');
      } catch (e) {
        this.toast(e instanceof Error ? e.message : 'Refresh failed');
      }
    };

    // Pull UP at bottom — soft refresh only (never re-mount shell)
    this.attachPullToRefresh(scroll, softRefresh, 'up');
    try {
      const open = await apiPost<{
        agent: {
          id: string;
          name?: string;
          status?: string;
          lastError?: string | null;
          connected?: boolean;
        };
        hasLocalContent?: boolean;
      }>(
        `/api/remote/sessions/${encodeURIComponent(sessionId)}/open`,
        { connect: true, name: title },
      );
      agentId = open.agent?.id || sessionId;

      // Prefer live agent name over UUID / list miss
      if (open.agent?.name && (title === sessionId.slice(0, 8) || !title)) {
        title = open.agent.name;
      }
      if (open.agent?.name && /^[0-9a-f]{8}$/i.test(title)) {
        title = open.agent.name;
      }
      const t1 = this.root.querySelector('#rr-t1');
      if (t1) t1.textContent = title;

      // Cloud only if list says non-local AND open says no disk AND agent is not live connected
      const isCloudArchive =
        isLocalList === false &&
        open.hasLocalContent === false &&
        !open.agent?.connected &&
        open.agent?.status === 'disconnected';

      const stuckLabel =
        open.agent?.lastError
          ? `Needs you · ${open.agent.lastError.slice(0, 120)}`
          : listStatus === 'stuck'
            ? 'Needs you · resume or send a nudge below'
            : null;

      const infoBanner = isCloudArchive
        ? 'Cloud archive on this account — no transcript files on this host. Start a related task below.'
        : null;

      // Always reseed from CLI disk first so PWA mirrors TUI transcript, then paint once
      try {
        const r = await apiPost<{ hostMtimeMs?: number }>(
          `/api/remote/sessions/${encodeURIComponent(sessionId)}/reseed`,
          {},
        );
        if (typeof r.hostMtimeMs === 'number') this._hostHistMtimeMs = r.hostMtimeMs;
      } catch { /* cloud-only */ }

      const histRes = await fetch(`/api/agents/${encodeURIComponent(agentId)}/history?turns=200`, {
        headers: { accept: 'application/x-ndjson' },
      });
      const turns = histRes.ok ? parseHistoryTurns(await histRes.text()) : [];
      this._lastHistFingerprint = this.turnsFingerprint(turns);
      this.paintTurns(scroll, turns, {
        stuckLabel,
        infoBanner,
        skipQuote: true,
      });
      // Jump to latest (ChatGPT-style open)
      requestAnimationFrame(() => {
        scroll.scrollTop = scroll.scrollHeight;
      });

      // Live token stream + background history sync for long-lived PWA tabs
      this.connectStream(agentId, scroll);
      this.startThreadSync(agentId, scroll);
      if (open.agent?.status === 'running' || open.agent?.status === 'starting') {
        this._acceptStream = true; // mid-flight open: show live tokens
        this._streamPriming = false;
        this.setStatus(scroll, 'Working on host…');
      } else {
        this._acceptStream = false; // history already painted; wait for user send
      }
      // Don't auto-focus on open (pops keyboard + wastes space). Focus on tap.
    } catch (e) {
      this.paintTurns(scroll, [], {});
      scroll.appendChild(el('div', { class: 'rr-error' }, e instanceof Error ? e.message : String(e)));
    }

    const doSend = async (): Promise<void> => {
      const text = input.value.trim();
      if (!text || !agentId || this._sending) return;
      this._sending = true;
      input.disabled = true;
      sendBtn.disabled = true;
      input.value = '';
      input.style.height = 'auto';
      // Reset live buffer so we only show NEW assistant text
      this._liveAsstEl = null;
      this._liveAsstText = '';
      this._turnGotAsst = false;
      this._acceptStream = true; // allow SSE tokens for this turn
      this._streamPriming = false;
      // Must insert before bottom pull-to-refresh node (same as live asst)
      this.insertBeforeBottomPtr(scroll, userBubble(text));
      this.setStatus(scroll, 'Working on host…');
      scroll.scrollTop = scroll.scrollHeight;
      try {
        // Ensure SSE is live before prompt so tokens stream into UI
        if (!this._es || this._es.readyState === EventSource.CLOSED) {
          this.connectStream(agentId, scroll);
          this._acceptStream = true;
          this._streamPriming = false;
        }
        await apiPost(`/api/agents/${encodeURIComponent(agentId)}/prompt`, { text });
        // Stream handles the reply; poll only if SSE never delivered.
        for (let i = 0; i < 40 && !this._turnGotAsst; i++) {
          await new Promise((r) => setTimeout(r, 1200));
          if (this._turnGotAsst) break;
          const histRes = await fetch(`/api/agents/${encodeURIComponent(agentId)}/history?turns=20`, {
            headers: { accept: 'application/x-ndjson' },
          });
          if (!histRes.ok) continue;
          const turns = parseHistoryTurns(await histRes.text());
          let foundUser = false;
          let reply: string | null = null;
          for (const t of turns) {
            if (t.role === 'user' && t.text.trim() === text.trim()) {
              foundUser = true;
              reply = null;
              continue;
            }
            if (foundUser && t.role === 'asst') reply = t.text;
          }
          if (reply && !this._turnGotAsst) {
            this.setStatus(scroll, null);
            this.appendLiveAsst(scroll, reply);
            break;
          }
        }
        if (!this._turnGotAsst) {
          this.setStatus(scroll, 'Still working — reply will appear when ready.');
        }
      } catch (err) {
        this.setStatus(scroll, null);
        scroll.appendChild(el('div', { class: 'rr-error' }, err instanceof Error ? err.message : String(err)));
      } finally {
        this._sending = false;
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
      }
    };

    sendBtn.onclick = () => void doSend();
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void doSend();
      }
    });
  }

  renderNewTask(): void {
    this.renderHome();
    const sheet = el('div', { class: 'rr-sheet', role: 'dialog', 'aria-label': 'New task' },
      el('div', { class: 'rr-grab' }),
      el('h2', {}, 'New task'),
    );
    const sel = el('select', { class: 'rr-select', id: 'rr-project', 'aria-label': 'Project' }) as HTMLSelectElement;
    for (const g of this.projects) {
      const o = document.createElement('option');
      // Prefer real absolute cwd; skip nested agent workdirs as "project"
      const cwd = g.cwd || '';
      if (cwd.includes('.grok-remote/agents')) continue;
      o.value = cwd;
      o.textContent = cleanLabel(g.projectLabel);
      sel.appendChild(o);
    }
    // Always offer home
    const home = document.createElement('option');
    home.value = '';
    home.textContent = 'home (/root)';
    sel.appendChild(home);
    if (!sel.options.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'home';
      sel.appendChild(o);
    }
    const ta = el('textarea', {
      class: 'rr-textarea',
      id: 'rr-task-text',
      placeholder: 'What should Grok do on the host?',
    }) as HTMLTextAreaElement;

    const cancel = el('button', { class: 'rr-btn', type: 'button' }, 'Cancel') as HTMLButtonElement;
    cancel.onclick = () => navigate('#/remote');
    const start = el('button', { class: 'rr-btn rr-btn--primary', type: 'button' }, 'Start on host') as HTMLButtonElement;
    start.onclick = () => void this.submitNewTask();

    sheet.appendChild(sel);
    sheet.appendChild(ta);
    sheet.appendChild(el('div', { class: 'rr-sheet-actions' }, cancel, start));

    const backdrop = el('div', { class: 'rr-backdrop' }, sheet);
    backdrop.onclick = (ev) => {
      if (ev.target === backdrop) navigate('#/remote');
    };
    this.root.appendChild(backdrop);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        window.removeEventListener('keydown', onKey);
        navigate('#/remote');
      }
    };
    window.addEventListener('keydown', onKey);
    requestAnimationFrame(() => ta.focus());
  }

  async submitNewTask(): Promise<void> {
    const sel = this.root.querySelector('#rr-project') as HTMLSelectElement | null;
    const ta = this.root.querySelector('#rr-task-text') as HTMLTextAreaElement | null;
    const text = ta?.value.trim() || '';
    const cwd = sel?.value || undefined;
    if (!text) {
      this.toast('Type a task first');
      ta?.focus();
      return;
    }
    const start = this.root.querySelector('.rr-btn--primary') as HTMLButtonElement | null;
    if (start) start.disabled = true;
    try {
      const r = await apiPost<{ agent: { id: string; name?: string } }>('/api/remote/tasks', {
        text,
        cwd: cwd || undefined,
        name: text.slice(0, 80),
      });
      navigate(`#/remote/s/${encodeURIComponent(r.agent.id)}`);
    } catch (e) {
      this.toast(e instanceof Error ? e.message : String(e));
      if (start) start.disabled = false;
    }
  }
}

export function mountRemoteShell(host: HTMLElement): RemoteApp {
  host.replaceChildren();
  host.classList.add('rr-host');
  const app = new RemoteApp();
  app.mount(host);
  return app;
}
