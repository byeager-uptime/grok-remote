# Dogfood Report: Grok Remote (phone shell)

| Field | Value |
|-------|-------|
| **Date** | 2026-07-27 |
| **App URL** | http://100.92.95.79:7910/#/remote |
| **Session** | grok-remote (agent-browser, viewport 390×844) |
| **Scope** | Every chrome control, list action, thread action, new-task flow, cloud open, advanced escape hatch. Live decisions; report written as findings appeared. |
| **Tool** | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) 0.33.0 |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 5 |
| Medium | 6 |
| Low | 4 |
| **Total** | **17** |

## Exploration log (control-by-control)

| Control | Expected | Actual | Verdict |
|---------|----------|--------|---------|
| Load `#/remote` | Projects list | List loads; 2 folders; sessions | OK |
| **Menu** (header ☰) | Open nav / drawer | **Nothing** | FAIL → ISSUE-001 |
| **More** (⋯ home) | Menu of actions | **Nothing** | FAIL → ISSUE-001 |
| **Search** (🔍) | Search sessions | **Nothing** | FAIL → ISSUE-001 |
| **Chats ▾** | Filter / switch list | **Nothing** | FAIL → ISSUE-001 |
| **Voice** (home) | Disabled “coming soon” | Correctly disabled | OK (honest) |
| **New task** (+) | Sheet | Sheet opens | OK |
| Project head collapse | Toggle sessions | Works (▾→▸) | OK |
| **Open project path info** (↗) | Show path / open | **Nothing** | FAIL → ISSUE-002 |
| Thread row (local w/ history) | Open + transcript | Transcript seeds | OK (partial) |
| Thread **Menu** | Home | Navigates home | OK |
| Thread **Back** | Home | Navigates home | OK |
| Thread **Compose** (+) | New / compose | **Nothing** | FAIL → ISSUE-001 |
| Thread **More** | Actions | **Nothing** | FAIL → ISSUE-001 |
| Thread **Attach** | Attach | Disabled | OK (honest) |
| Thread **Voice** | Disabled | Disabled | OK |
| Thread composer send | Real reply | User bubble shows; **wrong / stale reply** | FAIL → ISSUE-003 |
| Markdown in reply | Readable | Raw `**`, `##`, tables | FAIL → ISSUE-004 |
| Duplicate history blocks | Single reply | Same assistant text **concatenated twice** | FAIL → ISSUE-005 |
| New task Cancel | Close sheet | Works | OK |
| New task Start on host | Live thread + reply | Navigates; **false cloud banner**; title = UUID; **reply never shown** though API has `pong` | FAIL → ISSUE-006,007,008 |
| Cloud archive open | Honest empty | Banner + empty + work bar | OK |
| List scroll | Scrollable | Works | OK |
| Advanced console link | Legacy shell | Loads `#/advanced` | OK |
| Advanced → Remote deep link | Return to phone UI | **Stays on advanced shell** (hash/SPA) | FAIL → ISSUE-009 |
| Project row a11y | One control | Nested buttons in name | FAIL → ISSUE-010 |
| Title truncation | Ellipsis | Present; no expand/tooltip | LOW → ISSUE-011 |
| Session ids as titles | Meaningful names | `Session 019fa089`, `/status` | MED → ISSUE-012 |
| Placeholder “Work on hermes-agent” | Clear action | Unclear vs “Message Grok” | LOW → ISSUE-013 |
| No pull-to-refresh / live SSE | Live updates | Static poll only on send | HIGH → ISSUE-014 |
| New task project cwd | Real project path | Landed under weird agent cwd | MED → ISSUE-015 |
| Console errors on Remote load | Clean | Clean | OK |
| Horizontal overflow (phone) | None | None | OK |

---

## Issues

### ISSUE-001: Decorative chrome buttons do nothing

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | functional / ux |
| **URL** | `#/remote` and thread |
| **Repro Video** | N/A (static behavior) |

**Description**

Home **Menu**, **More**, **Search**, **Chats ▾** and thread **Compose**, **More** are real `<button>`s with aria labels. Clicks produce zero UI change. Product feels like a ChatGPT mock with dead chrome — classic slop.

**Repro Steps**

1. Open `#/remote` → screenshot `00-initial.png`
2. Click Menu → `01-after-menu.png` (unchanged)
3. Click More / Search / Chats → same
4. Open any thread → click Compose → `08-after-compose.png` (unchanged)

**Fix direction:** Wire real behaviors **or remove** until implemented. Prefer remove/hide over fake affordances.

