// Sessions page.

import { api } from '../../lib/api.js';

interface SessionItem {
  sessionId: string;
  created?: string;
  updated?: string;
  status?: string;
  summary?: string;
  cwd?: string;
}

interface SessionsState {
  q: string;
  limit: number;
  loading: boolean;
  error: string | null;
  raw: string;
  items: SessionItem[];
  agentIds: Set<string>;
  toast: string;
  toastTimer: number;
}

let activeContainer: HTMLElement | null = null;
let state: SessionsState = freshState();

function freshState(): SessionsState {
  return {
    q: '',
    limit: 50,
    loading: false,
    error: null,
    raw: '',
    items: [],
    agentIds: new Set(),
    toast: '',
    toastTimer: 0,
  };
}

export function mount(container: HTMLElement): void {
  activeContainer = container;
  state = freshState();
  render();
  void loadAgents();
  void load();
}

export function unmount(): void {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = 0;
  }
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

async function loadAgents(): Promise<void> {
  try {
    const list = await api.listAgents() as Array<{ id?: string; sessionId?: string }> | null;
    const ids = new Set<string>();
    if (Array.isArray(list)) {
      for (const a of list) {
        if (a && typeof a.sessionId === 'string' && a.sessionId) ids.add(a.sessionId);
        if (a && typeof a.id === 'string' && a.id) ids.add(a.id);
      }
    }
    state.agentIds = ids;
    if (activeContainer) render();
  } catch {
    /* non-fatal */
  }
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    const data = await api.sessions.list({ q: state.q, limit: state.limit }) as { raw?: string; items?: SessionItem[] };
    state.raw = (data && data.raw) || '';
    state.items = (data && Array.isArray(data.items)) ? data.items : [];
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.raw = '';
    state.items = [];
  } finally {
    state.loading = false;
    if (activeContainer) render();
  }
}

function showToast(msg: string): void {
  state.toast = msg;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    state.toast = '';
    state.toastTimer = 0;
    if (activeContainer) render();
  }, 1800) as unknown as number;
  render();
}

async function copyId(sid: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(sid);
    showToast(`copied ${sid.slice(0, 8)}...`);
  } catch {
    showToast('copy failed');
  }
}

function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncId(sid: string | null | undefined): string {
  if (!sid) return '';
  if (sid.length <= 18) return sid;
  return `${sid.slice(0, 8)}...${sid.slice(-4)}`;
}

function render(): void {
  if (!activeContainer) return;
  const rowsHtml = state.items.length
    ? state.items.map((it) => {
        const hasAgent = state.agentIds.has(it.sessionId);
        const btnHtml = hasAgent
          ? `<button class="sessions-use" data-sid="${escapeHtml(it.sessionId)}" data-cwd="${escapeHtml(it.cwd || '')}" data-name="${escapeHtml(it.summary || '')}" type="button">open chat</button>`
          : `<button class="sessions-use" data-sid="${escapeHtml(it.sessionId)}" data-cwd="${escapeHtml(it.cwd || '')}" data-name="${escapeHtml(it.summary || '')}" type="button">open in chats</button>`;
        return `
          <tr class="sessions-row" data-sid="${escapeHtml(it.sessionId)}">
            <td class="sessions-id"  title="${escapeHtml(it.sessionId)}"><code>${escapeHtml(truncId(it.sessionId))}</code></td>
            <td class="sessions-cre">${escapeHtml(it.updated || it.created)}</td>
            <td class="sessions-st">${escapeHtml(it.status)}</td>
            <td class="sessions-sum">${escapeHtml(it.summary)}</td>
            <td class="sessions-act">${btnHtml}</td>
          </tr>
        `;
      }).join('')
    : '';

  const empty = !state.loading && !state.error && state.items.length === 0;
  const hasRaw = !!(state.raw && state.raw.trim());

  activeContainer.innerHTML = `
    <section class="system-page sessions-page">
      <h2 class="system-page-title">Sessions</h2>
      <p class="system-page-sub">
        every Grok session on this host (CLI + disk). Use <strong>open in chats</strong>
        to put one in the sidebar, or <strong>sync all to chats</strong> to import them all.
      </p>

      <div class="sessions-controls">
        <input
          type="text"
          class="sessions-q"
          placeholder="search sessions..."
          value="${escapeHtml(state.q)}"
        />
        <input
          type="number"
          class="sessions-limit"
          min="1"
          max="200"
          step="1"
          value="${escapeHtml(String(state.limit))}"
          title="max rows to return"
        />
        <button class="sessions-refresh" type="button">${state.loading ? 'loading...' : 'refresh'}</button>
        <button class="sessions-sync" type="button">sync all to chats</button>
        ${state.toast ? `<span class="sessions-toast">${escapeHtml(state.toast)}</span>` : ''}
      </div>

      ${state.error ? `<div class="sessions-error">${escapeHtml(state.error)}</div>` : ''}

      <div class="sessions-table-wrap">
        <table class="sessions-table">
          <thead>
            <tr>
              <th>session id</th>
              <th>created</th>
              <th>status</th>
              <th>summary</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${empty ? `
          <div class="sessions-empty">
            no sessions matched. try a broader query, or check
            <code>grok sessions list</code> in a terminal.
          </div>
        ` : ''}
      </div>

      ${hasRaw ? `
        <details class="sessions-raw">
          <summary>raw output</summary>
          <pre>${escapeHtml(state.raw)}</pre>
        </details>
      ` : ''}
    </section>
  `;

  wire();
}

