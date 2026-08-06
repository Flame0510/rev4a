# Session Maintenance Integration Plan

> **Created:** 2026-08-04
> **Status:** Proposal — not yet implemented
> **Based on:** OpenClaw docs v2026.1.x — session maintenance, pruning, compaction, transcript hygiene

---

## 1. What OpenClaw Provides (Reference)

Rev4a already reads session state via the daemon (`daemon.js`) polling `openclaw sessions --json --all-agents`. The proposed integration adds **read + write** access to OpenClaw's built-in maintenance controls.

### 1.1 `session.maintenance` (store + transcript cleanup)

```json5
{
  session: {
    maintenance: {
      mode: "warn",              // "warn" | "enforce"
      pruneAfter: "30d",         // age cutoff for stale entries
      maxEntries: 500,           // cap on sessions.json entries
      resetArchiveRetention: "30d",  // retention for *.reset.<timestamp> archives
      maxDiskBytes: "500mb",     // optional hard budget
      highWaterBytes: "400mb",   // optional target after cleanup (default: 80% of maxDiskBytes)
    }
  }
}
```

**Enforcement order** (`mode: "enforce"`):
1. Remove oldest unreferenced transcript/trajectory artifacts first.
2. If still over `highWaterBytes`, evict oldest session entries + their files.
3. Keep going until at or below `highWaterBytes`.

**CLI:**
```bash
openclaw sessions cleanup --dry-run    # preview
openclaw sessions cleanup --enforce    # apply
openclaw sessions cleanup --all-agents # all configured agents
```

### 1.2 `session.reset` (session rotation)

```json5
{
  session: {
    reset: {
      mode: "daily",        // "daily" | "idle"
      atHour: 4,            // daily reset hour (local TZ)
      idleMinutes: 60,      // idle reset threshold
    },
    resetByType: {
      direct: { mode: "idle", idleMinutes: 240 },
      group:  { mode: "idle", idleMinutes: 120 },
      thread: { mode: "daily", atHour: 4 },
    },
  }
}
```

Background events (heartbeat, cron, exec notifications) do **not** keep daily/idle sessions fresh.

### 1.3 `contextPruning` (in-memory tool-result trimming)

```json5
{
  agents: {
    defaults: {
      contextPruning: { mode: "cache-ttl", ttl: "5m" }
    }
  }
}
```

Does not modify transcripts. Reduces context bloat from accumulated tool outputs.

### 1.4 `compaction` refinements

```json5
{
  agents: {
    defaults: {
      compaction: {
        model: "ollama/qwen3:8b",           // dedicated summarization model
        memoryFlush: { enabled: true },      // silent memory save before compaction
        truncateAfterCompaction: true,       // rotate to successor transcript
        maxActiveTranscriptBytes: "20mb",   // file-size guard for local reopen
        midTurnPrecheck: { enabled: true }, // tool-loop guard
        notifyUser: true,                    // show compaction status in chat
      }
    }
  }
}
```

### 1.5 `cron.sessionRetention` + `cron.runLog`

```json5
{
  cron: {
    sessionRetention: "24h",                   // prune isolated cron sessions
    runLog: { maxBytes: 2_000_000, keepLines: 2000 }
  }
}
```

---

## 2. Integration Scope

### Phase A — Read-only: Show current state

- [ ] **Maintenance status card** — new card on the Sessions page showing current `session.maintenance` config and disk usage stats
- [ ] **Pruning/compaction indicators** — per-agent badges showing whether pruning is enabled, compaction count, last compaction timestamp

### Phase B — Configuration UI

- [ ] **New page: `/maintenance`** (or section inside `/sessions`)
  - Configure `session.maintenance.mode`, `pruneAfter`, `maxEntries`, `maxDiskBytes`, `highWaterBytes`
  - Configure `session.reset` (mode, atHour, idleMinutes, resetByType overrides)
  - Configure `contextPruning` (mode, ttl)
  - Configure compaction knobs (model, truncation, memory flush)
