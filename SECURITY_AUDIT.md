# Security Audit — byeager-uptime/grok-remote (fork of daniel-farina/grok-remote)

**Audit date:** 2026-07-26  
**Auditor:** automated deep review + targeted hardening in this fork  
**Upstream tip at fork:** `84dec1d` (mcp classify servers)  
**Scope:** server HTTP API, ACP host (fs/terminal/permission), system routes, frontend auth plumbing, install defaults, dependencies  
**Out of scope:** Grok CLI / xAI model backend internals, Tailscale itself, host OS hardening beyond app config

---

## Executive summary

**grok-remote is a full remote-control plane for a coding agent.** Anyone who can reach the HTTP API can spawn agents that run shell commands, read/write files, install MCP servers, share sessions, and (via self-update) pull code and restart the process. That is the product — not a bug in isolation — but **upstream shipped with no application authentication** and default bind `0.0.0.0`, relying entirely on Tailscale network perimeter.

| Severity | Count (upstream) | Status in this fork |
|---|---|---|
| Critical | 3 | Mitigated (auth fail-closed, safer bind default, token support) |
| High | 6 | Partially mitigated (path/symlink, pkill, terminal cwd) |
| Medium | 7 | Documented; residual by design |
| Low / Informational | 8 | Documented |

**Residual risk after hardening:** A valid token holder (or anyone on an explicitly open bind) still has **full user-equivalent RCE** through the agent. Treat the token like an SSH private key. Prefer Tailscale ACLs + app token together.

---

## Threat model

| Asset | Impact if compromised |
|---|---|
| HTTP API on `:7910` | Arbitrary agent prompts → shell as server UID; file R/W in agent cwd; MCP install; session share; self-update |
| `~/.grok` / `~/.grok-remote` | Session history, agent transcripts, memory, credentials for grok CLI |
| Host user account | Same as any process running as that user (here often root on jump boxes — **do not run as root in production**) |
| Tailnet peers | If API is open on tailnet without token, any device on the account can RCE |

**Assumptions in product design**

1. Operator trusts devices on their Tailscale account (or further restricts via ACL tags).
2. Agent is expected to run developer tools with broad permissions (`--always-approve` by default).
3. Phone UI is a privileged remote, not a sandbox for untrusted users.

---

## Critical findings

### C1 — No application authentication (upstream)

**Where:** `server.ts` HTTP entry; all `/api/*` routes.  
**Issue:** Unauthenticated REST + SSE.  
**Impact:** Full remote agent control = RCE as server user.  
**Fork fix:** `lib/auth.ts` + gate in `server.ts`:

- `GROK_REMOTE_TOKEN` or `GROK_REMOTE_TOKEN_FILE`
- Accept `Authorization: Bearer`, `X-Grok-Remote-Token`, or `?token=` (for EventSource)
- **Fail closed** when bound to non-loopback without a token (unless `GROK_REMOTE_ALLOW_OPEN=1`)
- Frontend stores token in `localStorage` and attaches to fetch/SSE (`src/lib/api.ts`)

### C2 — Default bind all interfaces without auth (upstream)

**Where:** `HOST` default `0.0.0.0`; `ecosystem.config.cjs`.  
**Issue:** On a VPS with a public IP, port 7910 may be reachable from the internet if firewall is open.  
**Impact:** Internet-wide RCE.  
**Fork fix:** Default `HOST` / `GROK_REMOTE_HOST` to `127.0.0.1`. Tailnet installs must set `0.0.0.0` **and** set a token (or use Tailscale serve + local bind).

### C3 — Unauthenticated self-update = code execution (upstream)

**Where:** `POST /api/version/update` → `runUpdate()` git pull + npm install + pm2 restart.  
**Issue:** Any network client can pull `origin/main` and restart. Compromised `origin` or force-push to a writable remote becomes remote code path.  
**Impact:** Persistent RCE.  
**Fork fix:** Covered by API auth gate. **Still:** do not point `origin` at untrusted remotes; prefer this fork’s origin; consider disabling update endpoint on production hosts later.

---

## High findings

### H1 — Permission host always approves

**Where:** `lib/permission-host.ts` always returns `allow_always`.  
**Issue:** Combined with default `alwaysApprove: true` / `--always-approve`, there is no human-in-the-loop for dangerous tools when using the remote UI.  
**Impact:** Prompt injection / model mistakes execute without confirmation.  
**Status:** By design for “Codex-like remote”. Residual. Consider UI-driven approval later.

### H2 — Terminal host runs arbitrary shell (by design)

**Where:** `lib/terminal-host.ts` → `/bin/bash -lc <command>`.  
**Issue:** Agent can run any command the OS user can. FS scope does not contain shell.  
**Fork fix:** Reject terminal `cwd` outside agent scope; strip dangerous env (`LD_PRELOAD`, `NODE_OPTIONS`, …). Shell command body remains unrestricted (inherent).

### H3 — Agent spawn accepts arbitrary `cwd`

**Where:** `agent-manager.spawn({ cwd })` if path exists.  
**Issue:** Attacker can aim agent workspace at sensitive directories (e.g. `/root`, `/var/www`) then use Files API.  
**Status:** Residual. Recommend future allow-list under `$HOME` / configured roots.

