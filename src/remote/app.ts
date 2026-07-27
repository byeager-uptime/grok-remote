// Phone-first Remote shell — ChatGPT Remote visual language.
// Outline folder icons only. No emoji in project names or chrome.

import {
  iconMenu, iconSearch, iconMore, iconBack, iconCompose, iconMic,
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

/** Strip emoji / symbols from project labels — always plain text. */
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

function linkify(text: string): string {
  const esc = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc.replace(
    /(https?:\/\/[^\s<&]+)/g,
    '<a class="rr-link" href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
}

export class RemoteApp {
  root: HTMLElement;
  hostLabel = 'hermes-agent';
  projects: ProjectGroup[] = [];
  stuckCount = 0;
  loading = false;
  error: string | null = null;
  collapsed = new Set<string>();

  constructor() {
    this.root = el('div', { class: 'rr-app' });
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
    window.addEventListener('hashchange', () => void this.render());
    void this.bootstrap();
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

  renderHome(): void {
    const header = el('div', { class: 'rr-header' });
    header.appendChild(svgBtn(iconMenu(), 'rr-circ', 'Menu'));
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
    header.appendChild(svgBtn(iconMore(), 'rr-circ', 'More'));
    header.appendChild(svgBtn(iconSearch(), 'rr-circ', 'Search'));

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
        const head = el('button', { class: 'rr-proj-head', type: 'button' }) as HTMLButtonElement;
        head.innerHTML = iconFolder();
        head.appendChild(el('span', { class: 'rr-proj-name' }, cleanLabel(g.projectLabel)));
        head.appendChild(el('span', { class: 'rr-proj-chev' }, collapsed ? '▸' : '▾'));
        const ext = document.createElement('button');
        ext.type = 'button';
        ext.className = 'rr-proj-ext';
        ext.title = 'Open project path info';
        ext.innerHTML = iconExternal();
        ext.onclick = (ev) => {
          ev.stopPropagation();
          // On-device: show path (phone can't open host FS)
          alert(g.cwd || g.projectLabel);
        };
        head.appendChild(ext);
        head.onclick = () => {
          if (this.collapsed.has(g.projectId)) this.collapsed.delete(g.projectId);
          else this.collapsed.add(g.projectId);
          void this.render();
        };
        scroll.appendChild(head);

        if (collapsed) continue;
        for (const s of g.sessions) {
          const row = el('button', { class: 'rr-thread', type: 'button' }) as HTMLButtonElement;
          row.onclick = () => navigate(`#/remote/s/${encodeURIComponent(s.sessionId)}`);
          row.appendChild(el('span', { class: `rr-st rr-st--${s.status}` }));
          row.appendChild(el('span', { class: 'rr-thread-t' }, s.title));
          scroll.appendChild(row);
        }
      }
    }

    const bottom = el('div', { class: 'rr-bottom' });
    const chats = el('button', { class: 'rr-chats-pill', type: 'button' }) as HTMLButtonElement;
    chats.appendChild(document.createTextNode('Chats '));
    chats.appendChild(el('span', { class: 'rr-down' }, '▾'));
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
    // Full reload so main.ts can mount the legacy console (hashchange alone won't).
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

  async renderThread(sessionId: string): Promise<void> {
    let title = sessionId.slice(0, 8);
    let listStatus: RemoteSession['status'] | null = null;
    let isLocal = true;
    for (const g of this.projects) {
      const hit = g.sessions.find((s) => s.sessionId === sessionId);
      if (hit) {
        title = hit.title;
        listStatus = hit.status;
        isLocal = hit.local !== false;
        break;
      }
    }

    const header = el('div', { class: 'rr-thread-header' });
    const menu = svgBtn(iconMenu(), 'rr-circ', 'Menu');
    menu.onclick = () => navigate('#/remote');
    const back = svgBtn(iconBack(), 'rr-circ', 'Back');
    back.onclick = () => navigate('#/remote');
    header.appendChild(menu);
    header.appendChild(back);
    header.appendChild(
      el('div', { class: 'rr-thread-titles' },
        el('div', { class: 'rr-t1', id: 'rr-t1' }, title),
        el('div', { class: 'rr-t2' }, this.hostLabel),
      ),
    );
    header.appendChild(svgBtn(iconCompose(), 'rr-circ', 'Compose'));
    header.appendChild(svgBtn(iconMore(), 'rr-circ', 'More'));

    const scroll = el('div', { class: 'rr-scroll', id: 'rr-thread-body' });
    scroll.appendChild(el('div', { class: 'rr-muted' }, 'Opening…'));

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = `Work on ${this.hostLabel}`;
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
        agent: { id: string; status?: string; lastError?: string | null; connected?: boolean };
        hasLocalContent?: boolean;
      }>(
        `/api/remote/sessions/${encodeURIComponent(sessionId)}/open`,
        { connect: true, name: title },
      );
      agentId = open.agent?.id || sessionId;
      const hasLocal = open.hasLocalContent !== false && isLocal;

      scroll.replaceChildren();

      // Status banner — only "Needs you" when list says stuck or real error.
      if (open.agent?.lastError) {
        scroll.appendChild(el('div', { class: 'rr-soft-stuck' },
          `Needs you · ${open.agent.lastError.slice(0, 120)}`,
        ));
      } else if (listStatus === 'stuck') {
        scroll.appendChild(el('div', { class: 'rr-soft-stuck' },
          'Needs you · resume or send a nudge below',
        ));
      } else if (!hasLocal) {
        scroll.appendChild(el('div', { class: 'rr-info-banner' },
          'Cloud archive on this account — no transcript files on this host. Start a related task below.',
        ));
      }

      const histRes = await fetch(`/api/agents/${encodeURIComponent(agentId)}/history?turns=60`, {
        headers: { accept: 'application/x-ndjson' },
      });

      let firstUser: string | null = null;
      const chunks: HTMLElement[] = [];
      let asstBuf = '';
      const flushAsst = (): void => {
        if (!asstBuf.trim()) return;
        const box = el('div', { class: 'rr-msg-asst' });
        box.appendChild(el('div', { class: 'rr-who' }, 'GROK'));
        const body = el('div', { class: 'rr-body' }) as HTMLElement;
        body.innerHTML = linkify(asstBuf.slice(0, 12000));
        box.appendChild(body);
        chunks.push(box);
        asstBuf = '';
      };

      if (histRes.ok) {
        const text = await histRes.text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          let ev: {
            event?: string;
            data?: { text?: string; update?: { content?: { text?: string } } };
          };
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.event === 'user_message' && ev.data?.text) {
            flushAsst();
            const t = String(ev.data.text).trim();
            if (!firstUser) firstUser = t;
            chunks.push(el('div', { class: 'rr-msg-user' }, t.slice(0, 4000)));
          } else if (ev.event === 'agent_message_chunk') {
            const t = ev.data?.update?.content?.text;
            if (t) asstBuf += String(t);
          }
        }
        flushAsst();
      }

      if (firstUser) {
        scroll.appendChild(el('div', { class: 'rr-quote' },
          `"${firstUser.slice(0, 280)}${firstUser.length > 280 ? '…' : ''}"`,
        ));
      }
      if (!chunks.length) {
        scroll.appendChild(el('div', { class: 'rr-muted' },
          hasLocal
            ? 'No prior turns on disk yet. Send a short nudge below to resume on the host.'
            : 'No local transcript. Type a follow-up to start fresh work on this host.',
        ));
      } else {
        for (const c of chunks) scroll.appendChild(c);
      }
      // Ensure content is visible after paint
      requestAnimationFrame(() => {
        scroll.scrollTop = Math.min(scroll.scrollHeight, 200);
      });
    } catch (e) {
      scroll.replaceChildren();
      scroll.appendChild(el('div', { class: 'rr-error' }, e instanceof Error ? e.message : String(e)));
    }

    const doSend = async (): Promise<void> => {
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      input.value = '';
      scroll.appendChild(el('div', { class: 'rr-msg-user' }, text));
      const thinking = el('div', { class: 'rr-muted' }, 'Working on host…');
      scroll.appendChild(thinking);
      scroll.scrollTop = scroll.scrollHeight;
      try {
        await apiPost(`/api/agents/${encodeURIComponent(agentId)}/prompt`, { text });
        // Poll history briefly for the reply
        let found = false;
        for (let attempt = 0; attempt < 12 && !found; attempt++) {
          await new Promise((r) => setTimeout(r, 1500));
          const histRes = await fetch(`/api/agents/${encodeURIComponent(agentId)}/history?turns=12`, {
            headers: { accept: 'application/x-ndjson' },
          });
          if (!histRes.ok) continue;
          const lines = (await histRes.text()).trim().split('\n').filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const ev = JSON.parse(lines[i]!);
              const t = ev?.data?.update?.content?.text;
              if (ev.event === 'agent_message_chunk' && t && String(t).length > 2) {
                thinking.remove();
                const box = el('div', { class: 'rr-msg-asst' });
                box.appendChild(el('div', { class: 'rr-who' }, 'GROK'));
                const body = el('div', { class: 'rr-body' }) as HTMLElement;
                body.innerHTML = linkify(String(t).slice(0, 8000));
                box.appendChild(body);
                scroll.appendChild(box);
                found = true;
                break;
              }
            } catch { /* continue */ }
          }
        }
        if (!found) {
          thinking.textContent = 'Sent. Waiting for host reply — pull to refresh or reopen.';
        }
        scroll.scrollTop = scroll.scrollHeight;
      } catch (err) {
        thinking.remove();
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
    // Dimmed home under sheet
    this.renderHome();
    const sheet = el('div', { class: 'rr-sheet' },
      el('div', { class: 'rr-grab' }),
      el('h2', {}, 'New task'),
    );
    const sel = el('select', { class: 'rr-select', id: 'rr-project' }) as HTMLSelectElement;
    for (const g of this.projects) {
      const o = document.createElement('option');
      o.value = g.cwd || '';
      o.textContent = cleanLabel(g.projectLabel);
      sel.appendChild(o);
    }
    if (!this.projects.length) {
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
      const r = await apiPost<{ agent: { id: string } }>('/api/remote/tasks', { text, cwd });
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
