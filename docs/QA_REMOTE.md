# Grok Remote — extensive QA plan (phone Remote)

Visual source of truth: ChatGPT Remote (OpenAI docs + user screenshots).  
Product job: scan main sessions, see stuck/done, nudge from iPhone.

## A. API / backend

| # | Check | How | Pass |
|---|---|---|---|
| A1 | Health + auth | `GET /api/health`, `/api/auth/status` → tailnet, no token required | |
| A2 | Remote hello | `GET /api/remote/hello` → hostLabel, tailscale | |
| A3 | Main sessions only | `GET /api/remote/sessions` — zero IDs from `collectSubagentIds()` | |
| A4 | Project groups | Response has `projects[]` with plain-text labels (no emoji) | |
| A5 | Status fields | Each session has status in stuck/running/waiting/done | |
| A6 | Open session | `POST /api/remote/sessions/:id/open` → agent + history seed | |
| A7 | New task | `POST /api/remote/tasks` with text → agent created + prompt accepted | |
| A8 | Prompt continue | `POST /api/agents/:id/prompt` → 202 | |
| A9 | CLI + remote sources | List includes both local CLI sessions and grok-remote agent sessions | |

## B. Visual / Playwright (phone 390×844)

| # | Check | How | Pass |
|---|---|---|---|
| B1 | Remote shell default | Load `/#/remote` — no legacy topbar/rail | |
| B2 | Header | “Remote” + green host pill + outline computer icon | |
| B3 | Projects label | H1 “Projects” | |
| B4 | Folder outline | Project rows use SVG outline folder (not emoji) | |
| B5 | No emoji in labels | Project names plain ASCII/text | |
| B6 | Thread titles | Main session titles under folders | |
| B7 | Status dots | Tiny dots only (not loud chips) | |
| B8 | Bottom bar | Chats pill + mic + white compose | |
| B9 | Open thread | Title + host subtitle; quote/body; Work on host bar | |
| B10 | Links on-device | `a.rr-link` has target=_blank rel=noopener | |
| B11 | Advanced escape | Footer link to `#/advanced` | |
| B12 | Screenshots | Capture home + thread; vision review vs ChatGPT Remote | |

## C. Real-world functional (live host)

| # | Check | How | Pass |
|---|---|---|---|
| C1 | List non-empty | ≥ 1 main project group after sync | |
| C2 | Open known session | e.g. Background workflow… | |
| C3 | History present | User and/or assistant content after open | |
| C4 | Nudge | Send short message; agent responds or status updates | |
| C5 | Subagents hidden | No research child UUIDs in list | |
| C6 | Telegram optional | Optional photo of live UI for human QA | |

## D. Regression

| # | Check | How | Pass |
|---|---|---|---|
| D1 | Unit tests | `npm test` | |
| D2 | Build | `npm run build` | |
| D3 | PM2 online | listens on Tailscale IP only | |
| D4 | Public IP closed | 74.x:7910 refused | |

## Iterate

Any fail → fix → re-run section → only then ship.