### H4 — `pkill -f <cwd>` blast radius (upstream)

**Where:** `handleTerminalKill` for grok bg tasks.  
**Issue:** Short or common cwd strings match unrelated processes (`pkill -f /` is catastrophic).  
**Fork fix:** Require long, path-like `output_file` or cwd; pass `--` to pkill; refuse otherwise.

### H5 — Path traversal / symlink (partial upstream defenses)

**Where:** Files API, `fs-host`, memory routes.  
**Upstream:** Separator-aware `startsWith` on some paths; `safeJoin` used prefix check **without** separator (classic `/app` vs `/application` bug).  
**Fork fix:** Separator-aware `safeJoin`; `resolveWithinScope` + `realpath` for files API and fs-host.

### H6 — System routes are god-mode

**Where:** `/api/system/*` — MCP add (arbitrary command), leaders kill, memory/skills/agents file edit, worktree destroy, setup.  
**Issue:** Same auth as rest of API; once in, full grok CLI surface.  
**Status:** Expected once authenticated; reason tokens must be high-entropy and private.

---

## Medium findings

| ID | Issue | Notes |
|---|---|---|
| M1 | Default `autoApprove: true` in settings | Product default; change in UI/settings if you want friction |
| M2 | 32 MB JSON body limit on main API | DoS via large base64 images; still capped |
| M3 | SSE streams never authenticate client identity beyond token | Token in query string leaks to logs/Referer; prefer header when possible |
| M4 | Session `updates` scan under `~/.grok/sessions` | UUID validated; may expose other sessions on same host to API client |
| M5 | `grok share` publish endpoint | Can publish session content externally once authenticated |
| M6 | Frontend XSS surface via `innerHTML` markdown | `renderMarkdownLight` escapes then limited tags; links not fully hardened; treat agent HTML carefully |
| M7 | Running as root | This jump box runs as root — **highly discouraged** for production |

---

## Low / informational

- No rate limiting / brute-force protection on token.
- No audit log of who issued prompts.
- CORS not explicitly set (same-origin PWA is fine; open browser tools on other origins get default same-origin policy).
- Service worker (`public/sw.js`) — review cache poisoning if offline shell grows.
- npm audit (dev): postcss, esbuild/vite, babel — **devDependency** chain; production runtime deps had 0 vulns at audit time.
- Installer can open Chrome automatically; fine on desktop, irrelevant on headless VPS.

---

## Dependency audit (2026-07-26)

```
npm audit --omit=dev  →  0 vulnerabilities
npm audit (incl. dev) →  4 issues in vite/esbuild/postcss/babel (dev tooling)
```

Runtime dependencies (`react`, `@xyflow/react`, `dagre`, `split.js`) are UI-only; server is largely Node stdlib + `tsx` for TypeScript execution.

---

## Hardening shipped in this fork

| Change | File(s) |
|---|---|
| Bearer / header / query token auth + fail-closed | `lib/auth.ts`, `server.ts` |
| Safer default bind `127.0.0.1` | `server.ts`, `ecosystem.config.cjs` |
| Separator-safe static join + realpath scope for files | `server.ts` |
| Symlink-aware fs-host scope | `lib/fs-host.ts` |
| Safer bg-task kill | `server.ts` |
| Terminal cwd scope + env denylist | `lib/terminal-host.ts` |
| Frontend token plumbing for fetch + EventSource | `src/lib/api.ts`, chat/flow views |
| Auth unit tests | `test/auth.test.ts` |

---

## Recommended deployment (IONOS / this host)

1. **Do not expose 7910 on the public NIC.** Firewall: allow only Tailscale / localhost.
2. Run as a **non-root** user with access only to the repos you want edited.
3. Set a strong token:
   ```bash
   export GROK_REMOTE_TOKEN="$(openssl rand -base64 32)"
   # or write to ~/.grok-remote/token with mode 600 and:
   export GROK_REMOTE_TOKEN_FILE="$HOME/.grok-remote/token"
   ```
4. For phone access over Tailscale:
   ```bash
   export HOST=0.0.0.0   # or GROK_REMOTE_HOST
   export GROK_REMOTE_TOKEN=...
   # ensure ufw/iptables does NOT open 7910 on the public IP
   ```
   Prefer **Tailscale Serve** binding to localhost only if available on your plan.
5. Open UI once with `https://<magicdns>:7910/?token=...` so the PWA stores the token.
6. Keep ShellFish + tmux as break-glass access.

---

## What we still will not claim

- Agent sandbox isolation (Grok’s own `--sandbox` is optional and not forced here).
- Multi-user / multi-tenant security.
- Formal pen-test or fuzzing of every system route.
- Guarantees against prompt injection.

---

## Test plan for this audit branch

- [x] Unit tests including `test/auth.test.ts`
- [x] `npm run build`
- [ ] Local-mode server smoke (`HOST=127.0.0.1`)
- [ ] Token required when `HOST=0.0.0.0` without `ALLOW_OPEN`
- [ ] Integration tests if `grok` logged in
- [ ] Tailnet reachability from phone (needs user device online)