- [ ] **Write back to `openclaw.json`** via `POST /api/maintenance/config`

### Phase C — Trigger actions

- [ ] **"Run Cleanup Now" button** — triggers `openclaw sessions cleanup` with dry-run preview
  - API: `POST /api/maintenance/cleanup` with `{ dryRun: true/false }`
- [ ] **Per-agent cleanup** — cleanup for a single agent
- [ ] **Scheduled cleanup** — register a cron job in `openclaw.json` that runs periodic cleanup

### Phase D — Dashboard widgets

- [ ] **Disk health card** — sessions directory size, trajectory sidecars, orphan count
- [ ] **Retention timeline** — visual of sessions aging toward prune cutoff
- [ ] **Compaction history** — per-agent compaction counts + timestamps

---

## 3. API Design

### `GET /api/sessions/maintenance`

Returns current maintenance status from all agent stores.

```json
{
  "agents": [
    {
      "agentId": "atlas",
      "storePath": "/root/.openclaw/agents/main/sessions/sessions.json",
      "entryCount": 47,
      "diskBytes": 2457600,
      "config": {
        "mode": "warn",
        "pruneAfter": "30d",
        "maxEntries": 500,
        "maxDiskBytes": null,
        "highWaterBytes": null,
        "resetArchiveRetention": "30d"
      },
      "staleCount": 12,
      "orphanCount": 3
    }
  ],
  "summary": {
    "totalEntries": 120,
    "totalDiskBytes": 5242880,
    "totalStale": 28,
    "warnings": ["85% of disk budget used for agent: atlas"]
  }
}
```

**Implementation:**
- Host agent: read `~/.openclaw/agents/<id>/sessions/sessions.json` + parse config
- Container agents: `docker exec` to read the same paths
- Disk usage: `du -s` on the sessions directory

### `POST /api/sessions/maintenance/config`

Write maintenance config to an agent's `openclaw.json`.

**Body:**
```json
{
  "agentId": "atlas",
  "maintenance": {
    "mode": "enforce",
    "pruneAfter": "14d",
    "maxEntries": 300,
    "maxDiskBytes": "200mb",
    "highWaterBytes": "160mb"
  }
}
```

**Side effects:**
- Writes `session.maintenance.*` into the agent's `openclaw.json` via `openclaw config patch`
- No restart needed (read at runtime)

### `POST /api/sessions/maintenance/cleanup`

Trigger a cleanup run. Supports dry-run + per-agent scope.

**Body:**
```json
{
  "agentId": "atlas",
  "dryRun": true
}
```

**Response (dry-run):**
```json
{
  "agentId": "atlas",
  "dryRun": true,
  "beforeCount": 47,
  "afterCount": 35,
  "pruned": 12,
  "capped": 0,
  "diskFreedBytes": 1024000
}
```

**Implementation:**
- Host agent: `openclaw sessions cleanup --agent <id> --dry-run --json`
- Container agents: `docker exec openclaw-atlas openclaw sessions cleanup --dry-run --json`

### `POST /api/sessions/maintenance/schedule`

Register a cleanup cron job on the host gateway or inside an agent container.

**Body:**
```json
{
  "agentId": "atlas",
  "schedule": "0 3 * * 0",  // weekly Sunday 3 AM
  "mode": "enforce"
}
```

**Implementation:**
- Uses `openclaw cron add` inside the target container or host
- Creates an `agentTurn` job that runs `openclaw sessions cleanup --enforce`

---

## 4. UI/UX Design — Complete User Flow

### 4.0 Entry Point & Navigation

User lands on `/maintenance` from the sidebar (between `Sessions` and `Crons`). A badge on the nav item shows the total stale entry count when > 0.

**Top-level structure:** Two tabs — `[Overview]` (default) and `[Settings]`.

### 4.0a Complete Interaction Flow

