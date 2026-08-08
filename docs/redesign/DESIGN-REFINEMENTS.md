# AutoDev Redesign — Prioritized Refinement List

Synthesis of three independent design critiques (drunk-designer visual audit, first-time-customer
lens, and design-system consistency check) into ONE de-duplicated, engineer-executable backlog.

Screens are the v2 mockup screenshots (`01-agents-activity` … `13-context-menu`). Component paths are
under `src/renderer/src/` unless noted. Tokens refer to `ui/theme.css`.

**Reading order:** §1 top refinements (ranked by impact on perceived quality) → §2 global/systemic
fixes → §3 quick-wins vs larger-changes split.

---

## §1 — Top refinements (ranked)

### R1 — [BLOCKER] Subfolder grouping collapses all 29 agents into one "OFFICE" bucket
**Screens:** 01-agents-activity, 09-agents (rail), 04-fleet (OFFICE column + subtitle)
**Flagged by:** all three critiques (drunk-designer names it "THE headline failure"; customer:
"0/29 connected is contradictory"; consistency: "Agents 'OFFICE' vs Fleet '0 offices'").

This is the reason the redesign exists — "office lives on the group header, rows carry only what
differs" — and it is currently nullified. In `components/agent/AgentRail.tsx`, `groupKeyFor()` short-
circuits: when an agent has `officeSlug`, `wsUrl`, or `officeAgentSlug` set, every agent falls into a
single `o:bound` → **"Office"** group (or one `o:<slug>`), so the real subfolders (`director/`,
`editor/`, `gaffer/`, `architect/`…) are never rendered as groups. The folder-based branch
(`parentFolderName`) is dead code because the office branch wins first.

**Fix:**
- `AgentRail.tsx` `groupKeyFor()` (~L82–95): when `by === 'office'`, key on the **containing
  subfolder** (`parentFolderName(a.path)`) *first*, and use `officeSlug` only as the header's mono
  `sub` (path) label — not as the grouping key. Render one `GroupHeader` per real subfolder with
  `label` = folder name, `sub` = mono office path, `running/total` + worst-status dot (the header
  already supports all of this).
- Give the "Group by" control real repartitioning options that visibly change the list: `Office
  folder / Role / Provider / State` (`GROUP_OPTIONS`, ~L184). "Office folder" must never resolve to a
  single all-encompassing bucket.
- Drop the redundant per-row office/provider badge once the header carries it (R2).
- `components/fleet/FleetTable.tsx` (L270–282): populate the OFFICE column from the **same** folder/
  office derivation, not raw `agent.officeSlug` (which is why it renders 29 `—`). If an agent is
  genuinely office-less, still show its folder; only fall back to `—` when there is truly nothing.
- `components/fleet/FleetHeader.tsx` subtitle: derive the office **count** from the grouped folders so
  it never reads "0 offices" beside 29 grouped agents.

### R2 — [MAJOR] Every row repeats identical meta ("grok · role"); provider stated 4 ways app-wide
**Screens:** 01/09 (rail meta line), 04-fleet, 08-settings
**Flagged by:** drunk-designer (identical-info anti-pattern) + consistency (provider shown as `grok` /
`grok-tui` / `grok-cli` / `Grok — interactive`).

`services/model.ts` `rowMeta()` returns `"grok · <hash>"` for every non-attention agent, so `grok`
repeats down the whole rail. Provider is separately displayed four different ways across screens.

**Fix:**
- `rowMeta()` (model.ts ~L142): when the whole group shares one provider (the common case), drop
  provider from the row meta and let the group header carry it; reserve the row meta line for what
  actually differs — state reason, session id, or last-active time. Keep the state-colored branches
  (`needs-auth`, `crashed`, etc.) as-is.
- Standardize one canonical provider **display** form (e.g. `Grok — interactive`) via a single helper
  in model.ts; show the runner id (`grok-cli` / `grok-tui`) only in a mono technical sub-line.
  `SettingsView2.tsx` provider list and `FleetTable` STATE/meta must consume that helper.