---

### ISSUE-002: Project “open external” button is a no-op

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | functional |
| **URL** | `#/remote` |
| **Repro Video** | N/A |

**Description**

↗ “Open project path info” does nothing (no toast, no sheet, no copy). Nested inside project collapse button (also a11y mess — ISSUE-010).

**Evidence:** `05-after-proj-ext.png`

---

### ISSUE-003: Send shows stale / wrong assistant reply

| Field | Value |
|-------|-------|
| **Severity** | critical |
| **Category** | functional |
| **URL** | `#/remote/s/<local>` |
| **Repro Video** | N/A — screenshots |

**Description**

Typed `reply with exactly: dogfood-ok` and sent. UI appended the user bubble, then showed another chunk of the **previous** seeded assistant essay (not a new answer). History poll grabs the last `agent_message_chunk` in the file — which is the old seed — instead of waiting for a new turn after the user message.

**Evidence:** `10-before-send.png`, `11-send-working.png`, `12-after-send-wait.png`

---

### ISSUE-004: Assistant markdown rendered as raw source

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | content / visual |
| **URL** | any thread with assistant text |
| **Repro Video** | N/A |

**Description**

`**bold**`, `## headings`, markdown tables, backticks all show as literal source. Unreadable on phone. Only `linkify()` HTML escape is applied.

**Evidence:** `07-thread-local.png`, `12-after-send-wait.png`

---

### ISSUE-005: Seeded history duplicates / concatenates assistant turns

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | functional |
| **URL** | local threads |
| **Repro Video** | N/A |

**Description**

Accessibility tree and DOM show the same long assistant answer fused twice (`...safety).I'll check the Grok...`). Seed merge of multiple `agent_message_chunk` lines without turn boundaries, or history seed run twice.

---

### ISSUE-006: New task falsely labeled “Cloud archive”

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | ux / functional |
| **URL** | after Start on host |
| **Repro Video** | N/A |

**Description**

Brand-new host agent shows: *“Cloud archive on this account — no transcript files on this host.”* Because `findSessionDir` is null for new UUIDs and UI treats that as cloud-only.

**Evidence:** `17-new-task-started.png`

---

### ISSUE-007: New task title is raw UUID prefix

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | content / ux |
| **URL** | new task thread |
| **Repro Video** | N/A |

**Description**

Header shows `623a7751` instead of task name (“Reply with exactly one word: pong”). Agent meta has the name; open/thread UI falls back to sessionId slice when project list has no match.

**Evidence:** `17-new-task-started.png`

---

### ISSUE-008: New task reply never appears in Remote UI

| Field | Value |
|-------|-------|
| **Severity** | critical |
| **Category** | functional |
| **URL** | new task thread |
| **Repro Video** | N/A |

**Description**

API history contains `ASST pong` and agent reaches `idle`. Thread view only loaded history once on open (before reply finished) and never streams/SSE/polls. User stares at empty thread forever unless they leave and re-enter (re-enter also broken when coming from Advanced).

**Evidence:** API dump vs `18-new-task-reply.png` (still no GROK reply)

---

### ISSUE-009: No clean return from Advanced console to Remote

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | ux / functional |
| **URL** | `#/advanced` → `#/remote` |
| **Repro Video** | N/A |

**Description**

Advanced console is a full reload. Hash-only navigation back to `#/remote` does not remount the phone shell (decision is on `DOMContentLoaded` only). No “Remote” button in advanced chrome. Easy to get stuck in the old forked UI.

**Evidence:** `21-advanced-console.png`; subsequent `#/remote/s/...` open still showed advanced a11y tree.

---

### ISSUE-010: Nested interactive controls on project rows

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | accessibility |
| **URL** | `#/remote` |
| **Repro Video** | N/A |

**Description**

Project head is a button that **contains** another button (“Open project path info”). Invalid HTML, confusing a11y tree (`button "grok-remote ▾ Open project path info"` wrapping `@e27`).

---

### ISSUE-011: Long titles truncated with no expand

| Field | Value |
|-------|-------|
| **Severity** | low |
| **Category** | ux |
| **URL** | list + thread header |
| **Repro Video** | N/A |

**Description**

Ellipsis is fine for ChatGPT parity, but no long-press / detail line for full title. Thread header especially opaque.

---

### ISSUE-012: Low-quality session titles in list

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | content |
| **URL** | `#/remote` |
| **Repro Video** | N/A |

**Description**

Rows like `Session 019fa089`, `Session 019fa087`, `/status` look unfinished. Prefer first user_query excerpt or hide empty-summary rows.