```
User lands on /maintenance (Overview tab — read-only)
         │
         ├── Tab: Overview ──────────────────────────────┐
         │     │                                         │
         │     ├── View aggregate metrics (all agents)   │
         │     ├── View per-agent status cards           │
         │     │     │                                   │
         │     │     ├── [Dry-Run] → inline preview      │
         │     │     │     └── Preview expanded          │
         │     │     │         ├── [Apply this cleanup] → confirm modal → execute → toast
         │     │     │         └── [Dismiss] → collapse  │
         │     │     │                                   │
         │     │     └── [Apply] → confirm modal         │
         │     │           └── Confirm → execute → toast │
         │                                               │
         └── Tab: Settings ────────────────────────────┐ │
               │                                       │ │
               ├── Select agent from left ItemList     │ │
               ├── View/Edit config (right panel)      │ │
               │     ├── Cleanup section               │ │
               │     ├── Disk Budget section           │ │
               │     ├── Session Reset section         │ │
               │     │     └── [Configure ▸] → modal    │ │
               │     ├── Context Pruning section       │ │
               │     ├── Compaction section            │ │
               │     └── Scheduled Cleanup section     │ │
               │                                       │ │
               └── [Save Configuration] → toast        │ │
                                                       └─┘
```

---

### 4.1 Overview Tab

**Purpose:** At-a-glance health of all agent session stores. Read-only except for dry-run → apply actions.

**Full layout:**

