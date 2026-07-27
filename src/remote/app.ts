// Phone-first Remote shell — ChatGPT Remote visual language.
// Outline folder icons only. No emoji in project names or chrome.
// Only ship controls that do something. Live SSE for active threads.

import {
  iconBack, iconCompose, iconMic, iconSearch, iconSend, iconMore,
  iconPlus, iconFolder, iconExternal, iconComputer, svgBtn,
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
  source: string;
  local: boolean;
  model?: string;
  agentId?: string | null;
  connected?: boolean;
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
  projects?: ProjectGroup[];
  error?: string;
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

/** Escape + light markdown → HTML (headings, bold, code, lists, links, paragraphs). */
function formatMessage(text: string): string {
  let s = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // fenced code
  s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code: string) =>
    `<pre class="rr-code">${code.replace(/^\n|\n$/g, '')}</pre>`);
  // inline code
  s = s.replace(/`([^`\n]+)`/g, '<code class="rr-icode">$1</code>');
  // bold / italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // headings
  s = s.replace(/^######\s+(.+)$/gm, '<div class="rr-h6">$1</div>');
  s = s.replace(/^#####\s+(.+)$/gm, '<div class="rr-h6">$1</div>');
  s = s.replace(/^####\s+(.+)$/gm, '<div class="rr-h5">$1</div>');
  s = s.replace(/^###\s+(.+)$/gm, '<div class="rr-h5">$1</div>');
  s = s.replace(/^##\s+(.+)$/gm, '<div class="rr-h4">$1</div>');
  s = s.replace(/^#\s+(.+)$/gm, '<div class="rr-h4">$1</div>');
  // unordered list items
  s = s.replace(/^[-*]\s+(.+)$/gm, '<div class="rr-li">• $1</div>');
  // simple markdown tables (header + separator + rows)
  s = s.replace(/(?:^|\n)((?:\|.+\|\n)+)/g, (_m, block: string) => {
    const lines = block.trim().split('\n').filter(Boolean);
    if (lines.length < 2) return block;
    if (!/^\|?\s*[-:| ]+\s*\|?$/.test(lines[1] || '')) return block;
    const parseRow = (line: string): string[] =>
      line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const head = parseRow(lines[0]!);
    const body = lines.slice(2).map(parseRow);
    let html = '<div class="rr-table-wrap"><table class="rr-table"><thead><tr>';
    for (const h of head) html += `<th>${h}</th>`;
    html += '</tr></thead><tbody>';
    for (const row of body) {
      html += '<tr>';
      for (const c of row) html += `<td>${c}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return `\n${html}\n`;
  });
  // links
  s = s.replace(
    /(https?:\/\/[^\s<&]+)/g,
    '<a class="rr-link" href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  // paragraphs: double newlines
  s = s.split(/\n{2,}/).map((p) => {
    if (/^<(pre|div|ul|table)/.test(p.trim()) || p.includes('rr-table')) return p;
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join('');
  return s;
}

function userBubble(text: string): HTMLElement {
  return el('div', { class: 'rr-msg-user' }, text.slice(0, 4000));
}

function asstBubble(text: string): HTMLElement {
  const box = el('div', { class: 'rr-msg-asst' });
  box.appendChild(el('div', { class: 'rr-who' }, 'GROK'));
  const body = el('div', { class: 'rr-body' }) as HTMLElement;
  body.innerHTML = formatMessage(text.slice(0, 16000));
  box.appendChild(body);
  return box;
}

/** Parse NDJSON history into ordered turn list (merge consecutive assistant chunks). */
function parseHistoryTurns(raw: string): Array<{ role: 'user' | 'asst'; text: string }> {
  const turns: Array<{ role: 'user' | 'asst'; text: string }> = [];
  let asst = '';
  const flush = (): void => {
    const t = asst.trim();
    if (t) turns.push({ role: 'asst', text: t });
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
  // Dedupe seed garbage: repeated short assistant lines, "pong"*"n", etc.
  const normalizeAsst = (s: string): string => {
    const t = s.trim();
    // Collapse pure-repeat tokens: pongpongpong → pong
    const m = t.match(/^(.{1,24}?)\1+$/);
    if (m) return m[1]!;
    return t;
  };
  const out: typeof turns = [];
  for (const t of turns) {
    const cur = t.role === 'asst' ? { ...t, text: normalizeAsst(t.text) } : t;
    const prev = out[out.length - 1];
    if (prev && prev.role === cur.role && prev.text === cur.text) continue;
    if (prev && prev.role === 'asst' && cur.role === 'asst') {
      const a = prev.text;
      const b = cur.text;
      if (a === b) continue;
      if (b.startsWith(a) || a.startsWith(b)) {
        // Keep the longer non-repeating form
        if (b.length >= a.length) out[out.length - 1] = cur;
        continue;
      }
    }
    if (prev && prev.role === 'user' && cur.role === 'user' && prev.text === cur.text) continue;
    out.push(cur);
  }
  return out;
}

export class RemoteApp {
  root: HTMLElement;
  hostLabel = 'hermes-agent';
  projects: ProjectGroup[] = [];
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
  private _threadScroll: HTMLElement | null = null;

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

  /** While a thread is open: poll history + refresh on tab focus so long-lived PWAs stay current. */
  private startThreadSync(agentId: string, scroll: HTMLElement): void {
    this.stopHistPoll();
    this._threadScroll = scroll;

    const sync = async (reason: string): Promise<void> => {
      if (parseRoute().name !== 'thread') return;
      if (this._sending || this._liveAsstText) return; // don't clobber live stream mid-token
      try {
        const histRes = await fetch(`/api/agents/${encodeURIComponent(agentId)}/history?turns=80`, {
          headers: { accept: 'application/x-ndjson' },
        });
        if (!histRes.ok) return;
        const raw = await histRes.text();
        // Cheap fingerprint: length + last 200 chars
        const fp = `${raw.length}:${raw.slice(-200)}`;
        if (fp === this._lastHistFingerprint) return;
        this._lastHistFingerprint = fp;
        const turns = parseHistoryTurns(raw);
        const nearBottom =
          scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 80;
        this.paintTurns(scroll, turns, { skipQuote: turns.length <= 1 });
        if (nearBottom) {
          requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
        }
        if (reason === 'visibility') this.toast('Conversation updated');
      } catch { /* ignore */ }
    };

    this._histPoll = setInterval(() => { void sync('poll'); }, 12_000);

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
      this.stuckCount = data.stuckCount || 0;
      this.error = null;
    } catch { /* keep last good list */ }
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
      this.stuckCount = data.stuckCount || 0;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.projects = [];
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

    // Split local vs cloud archive for phone triage
    type G = ProjectGroup;
    const localGroups: G[] = [];
    const cloudGroups: G[] = [];
    for (const g of this.projects) {
      const localS = g.sessions.filter((s) => s.local !== false && filterSession(s));
      const cloudS = g.sessions.filter((s) => s.local === false && filterSession(s));
      if (localS.length) localGroups.push({ ...g, sessions: localS });
      if (cloudS.length) cloudGroups.push({ ...g, sessions: cloudS });
    }

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
        for (const s of g.sessions) {
          const thr = el('button', { class: 'rr-thread', type: 'button' }) as HTMLButtonElement;
          thr.onclick = () => navigate(`#/remote/s/${encodeURIComponent(s.sessionId)}`);
          thr.appendChild(el('span', { class: `rr-st rr-st--${s.status}` }));
          thr.appendChild(el('span', { class: 'rr-thread-t' }, s.title));
          scroll.appendChild(thr);
        }
      }
    };

    if (this.loading && !this.projects.length) {
      scroll.appendChild(el('div', { class: 'rr-muted' }, 'Loading…'));
    } else if (this.error && !this.projects.length) {
      scroll.appendChild(el('div', { class: 'rr-error' }, this.error));
      const retry = el('button', { class: 'rr-btn', type: 'button' }, 'Retry') as HTMLButtonElement;
      retry.onclick = () => void this.bootstrap();
      scroll.appendChild(retry);
    } else if (!localGroups.length && !cloudGroups.length) {
      scroll.appendChild(el('div', { class: 'rr-muted' },
        q ? 'No sessions match your search.' : 'No main sessions yet. Start work on the host or use New.',
      ));
    } else {
      // Cloud toggle sits ABOVE local projects so it is never trapped under the
      // sticky bottom bar (dogfood: clicks on bottom toggle were intercepted).
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
      if (localGroups.length && cloudGroups.length) {
        scroll.appendChild(el('div', { class: 'rr-section-label' }, 'On this host'));
      }
      renderGroups(localGroups, 'local');
    }

    const bottom = el('div', { class: 'rr-bottom' });
    const hostPill = el('button', { class: 'rr-chats-pill', type: 'button' }) as HTMLButtonElement;
    hostPill.textContent = this.hostLabel;
    hostPill.title = 'Refresh session list';
    hostPill.onclick = () => void this.loadSessions().then(() => this.render());
    const actions = el('div', { class: 'rr-bottom-actions' });
    const mic = svgBtn(iconMic(), 'rr-circ', 'Voice (coming soon)');
    mic.disabled = true;
    const neu = svgBtn(iconCompose(), 'rr-circ rr-circ--white', 'New task');
    neu.onclick = () => navigate('#/remote/new');
    actions.appendChild(mic);
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
    // Skip quote when it only duplicates the first user bubble (short chats)
    if (!opts?.skipQuote) {
      const firstUser = turns.find((t) => t.role === 'user');
      const asstCount = turns.filter((t) => t.role === 'asst').length;
      if (firstUser && asstCount >= 1 && firstUser.text.length > 120) {
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
      for (const t of turns) {
        scroll.appendChild(t.role === 'user' ? userBubble(t.text) : asstBubble(t.text));
      }
    }
    for (const p of bottomPtrs) scroll.appendChild(p);
  }

  private insertBeforeBottomPtr(scroll: HTMLElement, node: HTMLElement): void {
    const bottom = scroll.querySelector('.rr-ptr--bottom');
    if (bottom) scroll.insertBefore(node, bottom);
    else scroll.appendChild(node);
  }

  private appendLiveAsst(scroll: HTMLElement, chunk: string): void {
    this._liveAsstText += chunk;
    this._turnGotAsst = true;
    if (!this._liveAsstEl) {
      this._liveAsstEl = asstBubble(this._liveAsstText);
      this.insertBeforeBottomPtr(scroll, this._liveAsstEl);
    } else {
      const body = this._liveAsstEl.querySelector('.rr-body') as HTMLElement | null;
      if (body) body.innerHTML = formatMessage(this._liveAsstText.slice(0, 16000));
    }
    scroll.scrollTop = scroll.scrollHeight;
  }

  private setStatus(scroll: HTMLElement, text: string | null): void {
    if (this._statusEl) {
      this._statusEl.remove();
      this._statusEl = null;
    }
    if (!text) return;
    this._statusEl = el('div', { class: 'rr-muted rr-live-status' }, text);
    this.insertBeforeBottomPtr(scroll, this._statusEl);
    scroll.scrollTop = scroll.scrollHeight;
  }

  private connectStream(agentId: string, scroll: HTMLElement): void {
    this.closeStream();
    this._threadAgentId = agentId;
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

    let title = sessionId.slice(0, 8);
    let listStatus: RemoteSession['status'] | null = null;
    let isLocalList = true;
    for (const g of this.projects) {
      const hit = g.sessions.find((s) => s.sessionId === sessionId);
      if (hit) {
        title = hit.title;
        listStatus = hit.status;
        isLocalList = hit.local !== false;
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

    const plus = svgBtn(iconPlus(), 'rr-circ', 'Attach');
    plus.disabled = true;
    const sendBtn = svgBtn(iconSend(), 'rr-circ rr-circ--send', 'Send');
    // ChatGPT-like: one pill, input grows, + left / send right on same row when short
    const work = el('div', { class: 'rr-work-wrap' },
      el('div', { class: 'rr-work-bar rr-work-bar--row' }, plus, input, sendBtn),
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
        const histRes = await fetch(`/api/agents/${encodeURIComponent(agentId)}/history?turns=80`, {
          headers: { accept: 'application/x-ndjson' },
        });
        if (!histRes.ok) throw new Error('history failed');
        const raw = await histRes.text();
        this._lastHistFingerprint = `${raw.length}:${raw.slice(-200)}`;
        const turns = parseHistoryTurns(raw);
        this.paintTurns(scroll, turns, { skipQuote: turns.length <= 1 });
        // Ensure bottom pull affordance remains
        if (!scroll.querySelector('.rr-ptr--bottom')) {
          this.attachPullToRefresh(scroll, softRefresh, 'up');
        }
        requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
        // Re-bind stream after refresh
        this.connectStream(agentId, scroll);
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

      const histRes = await fetch(`/api/agents/${encodeURIComponent(agentId)}/history?turns=80`, {
        headers: { accept: 'application/x-ndjson' },
      });
      const turns = histRes.ok ? parseHistoryTurns(await histRes.text()) : [];
      this.paintTurns(scroll, turns, {
        stuckLabel,
        infoBanner,
        skipQuote: turns.length <= 1,
      });
      // Jump to latest (ChatGPT-style open)
      requestAnimationFrame(() => {
        scroll.scrollTop = scroll.scrollHeight;
      });

      // Live token stream + background history sync for long-lived PWA tabs
      this.connectStream(agentId, scroll);
      this.startThreadSync(agentId, scroll);
      if (open.agent?.status === 'running' || open.agent?.status === 'starting') {
        this.setStatus(scroll, 'Working on host…');
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
      scroll.appendChild(userBubble(text));
      this.setStatus(scroll, 'Working on host…');
      scroll.scrollTop = scroll.scrollHeight;
      try {
        // Ensure SSE is live before prompt so tokens stream into UI
        if (!this._es || this._es.readyState === EventSource.CLOSED) {
          this.connectStream(agentId, scroll);
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