### R3 — [BLOCKER] No shared EmptyState primitive; live surfaces render static placeholders
**Screens:** 01 (Activity void), 02 (Chat "Not connected"), 03/11 (Terminal read-only), 06 (Sessions
transcript), 04 (NEEDS YOU tile)
**Flagged by:** all three (consistency: "three sub-tabs, three empty-state weights"; customer:
empty states don't explain the next action; drunk-designer: "vast empty voids").

Empty states are inconsistent and inert. Terminal has a rich icon+heading+paragraph+CTA block
(`components/agent/TerminalTab.tsx`), while Activity (`ActivityStream.tsx`), Chat (`ChatTab.tsx`), and
Sessions transcript are bare one-liners. None offer the next action.

**Fix:**
- Create `ui/EmptyState.tsx`: `{ icon, heading, subline, cta?, secondary? }`, centered, using
  `--tx-3` heading / `--tx-dim` subline and an `--accent` primary CTA. Export from `ui/index.ts`.
- Replace every ad-hoc empty block with it:
  - `ActivityStream.tsx` (agent stopped, `724/725 done`): heading "Agent is idle", subline "Press
    Start and it picks up the first unchecked task in TODO.md and works autonomously", plus the last
    session summary line, plus a primary **Start agent** CTA in the empty state (not only the toolbar).
  - `ChatTab.tsx` "Not connected": subline explaining a Pixel Office is an optional shared team server,
    primary **Connect an office…** CTA (routes to Office tab), and **hide/disable the composer + slash
    chips while disconnected** (they currently contradict the "not connected" message).
  - `SessionsView.tsx` transcript pane: auto-select the top/live session on load so the pane isn't a
    void; keep EmptyState only for a truly empty list.
- Terminal (`TerminalTab.tsx`): differentiate **stopped vs working**. When STOPPED → "Agent not
  running — Start it to see live output". When WORKING (screen 11) → stream the real tmux/session feed,
  not the "watch from a distance" paragraph. Collapse the 3-4 duplicate "Take over" affordances to one
  primary centered CTA (keep the header READ-ONLY chip as the control).

### R4 — [BLOCKER] Settings ships dev scaffolding; version block empty
**Screens:** 08-settings
**Flagged by:** all three.

`SettingsView2.tsx` shows the literal note *"These defaults are not saved yet — the app only persists
the Pixel Office URL below. Wiring is Stage 3."* and non-persisting controls, plus a footer reading
`autodev-app —  cli —`.

**Fix:**
- Remove all "Stage 3 / not wired yet" copy from release builds. For any control that isn't wired,
  either wire persistence or disable it with a product-voice "coming soon" tag — never ship an
  interactive control that silently discards input.
- Bind real app + CLI versions in the footer (spec form: `autodev-app 2.0.4 / cli 1.4.125`); hide the
  block until values resolve rather than showing `—`.

### R5 — [BLOCKER] Sessions is a wall of duplicate/untitled rows; no fold-group
**Screens:** 06-sessions
**Flagged by:** all three (the spec's headline `FoldGroupRow` is absent).

`components/sessions/SessionRow.tsx` falls back to `(untitled)` (L30) and there is no folding of
identical task-poller prompts ("Read task file execute TODO" repeated ~10×).

**Fix:**
- Add title-derivation: fall back to the first user prompt / task title (id already lives in the mono
  meta), so the headline is never `(untitled)`. Fix in `SessionRow.tsx` L30 and `TranscriptPane.tsx`
  L75.
- Implement `FoldGroupRow` in `components/sessions/`: collapse N identical-prompt runs into one
  `"N runs of the same task-poller prompt ▾"` expandable row (`SessionsView.tsx` grouping pass).

### R6 — [MAJOR] Zero/placeholder data rendered verbatim instead of suppressed
**Screens:** 01/09 (`0` task counts, `0 msgs · 0kb` session), 04-fleet (`—` OFFICE/ELAPSED columns,
all-full grey TASKS bars), 06 (`0kb` every row), 11 (`724/926` bar vs "No tasks in TODO.md")
**Flagged by:** all three.

**Fix (adopt a system-wide zero-suppression rule):**
- Hide a metadata field when it's zero/empty across all rows: task count `0` → dim dash or nothing
  (rail `AgentRow.tsx`, fleet TASKS cell); `0kb` → omit (`SessionRow.tsx`, agent SESSION card in
  `Inspector.tsx`).
- Suppress the SESSION card / disable "Watch live" when `msgs=0 && bytes=0` (`Inspector.tsx`).
- `FleetTable.tsx`: hide ELAPSED when nothing is running (or show last-run); fill the TASKS mini-bar
  proportionally (`done/total`) with a status-colored fill on `--st-track-bg` so 252/252 done ≠ 0/0
  idle (currently both render empty grey).
- Screen 11 contradiction: in `Inspector.tsx` TODO panel, if there are no parseable tasks suppress the
  progress bar (show `— / —`); if the count is real, don't show "No tasks in TODO.md".

### R7 — [MAJOR] Status-color semantics violated at zero; green means two things
**Screens:** 01/09 (RunPill green dot at `0 running`; OFFICE header green "connected" beside `0/29`),
04-fleet (header)
**Flagged by:** consistency (primary) + drunk-designer.

Green (`--st-running`) must be reserved for the running state only.

**Fix:**
- Drive the RunPill dot from the count: `--st-idle` grey when `running === 0`, green only when `> 0`.
  Apply in `AgentRail.tsx` RunPill and `FleetHeader.tsx`.
- Separate "office connected" from "running": render the connection label in `--tx-4` neutral, not
  green, in `GroupHeader` (`AgentRail.tsx`). The ratio dot follows running semantics.

### R8 — [MAJOR] Two divergent auth cards (Office vs Make-app); no shared component
**Screens:** 05-office, 07-makeapp
**Flagged by:** all three.

`OfficeView.tsx` (sentence-case labels, no emoji, full-accent Connect) vs `MakeAppView.tsx` (UPPERCASE
labels, `👷/🐤` emoji title, washed/disabled Connect) are the same form in two design languages. The
emoji chrome also breaks the IDE-native aesthetic.

**Fix:**
- Extract `ui/AuthCard.tsx` (props: `title`, `subtitle`, `submitLabel`, `onSubmit`, error slot),
  single label casing (10px uppercase `.11em` section labels per spec §1.7), no emoji in headings,
  one Connect button with real enabled/disabled states + `--accent` focus ring. Use it in both
  `OfficeView.tsx` and `MakeAppView.tsx`.
- Only show "session expired" when a prior session existed; a never-authenticated first visit gets
  neutral onboarding copy. Add a "Create account" link and a "you can run local agents without an
  office — skip for now" escape hatch (mirror the copy already in MakeApp).
- Style inline auth errors with `--st-error` (or `--st-needsyou` amber for expiry), add an error icon,
  place at top of form.
- Reconcile feature naming: nav "Make app" / card "Spawn agents" / spec "Spawn a team" → pick one
  canonical name across nav, card title, and docs.

### R9 — [MAJOR] Monotone hierarchy + sub-AA contrast on load-bearing text
**Screens:** all (rail, fleet secondary columns, session meta, settings version/disclaimer); no focus
ring on login inputs
**Flagged by:** consistency (primary) + drunk-designer + customer.

**Fix:**
- Audit `--tx-dim` / `--tx-faint` / `--tx-ghost` / `--tx-gutter` where they carry real information
  against 4.5:1 (3:1 for large) on `--bg-0`/`--bg-1`; lift to `--tx-3`/`--tx-4` where they're
  meaningful (rail meta, fleet OFFICE/STATE/task text, session meta, task-count numbers).
- Strengthen the selected-row treatment (`AgentRow.tsx`): `--bg-selected` + inset 2px `--accent` rail
  + tasks number turning `--accent`. Dim idle rows' names to `--tx-3`; let running/needs-you rows
  carry status color so the eye can triage.
- Add a visible `--accent` focus ring to all inputs/buttons (shared in `ui/Button.tsx`,
  `ui/SearchInput.tsx`, and the new `AuthCard`).

### R10 — [MAJOR] No first-run experience; seeded "movie studio" demo data looks fake/alarming
**Screens:** global (29 agents, 128 sessions, `6113 closed today`, `724/725` counters the user never
created)
**Flagged by:** customer (primary), reinforced by drunk-designer's "all-STOPPED all-zero" note.

**Fix:**
- Ship a clean first-run state (0 agents/sessions) with a guided golden path: **New agent → type the
  task → Start**. If demo content ships, badge it "Example — safe to delete" with a one-click "Clear
  examples".
- Define ONE primary CTA for "get an agent working" and de-emphasize the power-user alternatives
  (Start / composer "Add task" / New agent / Spawn / Fleet "Add" currently compete). Label the Fleet
  per-row action "Add task" and surface a "Start" control for stopped agents (`FleetTable.tsx`).

### R11 — [MAJOR] Pervasive undefined jargon; no tooltips/onboarding
**Screens:** global (`office`, `steer`, `loop`, `session`, `trace`, `MCP`, `headless`, `^C`)
**Flagged by:** customer (primary).

**Fix:**
- Add hover tooltips for every domain term and a first-run concept primer: "An agent does work in a
  folder. A task goes in its TODO.md. A session is one run. An office is an optional shared server."
- Replace insider words in user-facing copy: `steer` → "message/nudge", `operate` → "control", `^C` →
  "Ctrl+C". Reword the offline banner in `ChatTab.tsx`: "Agent is offline — your message will be
  queued and delivered when it reconnects." Add per-chip tooltips to the slash-command chips
  (`/switch grok→claude` → "change which AI model this agent uses").

### R12 — [MINOR] CommandBar on the wrong screen
**Screens:** 04-fleet (has ⌘K), 01/09-agents (missing it)
**Flagged by:** consistency.

Per spec the 210px ⌘K CommandBar belongs in the **Agents** TopNav right cluster (before RunPill);
Fleet's right cluster is RunPill + Settings only. It's currently inverted.

**Fix:** move the CommandBar render from the Fleet TopNav to the Agents TopNav (`views/AgentsView.tsx`
vs `views/FleetView.tsx`, or the shared `ui/AppShell.tsx` TopNav slot).

### R13 — [MINOR] Raw hash ids leak into task titles; unbalanced Fleet stat tiles; duplicate throughput number
**Screens:** 04-fleet
**Flagged by:** drunk-designer.

**Fix:**
- `components/fleet/fleet-helpers.ts` / `FleetTable.tsx` CURRENT TASK cell: strip the leading
  `[7ef6ecb4…]` hash to a dim gutter/tooltip; show only human task text. Style "no active task"
  consistently dimmer.
- `components/fleet/StatTiles.tsx`: when NEEDS YOU is empty, collapse it to a slim reassurance strip so
  THROUGHPUT/PROVIDERS get equal width instead of half the viewport reserved for "nothing".
- Scale the throughput sparkline to real data; remove the duplicate `6113` (header subtitle already
  says "6113 closed today"). Add units to PROVIDERS tiles ("Grok · 29 agents").

### R14 — [MINOR/NIT] Context menu: id header + anchoring
**Screens:** 13-context-menu
**Flagged by:** consistency + drunk-designer + customer.

**Fix (`ui/ContextMenu.tsx`):** show the agent id mono (`director · grok-019fcc0e`) in `--tx-ghost` in
the menu header as the disambiguator. Offset the menu below/left of the `···` trigger so the trigger
stays visible and it doesn't cover the inspector. Reword items in product voice ("Stop loop" → "Stop
this agent", "Setup…" → "Agent settings…", "Connect to office…" → "Add to a Pixel Office…"); demote
developer file actions (Open in editor / terminal / folder / Copy path) beneath agent-control actions.

---

## §2 — Global / systemic fixes

1. **Subfolder-grouping source of truth (R1).** One derivation — enumerate immediate subfolders of the
   offices root — feeds the Agents rail groups, the Fleet OFFICE column, and the Fleet office count.
   Never render a single "OFFICE" bucket. Add real "Group by" partitions (Office folder / Role /
   Provider / State).

2. **Zero-suppression rule (R6).** A metadata field that is zero/empty across all rows is hidden, not
   repeated. Apply to task counts, `0kb`, `0 msgs`, ELAPSED, `—` columns. Empty stat tiles collapse.
   Centralize the predicate in `services/model.ts` so rail, fleet, sessions, and inspector agree.

3. **One EmptyState primitive (R3).** `ui/EmptyState.tsx` (icon + heading + subline + optional CTA)
   used on every empty surface; every empty state offers the next action, not a restatement of
   emptiness.

4. **One AuthCard primitive (R8).** `ui/AuthCard.tsx` shared by Office + Make-app; one casing, no emoji
   chrome, one button state machine, shared error styling + focus ring.

5. **Status-color discipline (R7).** Green = running only, count-driven everywhere. Amber `--st-needsyou`
   = needs-you only. Separate "office connected" from "running" visually. Codify in `ui/StatusDot.tsx` /
   `ui/Pill.tsx` so a count of 0 can never render green.

6. **Provider display standardization (R2).** One canonical label form + a mono runner sub-line, one
   helper in `services/model.ts` consumed by rail, fleet, settings, chat.

7. **Contrast + focus audit (R9).** Lift lower text tiers that carry information to ≥4.5:1; add a
   visible `--accent` focus ring to all interactive controls. The token scale already exists in
   `ui/theme.css` (`--tx-hi` … `--tx-ghost`) — the issue is deployment, not the palette.

8. **Strip build-stage artifacts (R4).** No "Stage N" / "not wired yet" copy, no `—` version
   placeholders, no raw CLI names in the primary view, no raw hash ids in task titles in release
   builds.

9. **First-run + jargon layer (R10, R11).** Clean first-run state, one golden path, a concept primer,
   and consistent tooltips/plain-language copy for domain terms.

10. **Spacing/density.** Fill or intentionally frame empty canvas: auto-select first item to populate
    detail panes; constrain floating cards (Office/Make-app) with a subtle backdrop so emptiness reads
    as deliberate, not unfinished.

---

## §3 — Quick wins vs larger changes

### Quick wins (localized, low-risk — mostly copy, tokens, conditionals)
- **R4** remove "Stage 3" copy + bind versions (`SettingsView2.tsx`).
- **R7** count-driven green dot (`AgentRail.tsx` RunPill, `FleetHeader.tsx`, `GroupHeader`).
- **R6** suppress `0kb` / `0` counts / `0 msgs` and disable "Watch live" on empty session
  (`SessionRow.tsx`, `AgentRow.tsx`, `Inspector.tsx`, `FleetTable.tsx`).
- **R5** `(untitled)` fallback to first prompt (`SessionRow.tsx` L30, `TranscriptPane.tsx` L75).
- **R11** reword offline banner + slash-chip tooltips (`ChatTab.tsx`); `^C` → "Ctrl+C" (`TerminalTab.tsx`).
- **R13** strip hash from CURRENT TASK cell + dedupe throughput number + add tile units (`fleet/`).
- **R12** move CommandBar Fleet→Agents (TopNav slot).
- **R14** context-menu id header, trigger offset, product-voice labels (`ui/ContextMenu.tsx`).
- **R6/11** Sessions auto-select top session on load (`SessionsView.tsx`).

### Larger changes (new components / data wiring / structural)
- **R1** subfolder grouping wired to the filesystem + Fleet OFFICE column/count + real Group-by
  options (`AgentRail.tsx`, `FleetTable.tsx`, `FleetHeader.tsx`, `services/model.ts`). *Highest impact —
  do first.*
- **R3** `ui/EmptyState.tsx` + retrofit Activity/Chat/Terminal/Sessions + **live tmux/session
  streaming** when WORKING (`TerminalTab.tsx`, `ActivityStream.tsx`).
- **R5** `FoldGroupRow` for duplicate session runs (`components/sessions/`).
- **R8** `ui/AuthCard.tsx` + first-run auth flow (create account / skip / conditional session-expired)
  across `OfficeView.tsx`, `MakeAppView.tsx`.
- **R10** clean first-run state + guided golden path + "Example — safe to delete" labeling.
- **R11** first-run onboarding tour + app-wide tooltip layer.
- **R9** contrast/focus audit sweep across every screen (mechanical but broad).

**Suggested sequence:** R1 → R6 + R7 (make the populated screens read correctly) → R3 (empty states +
live streams) → R4 + R5 + R8 (strip scaffolding, fix the two duplicate-wall/auth problems) → R10 + R11
(onboarding) → R9 polish sweep.