```
┌──────────────────────────────────────────────────────────────┐
│  [Overview]  [Settings]                                      │
│                                                              │
│  ┌────────────┬────────────┬────────────┬────────────────┐  │
│  │ Sessions   │ Disk Usage │ Stale      │ Mode           │  │
│  │ 120 total  │ 5.2 MB     │ 28 (>30d)  │ warn ⚠️        │  │
│  └────────────┴────────────┴────────────┴────────────────┘  │
│                                                              │
│  Agents                                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ● atlas                      warn       47 sessions    │  │
│  │ ▓▓▓▓▓▓▓▓▓░░░ 2.4 MB         12 stale · 3 orphans      │  │
│  │                                        [Dry-Run] [Apply]│  │
│  │ ┌────────────────────────────────────────────────────┐ │  │
│  │ │  🔍 Dry-Run Results                                │ │  │
│  │ │  ────────────────                                  │ │  │
│  │ │  Entries: 47 → 35  (-12, 0 capped)                │ │  │
│  │ │  Disk:    2.4 MB → 1.8 MB  (-600 KB)              │ │  │
│  │ │  • 9 entries >30d — pruned                        │ │  │
│  │ │  • 3 orphan transcripts — removed                 │ │  │
│  │ │  • 0 entries capped                               │ │  │
│  │ │  [Apply this cleanup]  [Dismiss]                  │ │  │
│  │ └────────────────────────────────────────────────────┘ │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ ○ prometheus                 warn       18 sessions    │  │
│  │ ▓▓▓▓▓▓▓░░░░░ 0.8 MB         2 stale · 0 orphans       │  │
│  │                                        [Dry-Run] [Apply]│  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**Interaction details:**

1. **Top metric row** — 4 `Metric` cards showing aggregate totals across all agents
2. **Agent cards** — one `Surface` per agent, showing:
   - Agent name + mode `Badge` (`warn` yellow / `enforce` green)
   - Session count with a horizontal bar (fill = sessionCount / maxEntries, color: green <50%, yellow <80%, red >90%)
   - Disk usage bar (same color logic, fill = currentBytes / maxDiskBytes)
   - Stale count + orphan count
   - Two `Button` components: `[Dry-Run]` (secondary) and `[Apply]` (danger)
3. **Dry-Run** click → `CleanupResult` component expands inline below the card with a smooth height transition
4. **Apply** click from card → opens the confirm modal directly (skips preview)
5. **Apply this cleanup** click from expanded Dry-Run → opens the same confirm modal
6. **Dismiss** → collapses the inline result

**Confirm modal (Apply):**
```
┌──────────────────────────────────────────────┐
│  Apply Cleanup — atlas                       │
│                                              │
│  This will permanently remove:               │
│  • 12 stale session entries (>30d)          │
│  • 3 orphan transcript files                │
│                                              │
│  ⚠️ This cannot be undone.                  │
│                                              │
│  [Confirm & Cleanup]  [Cancel]              │
└──────────────────────────────────────────────┘
```

**Loading states:**
- `[Dry-Run]` → shows "Analyzing…" with spinner on the button
- `[Apply]` → shows "Cleaning…" with spinner on the button
- During cleanup, the confirm modal's `[Confirm & Cleanup]` shows spinner, both buttons disabled

**Success:** Toast `✓ Cleanup complete — atlas. Removed 12 entries, freed 600 KB.`

---

### 4.2 Settings Tab

**Purpose:** Configure `session.maintenance`, `session.reset`, `contextPruning`, and `compaction` per agent. Dual-panel layout.

**Full layout:**

```
┌──────────────────────────────────────────────────────────────────┐
│  [Overview]  [Settings]                                          │
│                                                                  │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐ │
│  │ Agents        │  │  Maintenance — atlas                     │ │
│  │               │  │                                          │ │
│  │ ● atlas       │  │  ── Cleanup ──                           │ │
│  │   warn 47     │  │  Mode:        ○ Warn  ● Enforce          │ │
│  │               │  │  Prune After: [ 30 ] days                │ │
│  │ ○ prometheus  │  │  Max Entries:  [ 500 ]                   │ │
│  │   warn 18     │  │  Reset Archives: [ 30 ] days  [Disable]  │ │
│  │               │  │                                          │ │
│  │ ○ argus       │  │  ── Disk Budget (optional) ──            │ │
│  │   enforce 73  │  │  Max Disk:     [ 500 ] MB                │ │
│  │               │  │  High Water:   [ 400 ] MB (80% of max)   │ │
│  │               │  │                                          │ │
│  │               │  │  ── Session Reset ──                     │ │
│  │               │  │  Mode:  ● Daily at [04]:00               │ │
│  │               │  │         ○ Idle after [60] min            │ │
│  │               │  │  Per-type overrides:  [Configure ▸]      │ │
│  │               │  │                                          │ │
│  │               │  │  ── Context Pruning ──                   │ │
│  │               │  │  Mode:  ● Off                            │ │
│  │               │  │         ○ cache-ttl [ 5 ] min            │ │
│  │               │  │                                          │ │
│  │               │  │  ── Compaction ──                         │ │
│  │               │  │  Memory Flush:    [✓] Enabled            │ │
│  │               │  │  Truncate:        [✓] Enabled            │ │
│  │               │  │  Max Transcript:  [ 20 ] MB              │ │
│  │               │  │  Mid-turn guard:  [ ] Enabled            │ │
│  │               │  │  Notify User:     [✓] Enabled            │ │
│  │               │  │  Dedicated model: [ollama/qwen3:8b    ▾] │ │
│  │               │  │                                          │ │
│  │               │  │  ── Scheduled Cleanup ──                 │ │
│  │               │  │  [✓] Run automatically                   │ │
│  │               │  │  Schedule: [0 3 * * 0 ▾]   Weekly Sun 3AM│ │
│  │               │  │  Quick: [Daily] [Weekly] [Monthly]       │ │
│  │               │  │  Mode:    ● Enforce  ○ Dry-run only      │ │
│  │               │  │  Next run: Sun, Aug 10 2026 03:00        │ │
│  │               │  │  Last run: never                         │ │
│  │               │  │                                          │ │
│  │               │  │  [Save Configuration]                    │ │
│  └──────────────┘  └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**Interaction details:**

1. **Left panel — Agent selector** (`ItemList`):
   - Each agent row shows name + mode badge + session count
   - Active agent is highlighted (●)
   - Clicking an agent loads its config into the right panel
   - If user has unsaved changes, show a confirmation before switching

