# Dogfood Report: Grok Remote phone shell

| Field | Value |
|-------|-------|
| **Date** | 2026-07-27 overnight |
| **App URL** | http://100.92.95.79:7910/#/remote |
| **Session** | overnight-phone + retest loops |
| **Scope** | Full agent-browser dogfood: videos, a11y, multi-viewport, search/send/cloud/new-task; remediate and iterate until green |
| **Tool** | vercel-labs/agent-browser 0.33.0 |

## Summary (final after remediation)

| Severity | Open | Fixed this night |
|----------|-----:|-----------------:|
| Critical | 0 | 2 (live reply / send correctness — already mid-session + verified) |
| High | 0 | 5+ |
| Medium | 1 residual | 6+ |
| Low | 2 residual | several |
| **Axe a11y violations** | **0** | was 2 |

## Core workflows — final retest

| Flow | Result | Evidence |
|------|--------|----------|
| Home load | OK, local first | `baselines/phone-home.png` |
| New task → live reply | **pass** | video `issue-new-task-flow.webm`, retest `retest-new-task.png` |
| Send button | **sendbtn-ok** | `final-send.png` |
| Search filter | Cloudflare → archive only | `retest-search2.png` |
| Cloud archive open | Honest empty + work bar | `final-cloud.png` |
| Advanced → Remote | Reload remounts phone shell | video `issue-advanced-return.webm` |
| a11y home | **0 violations** | `a11y/final-home.json` |
| Multi-viewport | phone / ipad / wide | `baselines/*` |

## Issues found → remediated

### FIXED — ISSUE-A: Sticky bottom bar covered last list rows / archive toggle
| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | functional / ux |
| **Repro Video** | `videos/issue-cloud-open.webm` (click blocked) |

**Fix:** Extra scroll padding (140px); move cloud archive toggle to **top** of list; section label “On this host”.

### FIXED — ISSUE-B: Empty new task silent no-op
| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | ux |
| **Repro Video** | `videos/issue-empty-new-task.webm` |

**Fix:** Toast “Type a task first” + focus textarea; disable double-start.

### FIXED — ISSUE-C: a11y color contrast + viewport zoom
| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | accessibility |
| **Repro Video** | N/A |

**Fix:** Advanced link contrast; chevron contrast; remove `user-scalable=no` / max-scale from viewport meta.

### FIXED — ISSUE-D: No search / fake chrome
| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | functional |

**Fix:** Working search filter; only real controls (Refresh, Search, New, Send, Back).

### FIXED — ISSUE-E: Cloud archives clutter triage list
| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | ux |

**Fix:** Collapsed “Show cloud archive (N)” with expand; search still finds them.

### FIXED — ISSUE-F: Poor titles (`Session UUID`, `/status`)
| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | content |

**Fix:** `firstUserTitle()` from disk chat_history; `/status` → “Status check”; agent name fallback.

### FIXED — ISSUE-G: No visible Send control
| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | ux |

**Fix:** White Send button in work bar (Enter still works).

### FIXED — ISSUE-H: Markdown tables raw
| Field | Value |
|-------|-------|
| **Severity** | low |
| **Category** | content |

**Fix:** Light table parser in `formatMessage`.

### FIXED — ISSUE-I: Stale list status
| Field | Value |
|-------|-------|
| **Severity** | low |
| **Category** | ux |

**Fix:** Quiet 20s list poll on home.

### FIXED — ISSUE-J: Nested project buttons / path no-op UX
| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | a11y / ux |

**Fix:** Sibling path button + toast (from prior pass, retained).

## Residual (known, non-blocking)

1. **LOW** — Seeded history may still show a rare duplicate short assistant line on old agents (new turns clean via SSE).
2. **LOW** — Quote + user bubble still both show for multi-turn opens (ChatGPT-ish; acceptable).
3. **MEDIUM** — Attach / Voice intentionally disabled (honest “coming soon”).
4. **LOW** — Table styling basic; not full GFM.

## Artifacts

```
dogfood-output/overnight/
  report.md                 (this file)
  videos/*.webm             (repro videos)
  screenshots/*             (step + annotated)
  baselines/{phone,ipad,wide}-home.png
  a11y/*.json
  snapshot-*.txt
```

## Product state for user

Hard-refresh: `http://hermes-agent.taile48ea.ts.net:7910/#/remote`

You should get:
- Phone Remote that **actually replies live**
- Search, Send, cloud archive drawer, honest empty states
- No dead chrome, 0 axe violations on home
- Better session titles

Shipped live via PM2 on hermes-agent Tailscale bind.
