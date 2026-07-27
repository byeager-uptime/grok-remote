// Phone-first Remote shell — ChatGPT Remote visual language.
// Outline folder icons only. No emoji in project names or chrome.
// Only ship controls that do something. Live SSE for active threads.

import {
  iconMenu, iconBack, iconCompose, iconMic,
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
  // links
  s = s.replace(
    /(https?:\/\/[^\s<&]+)/g,
    '<a class="rr-link" href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  // paragraphs: double newlines
  s = s.split(/\n{2,}/).map((p) => {
    if (/^<(pre|div|ul)/.test(p.trim())) return p;
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
  // Dedupe consecutive identical turns (bad double-seed)
  const out: typeof turns = [];
  for (const t of turns) {
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role && prev.text === t.text) continue;
    // Also skip asst that is exact prefix-duplicate of previous (concat bug)
    if (prev && prev.role === 'asst' && t.role === 'asst' && t.text.startsWith(prev.text.slice(0, 80)) && prev.text.length > 200) {
      out[out.length - 1] = t.length > prev.text.length ? t : prev;
      continue;
    }
    out.push(t);
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
  private _es: EventSource | null = null;
  private _threadAgentId: string | null = null;
  private _liveAsstEl: HTMLElement | null = null;
  private _liveAsstText = '';
  private _statusEl: HTMLElement | null = null;
  /** True once this user turn already received assistant text (SSE or poll). */
  private _turnGotAsst = false;

  constructor() {
    this.root = el('div', { class: 'rr-app' });
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
    window.addEventListener('hashchange', () => void this.render());
    void this.bootstrap();
  }

  private closeStream(): void {
    if (this._es) {
      try { this._es.close(); } catch { /* ignore */ }
      this._es = null;
    }
    this._liveAsstEl = null;
    this._liveAsstText = '';
    this._statusEl = null;
    this._threadAgentId = null;
    this._turnGotAsst = false;
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
      await this.renderThread(route.sessionId);
      return;
    }
    if (route.name === 'new') {
      this.renderNewTask();
      return;
    }
    this.renderHome();
  }

  private toast(msg: string): void {
    const t = el('div', { class: 'rr-toast' }, msg);
    this.root.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  renderHome(): void {
    const header = el('div', { class: 'rr-header rr-header--simple' });
    // Only controls that do work: refresh list (was dead Menu).
    const refresh = svgBtn(iconMenu(), 'rr-circ', 'Refresh sessions');
    refresh.onclick = () => {
      void this.loadSessions().then(() => this.render());
    };
    header.appendChild(refresh);
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
    // spacer to balance grid
    header.appendChild(el('div', { class: 'rr-circ-spacer' }));

    const scroll = el('div', { class: 'rr-scroll' });
    scroll.appendChild(el('h1', { class: 'rr-h1' }, 'Projects'));

    if (this.stuckCount > 0) {
      scroll.appendChild(el('div', { class: 'rr-banner' },
        `${this.stuckCount} need${this.stuckCount === 1 ? 's' : ''} you`,
      ));
    }

    if (this.loading) {
      scroll.appendChild(el('div', { class: 'rr-muted' }, 'Loading…'));
    } else if (this.error) {
      scroll.appendChild(el('div', { class: 'rr-error' }, this.error));
      const retry = el('button', { class: 'rr-btn', type: 'button' }, 'Retry') as HTMLButtonElement;
      retry.onclick = () => void this.bootstrap();
      scroll.appendChild(retry);
    } else if (!this.projects.length) {
      scroll.appendChild(el('div', { class: 'rr-muted' },
        'No main sessions yet. Start work on the host or use New.',
      ));
    } else {
      for (const g of this.projects) {
        const collapsed = this.collapsed.has(g.projectId);
        const row = el('div', { class: 'rr-proj-row' });
        const head = el('button', { class: 'rr-proj-head', type: 'button' }) as HTMLButtonElement;
        head.innerHTML = iconFolder();
        head.appendChild(el('span', { class: 'rr-proj-name' }, cleanLabel(g.projectLabel)));
        head.appendChild(el('span', { class: 'rr-proj-chev' }, collapsed ? '▸' : '▾'));
        head.onclick = () => {
          if (this.collapsed.has(g.projectId)) this.collapsed.delete(g.projectId);
          else this.collapsed.add(g.projectId);
          void this.render();
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
    }

    const bottom = el('div', { class: 'rr-bottom' });
    const chats = el('button', { class: 'rr-chats-pill', type: 'button' }) as HTMLButtonElement;
    chats.textContent = 'Refresh';
    chats.onclick = () => void this.loadSessions().then(() => this.render());
    const actions = el('div', { class: 'rr-bottom-actions' });
    const mic = svgBtn(iconMic(), 'rr-circ', 'Voice (coming soon)');
    mic.disabled = true;
    const neu = svgBtn(iconCompose(), 'rr-circ rr-circ--white', 'New task');
    neu.onclick = () => navigate('#/remote/new');
    actions.appendChild(mic);
    actions.appendChild(neu);
    bottom.appendChild(chats);
    bottom.appendChild(actions);

    const foot = el('div', { class: 'rr-foot' });
    const adv = el('a', { href: '#/advanced' }, 'Advanced console') as HTMLAnchorElement;
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
    scroll.replaceChildren();
    if (opts?.stuckLabel) {
      scroll.appendChild(el('div', { class: 'rr-soft-stuck' }, opts.stuckLabel));
    }
    if (opts?.infoBanner) {
      scroll.appendChild(el('div', { class: 'rr-info-banner' }, opts.infoBanner));
    }
    // Quote only when we have a prior user turn and later content (ChatGPT-ish)
    if (!opts?.skipQuote) {
      const firstUser = turns.find((t) => t.role === 'user');
      if (firstUser && turns.length > 1) {
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
      return;
    }
    for (const t of turns) {
      scroll.appendChild(t.role === 'user' ? userBubble(t.text) : asstBubble(t.text));
    }
  }

  private appendLiveAsst(scroll: HTMLElement, chunk: string): void {
    this._liveAsstText += chunk;
    this._turnGotAsst = true;
    if (!this._liveAsstEl) {
      this._liveAsstEl = asstBubble(this._liveAsstText);
      scroll.appendChild(this._liveAsstEl);
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
    scroll.appendChild(this._statusEl);
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

    const header = el('div', { class: 'rr-thread-header rr-thread-header--simple' });
    const back = svgBtn(iconBack(), 'rr-circ', 'Back');
    back.onclick = () => navigate('#/remote');
    header.appendChild(back);
    const titles = el('div', { class: 'rr-thread-titles' },
      el('div', { class: 'rr-t1', id: 'rr-t1' }, title),
      el('div', { class: 'rr-t2' }, this.hostLabel),
    );
    header.appendChild(titles);
    const neu = svgBtn(iconCompose(), 'rr-circ', 'New task');
    neu.onclick = () => navigate('#/remote/new');
    header.appendChild(neu);

    const scroll = el('div', { class: 'rr-scroll', id: 'rr-thread-body' });
    scroll.appendChild(el('div', { class: 'rr-muted' }, 'Opening…'));

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Message Grok';
    input.enterKeyHint = 'send';
    input.autocomplete = 'off';

    const plus = svgBtn(iconPlus(), 'rr-circ', 'Attach');
    plus.disabled = true;
    const mic = svgBtn(iconMic(), 'rr-circ', 'Voice (coming soon)');
    mic.disabled = true;

    const work = el('div', { class: 'rr-work-wrap' },
      el('div', { class: 'rr-work-bar' }, plus, input, mic),
    );

    this.root.appendChild(header);
    this.root.appendChild(scroll);
    this.root.appendChild(work);

    let agentId = sessionId;
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
      scroll.scrollTop = scroll.scrollHeight;

      // Live stream for replies / new tasks already running
      this.connectStream(agentId, scroll);
      if (open.agent?.status === 'running' || open.agent?.status === 'starting') {
        this.setStatus(scroll, 'Working on host…');
      }
    } catch (e) {
      scroll.replaceChildren();
      scroll.appendChild(el('div', { class: 'rr-error' }, e instanceof Error ? e.message : String(e)));
    }

    const doSend = async (): Promise<void> => {
      const text = input.value.trim();
      if (!text || !agentId) return;
      input.disabled = true;
      input.value = '';
      // Reset live buffer so we only show NEW assistant text
      this._liveAsstEl = null;
      this._liveAsstText = '';
      this._turnGotAsst = false;
      scroll.appendChild(userBubble(text));
      this.setStatus(scroll, 'Working on host…');
      scroll.scrollTop = scroll.scrollHeight;
      try {
        await apiPost(`/api/agents/${encodeURIComponent(agentId)}/prompt`, { text });
        // Stream handles the reply; poll only if SSE never delivered.
        for (let i = 0; i < 30 && !this._turnGotAsst; i++) {
          await new Promise((r) => setTimeout(r, 1500));
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
        input.disabled = false;
        input.focus();
      }
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void doSend();
      }
    });
  }

  renderNewTask(): void {
    this.renderHome();
    const sheet = el('div', { class: 'rr-sheet' },
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
  }

  async submitNewTask(): Promise<void> {
    const sel = this.root.querySelector('#rr-project') as HTMLSelectElement | null;
    const ta = this.root.querySelector('#rr-task-text') as HTMLTextAreaElement | null;
    const text = ta?.value.trim() || '';
    const cwd = sel?.value || undefined;
    if (!text) return;
    try {
      const r = await apiPost<{ agent: { id: string; name?: string } }>('/api/remote/tasks', {
        text,
        cwd: cwd || undefined,
        name: text.slice(0, 80),
      });
      navigate(`#/remote/s/${encodeURIComponent(r.agent.id)}`);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
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