2. **Right panel — Config form**:
   - Each section has a section header (e.g. `── Cleanup ──`)
   - Radio buttons for mode selections (Warn/Enforce, Daily/Idle, Off/cache-ttl)
   - Number inputs for thresholds (days, MB, entries)
   - Checkboxes for boolean toggles
   - `Select` dropdown for the compaction model
   - The `[Disable]` button on Reset Archives sets the value to `false`
   - `[Configure ▸]` opens the Per-type overrides modal

3. **Button state logic:**
   - No changes → `[Save Configuration]` is disabled (grey/greyed-out primary)
   - Any field changed → button becomes active (primary/blue)
   - After save → disabled again, toast confirms "Configuration saved"

**Per-type Overrides Modal** (triggered by `[Configure ▸]`):

```
┌──────────────────────────────────────────────┐
│  Session Reset — Per-Type Overrides          │
│                                              │
│  Direct:  ● Daily at [04]:00                │
│           ○ Idle after [240] min             │
│           ○ Inherit (from global)            │
│                                              │
│  Group:   ○ Daily at [04]:00                │
│           ○ Idle after [120] min             │
│           ● Inherit (from global)            │
│                                              │
│  Thread:  ○ Daily at [04]:00                │
│           ○ Idle after [60] min              │
│           ● Inherit (from global)            │
│                                              │
│  [Save]  [Cancel]                            │
└──────────────────────────────────────────────┘
```

- Three rows: Direct, Group, Thread
- Each row: mode radio + value input
- "Inherit (from global)" means no override — uses the parent config
- Modal Save merges into the main form state (not saved independently)

**Scheduled Cleanup — Quick Presets:**
- `[Daily]` → fills `0 3 * * *` (every day at 3 AM)
- `[Weekly]` → fills `0 3 * * 0` (Sunday at 3 AM)
- `[Monthly]` → fills `0 3 1 * *` (1st of month at 3 AM)
- User can still type a custom cron expression manually
- "Next run" preview updates reactively as the schedule changes
- "Last run" reads from cron run history (nullable, shows "never" if no runs)

---

### 4.3 Component Checklist

| New Component | Location | Purpose |
|---|---|---|
| `MaintenancePageClient` | `app/maintenance/PageClient.tsx` | Page shell, tab state, top-level data fetching |
| `MaintenanceOverview` | `app/maintenance/Overview.tsx` | Aggregate metric cards + agent card list |
| `AgentMaintenanceCard` | `app/maintenance/AgentCard.tsx` | Single agent: bars, dry-run/apply, expands inline result |
| `CleanupResult` | `app/maintenance/CleanupResult.tsx` | Inline expandable cleanup preview/result (shared by Overview + Settings) |
| `MaintenanceSettings` | `app/maintenance/Settings.tsx` | Dual-panel: agent selector + config form |
| `MaintenanceConfigForm` | `app/maintenance/ConfigForm.tsx` | Config editor with all sections, dirty-tracking, save |
| `ResetOverridesModal` | `app/maintenance/ResetOverridesModal.tsx` | Per-type reset override modal (direct/group/thread) |
| `ConfirmCleanupModal` | `app/maintenance/ConfirmCleanupModal.tsx` | Confirmation dialog before destructive cleanup |

**Reused from `ui/`:** `Page`, `PageHeader`, `Surface`, `Metric`, `Button`, `Select`, `Input`, `Tabs`, `ItemList`, `Pill`, `Badge`, `Toast`, `Modal`, `LoadingSpinner`.

**Zero new visual primitives.** All layout uses existing components + inline style on wrapping `<div>` elements only. Interactive elements are `<button type="button">` with `aria-label`.

---

## 5. Data Flow