function wire(): void {
  if (!activeContainer) return;
  const qInput     = activeContainer.querySelector('.sessions-q') as HTMLInputElement | null;
  const limitInput = activeContainer.querySelector('.sessions-limit') as HTMLInputElement | null;
  const refreshBtn = activeContainer.querySelector('.sessions-refresh') as HTMLButtonElement | null;
  const syncBtn    = activeContainer.querySelector('.sessions-sync') as HTMLButtonElement | null;

  if (qInput) {
    qInput.addEventListener('input', (e: Event) => { state.q = (e.target as HTMLInputElement).value; });
    qInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void load();
      }
    });
  }
  if (limitInput) {
    limitInput.addEventListener('input', (e: Event) => {
      const n = parseInt((e.target as HTMLInputElement).value, 10);
      state.limit = Number.isFinite(n) && n > 0 ? n : 50;
    });
    limitInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void load();
      }
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => void load());
  }
  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      void (async () => {
        syncBtn.disabled = true;
        showToast('syncing…');
        try {
          const r = await api.syncSessions() as { imported?: number; total?: number; agents?: unknown[] };
          showToast(`synced ${r.imported ?? 0} new / ${r.total ?? 0} host sessions`);
          await loadAgents();
          void load();
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        } finally {
          syncBtn.disabled = false;
        }
      })();
    });
  }

  const rows = activeContainer.querySelectorAll('.sessions-row');
  rows.forEach((row) => {
    row.addEventListener('click', (e: Event) => {
      const target = e.target as Element | null;
      if (target && target.closest && target.closest('.sessions-use')) return;
      const sid = row.getAttribute('data-sid');
      if (sid) void copyId(sid);
    });
  });

  const useBtns = activeContainer.querySelectorAll('.sessions-use');
  useBtns.forEach((btn) => {
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const sid = btn.getAttribute('data-sid');
      if (!sid) return;
      const name = btn.getAttribute('data-name') || undefined;
      const cwd = btn.getAttribute('data-cwd') || undefined;
      void (async () => {
        try {
          showToast('opening…');
          const r = await api.importSession({
            sessionId: sid,
            name: name && name !== '(no summary)' ? name : undefined,
            cwd: cwd || undefined,
            connect: false,
          }) as { agent?: { id?: string } };
          const id = r?.agent?.id || sid;
          showToast('opened in chats');
          window.location.hash = `#/agents/${encodeURIComponent(id)}`;
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        }
      })();
    });
  });
}
