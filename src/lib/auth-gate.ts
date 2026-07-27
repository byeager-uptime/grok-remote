// First-run / recovery auth gate for the browser UI.
// When the API returns 401, we show a modal so the user can paste the token
// without rebuilding the URL (critical for iPad "Add to Home Screen" PWAs
// that drop query strings).

import { getAuthToken, setAuthToken, api } from './api.js';

let mounted = false;
let overlay: HTMLElement | null = null;

function ensureStyles(): void {
  if (document.getElementById('auth-gate-styles')) return;
  const s = document.createElement('style');
  s.id = 'auth-gate-styles';
  s.textContent = `
    .auth-gate {
      position: fixed; inset: 0; z-index: 99999;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,.72); backdrop-filter: blur(4px);
      padding: 16px; padding-bottom: max(16px, env(safe-area-inset-bottom));
    }
    .auth-gate[hidden] { display: none !important; }
    .auth-gate__card {
      width: min(420px, 100%);
      background: var(--bg-elevated, #151b24);
      color: var(--fg, #e7ecf3);
      border: 1px solid var(--border, #2a3444);
      border-radius: 14px;
      padding: 20px 18px 16px;
      box-shadow: 0 16px 48px rgba(0,0,0,.45);
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    }
    .auth-gate__title { font-size: 1.05rem; font-weight: 650; margin: 0 0 6px; }
    .auth-gate__help { font-size: .85rem; opacity: .75; margin: 0 0 14px; line-height: 1.4; }
    .auth-gate__input {
      width: 100%; box-sizing: border-box;
      font: inherit; font-size: 16px; /* avoid iOS zoom */
      padding: 12px 12px; border-radius: 10px;
      border: 1px solid var(--border, #2a3444);
      background: var(--bg, #0c1117); color: inherit;
      margin-bottom: 10px;
    }
    .auth-gate__err { color: #ff7b72; font-size: .82rem; min-height: 1.2em; margin: 0 0 10px; }
    .auth-gate__row { display: flex; gap: 8px; justify-content: flex-end; }
    .auth-gate__btn {
      font: inherit; font-size: .9rem; padding: 10px 14px; border-radius: 10px;
      border: 1px solid var(--border, #2a3444); background: transparent; color: inherit;
      cursor: pointer; min-height: 44px;
    }
    .auth-gate__btn--primary {
      background: var(--accent, #3d8bfd); border-color: transparent; color: #fff; font-weight: 600;
    }
    .auth-gate__btn:disabled { opacity: .5; cursor: wait; }
  `;
  document.head.appendChild(s);
}

function buildOverlay(): HTMLElement {
  ensureStyles();
  const root = document.createElement('div');
  root.className = 'auth-gate';
  root.id = 'auth-gate';
  root.hidden = true;
  root.innerHTML = `
    <div class="auth-gate__card" role="dialog" aria-modal="true" aria-labelledby="auth-gate-title">
      <h2 class="auth-gate__title" id="auth-gate-title">API token required</h2>
      <p class="auth-gate__help">
        This host requires <code>GROK_REMOTE_TOKEN</code>. Paste the token from the server
        (<code>~/.grok-remote/token</code>). It is stored only in this browser’s localStorage.
      </p>
      <input class="auth-gate__input" id="auth-gate-input" type="password" autocomplete="off"
        autocapitalize="off" spellcheck="false" placeholder="paste token" />
      <p class="auth-gate__err" id="auth-gate-err"></p>
      <div class="auth-gate__row">
        <button type="button" class="auth-gate__btn" id="auth-gate-clear">Clear</button>
        <button type="button" class="auth-gate__btn auth-gate__btn--primary" id="auth-gate-save">Save &amp; connect</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const input = root.querySelector('#auth-gate-input') as HTMLInputElement;
  const err = root.querySelector('#auth-gate-err') as HTMLElement;
  const save = root.querySelector('#auth-gate-save') as HTMLButtonElement;
  const clear = root.querySelector('#auth-gate-clear') as HTMLButtonElement;

  clear.addEventListener('click', () => {
    setAuthToken('');
    input.value = '';
    err.textContent = 'cleared — enter a new token';
  });

  const submit = async (): Promise<void> => {
    const token = input.value.trim();
    if (!token) {
      err.textContent = 'token is required';
      return;
    }
    setAuthToken(token);
    save.disabled = true;
    err.textContent = 'checking…';
    try {
      await api.listAgents();
      err.textContent = '';
      hide();
      window.location.reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      err.textContent = msg || 'still unauthorized — check the token';
      save.disabled = false;
    }
  };

  save.addEventListener('click', () => { void submit(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); void submit(); }
  });

  return root;
}

export function showAuthGate(detail?: { error?: string }): void {
  if (!overlay) overlay = buildOverlay();
  overlay.hidden = false;
  const input = overlay.querySelector('#auth-gate-input') as HTMLInputElement;
  const err = overlay.querySelector('#auth-gate-err') as HTMLElement;
  input.value = getAuthToken();
  err.textContent = detail?.error || '';
  setTimeout(() => input.focus(), 50);
}

export function hide(): void {
  if (overlay) overlay.hidden = true;
}

/** Probe the API once; show the gate if unauthorized. */
export async function ensureAuthOrGate(): Promise<boolean> {
  // Seed token from ?token= if present (getAuthToken already does this).
  getAuthToken();
  try {
    await api.listAgents();
    return true;
  } catch (e) {
    const status = (e as { status?: number })?.status;
    if (status === 401 || /unauthorized/i.test(String((e as Error)?.message || ''))) {
      showAuthGate({ error: (e as Error)?.message });
      return false;
    }
    // Other errors (network): let the UI surface them.
    return true;
  }
}

export function installAuthGate(): void {
  if (mounted) return;
  mounted = true;
  window.addEventListener('grok-remote:auth-required', ((ev: CustomEvent) => {
    showAuthGate(ev.detail || {});
  }) as EventListener);
  void ensureAuthOrGate();
}