```
Rev4a UI                    Rev4a API                 Agent Container
─────────                     ───────────                 ────────────────
                                                      
GET /api/sessions/maintenance                             
  │                                                       docker exec openclaw-atlas \
  │                                                         openclaw sessions cleanup \
  │                                                           --dry-run --json
  │                                                       du -s /root/.openclaw/agents/*/sessions/
  │                           │                           
  │◄── JSON ──────────────────│                           
  │                           │                           
POST /api/sessions/maintenance/config                     
  │                           │                           
  │                           │── docker exec openclaw-atlas \
  │                           │     openclaw config patch --stdin
  │                           │     (writes session.maintenance)
  │                           │                           
  │◄── OK ────────────────────│                           
                                                      
POST /api/sessions/maintenance/cleanup                    
  │                           │                           
  │                           │── docker exec openclaw-atlas \
  │                           │     openclaw sessions cleanup \
  │                           │       --enforce --json
  │                           │                           
  │◄── result ────────────────│                           
```

---

## 6. Implementation Plan

### Sprint 1: Read-only status (2-3 days)

1. Create `GET /api/sessions/maintenance` endpoint
   - Read config from agents' `openclaw.json` (host + containers)
   - Count entries in `sessions.json`
   - Compute disk usage via `du`
   - Identify stale entries (older than `pruneAfter`)
2. Create `MaintenancePageClient` + `MaintenanceOverview` + `AgentMaintenanceCard`
3. Wire into sidebar navigation
4. Add to `docs/FRONTEND-ARCHITECTURE.md` and `docs/REV4A.md`

### Sprint 2: Configuration (2 days)

1. Create `POST /api/sessions/maintenance/config` endpoint
   - Write `session.maintenance` into target `openclaw.json`
   - Validate duration strings (`"30d"`, `"500mb"`, etc.)
2. Create `MaintenanceConfigForm` component
3. Add session reset + context pruning + compaction controls

### Sprint 3: Trigger actions (1-2 days)

1. Create `POST /api/sessions/maintenance/cleanup` endpoint
   - Dry-run + enforce modes
   - Per-agent or all-agents scope
2. Create `CleanupResult` component
3. Create `POST /api/sessions/maintenance/schedule` endpoint
   - Register periodic cleanup cron

### Sprint 4: Dashboard widgets (1 day)

1. Disk health card on `/dashboard`
2. Retention timeline widget
3. Compaction history widget

---

## 7. Open Questions

1. **Host vs container scoping:** The `openclaw sessions cleanup` command is per-agent-store. Should the Rev4a `/maintenance` page scope by agent or show host-level aggregate? _Recommendation: per-agent with aggregate overview._

2. **Write-back auth:** Writing `session.maintenance` config into agent containers requires `docker exec` access. Already used by Gateway sync — no new permissions needed.

3. **Cron session retention:** `cron.sessionRetention` is separate from `session.maintenance`. Should Rev4a expose this too? _Recommendation: yes, add to the cron page or as a maintenance sub-tab._

4. **Scheduling cleanup as a cron job:** Who owns the cleanup cron? Options:
   - Host gateway cron (runs for all agents)
   - Per-agent container cron (each agent cleans itself)
   _Recommendation: per-agent container cron by default, host-level as optional override._

---

## 8. Doc Checklist (for final PR)

- [ ] `docs/REV4A.md` — new `/maintenance` page
- [ ] `docs/FRONTEND-ARCHITECTURE.md` — new components
- [ ] `docs/dev/API-REFERENCE.md` — new endpoints
- [ ] `docs/ARCHITECTURE.md` — maintenance subsystem if needed
- [ ] `docs/DESIGN-SYSTEM.md` — no new tokens needed (reuses existing)
- [ ] `docs/dev/GATEWAY.md` — applicable? Unlikely unless agent-level config changes

---

## 9. References

- [Session maintenance](/concepts/session) — OpenClaw docs
- [Session management deep dive](/reference/session-management-compaction) — store schema + maintenance rules
- [Compaction](/concepts/compaction) — auto + manual compaction
- [Session pruning](/concepts/session-pruning) — tool-result trimming
- [Transcript hygiene](/reference/transcript-hygiene) — provider-specific fixups
- [Cron jobs](/automation/cron-jobs) — cron.sessionRetention + run log config
- [Rev4a API Reference](API-REFERENCE.md)
- [Rev4a Frontend Architecture](../FRONTEND-ARCHITECTURE.md)