---

### ISSUE-013: Composer placeholder is host-centric noise

| Field | Value |
|-------|-------|
| **Severity** | low |
| **Category** | content |
| **URL** | thread |
| **Repro Video** | N/A |

**Description**

“Work on hermes-agent” is not how people think. Prefer “Message Grok” / “Nudge this session”.

---

### ISSUE-014: No live thread updates (no SSE / no ongoing poll)

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | functional / ux |
| **URL** | any active thread |
| **Repro Video** | N/A |

**Description**

Open loads history once. Send does a brittle short poll for last chunk. Running agents, tools, and new-task replies never stream into the phone UI. Core Remote product requirement is steering a **live** host agent.

---

### ISSUE-015: New task project picker cwd wrong / nested

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | functional |
| **URL** | new task |
| **Repro Video** | N/A |

**Description**

Selecting “grok-remote” produced agent cwd under `/root/.grok-remote/agents/9fc9a9e1-.../cwd` instead of the real repo path. Project grouping uses label “grok-remote” from a session that ran in an agent workdir.

---

### ISSUE-016: Quote + user bubble duplicate the same text

| Field | Value |
|-------|-------|
| **Severity** | low |
| **Category** | ux |
| **URL** | thread |
| **Repro Video** | N/A |

**Description**

First user message appears as blockquote **and** as user bubble. ChatGPT Remote uses quote OR message, not both.

**Evidence:** `17-new-task-started.png`

---

### ISSUE-017: “Advanced console” is the only escape; primary product still half-mock

| Field | Value |
|-------|-------|
| **Severity** | low (product judgment) |
| **Category** | ux |
| **URL** | footer |
| **Repro Video** | N/A |

**Description**

Footer admits Remote isn’t finished. Combined with dead chrome, this reads as prototype shipped as product.

---

## What actually works (credit where due)

- Host session list loads (local + cloud archives)
- Collapse project groups
- Open local session with seeded transcript
- Cloud archive honest empty state (when truly cloud)
- Cancel new-task sheet
- Start-on-host spawns real agent (API-side)
- Advanced console still usable as power-user shell
- Phone width / no horizontal overflow after layout fix

## Recommended fix order

1. **ISSUE-008 + ISSUE-014** — live thread (SSE or solid poll after open/send)
2. **ISSUE-003** — send only appends turns **after** the sent user message
3. **ISSUE-006 + ISSUE-007** — new-task open path (no cloud banner; real title)
4. **ISSUE-001** — delete or wire dead chrome
5. **ISSUE-004** — minimal markdown render
6. **ISSUE-009** — Remote entry from advanced + full reload on shell switch
7. Rest of polish

## Artifacts

All under `dogfood-output/screenshots/` (00–23) produced by agent-browser live session `grok-remote`.

---

## Fix pass (same session, after dogfood)

Shipped against findings above (commit pending):

| Issue | Status |
|-------|--------|
| ISSUE-001 dead chrome | **Fixed** — removed fake Menu/More/Search/Compose; left only Refresh + New task + Back |
| ISSUE-002 path button | **Fixed** — toast with cwd (no nested button) |
| ISSUE-003 stale send reply | **Fixed** — SSE + poll only for new turn |
| ISSUE-004 raw markdown | **Fixed** — light markdown renderer (bold, headings, code, links) |
| ISSUE-006 false cloud | **Fixed** — only when list + open agree cloud archive |
| ISSUE-007 UUID title | **Fixed** — uses agent.name |
| ISSUE-008 no new-task reply | **Fixed** — live SSE; retest showed GROK `audit-ok` |
| ISSUE-009 advanced return | **Fixed** — hashchange → reload when entering Remote |
| ISSUE-010 nested buttons | **Fixed** — project row sibling layout |
| ISSUE-013 placeholder | **Fixed** — “Message Grok” |
| ISSUE-014 no live updates | **Fixed** — EventSource `/api/agents/:id/stream` |
| ISSUE-015 bad project cwd | **Mitigated** — skip agent-workdir projects in picker |
| ISSUE-005/016 polish | partial (dedupe + quote only when multi-turn) |

### Live retest evidence (agent-browser)

- New task → title = prompt text, reply `audit-ok` on screen within ~8s (`32-new-task-after.png`)
- Follow-up send → `second-ok` (`33-send-followup.png`; double bubble fixed after)
- Markdown shows `<strong>` for bold (`34-markdown-thread.png`)
- No dead Menu/More/Search in a11y tree

