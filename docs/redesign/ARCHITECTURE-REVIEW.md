# AutoDev App — Redesign v2 Architecture Review

**Branch:** `redesign/v2`
**Scope:** `src/renderer/src` (React renderer) and its seam to `src/preload` / `src/main`
**Method:** Synthesis of four independent architecture critiques (component-structure, state & data-flow, IPC & data-layer, cross-cutting), each claim spot-verified against the source.

---

## 1. Assessment

### What is solid

The redesign has a genuinely good **foundation** and several correctly-reasoned hard parts:

- **Token-only design system.** `ui/theme.css` is the single source for every color/spacing/radius var, loaded exactly once via the `ui/index.ts` barrel. Primitives (Button, Modal, AppShell, ContextMenu, …) consume only CSS custom properties — `grep` finds no hardcoded hex in `ui/`. This is the right base for a light theme and stateful CSS later.
- **Keep-alive PTY discipline.** The most safety-critical invariant in the app — *never unmount a live PTY* (unmount = SIGKILL + lost scrollback) — is carefully engineered and documented at every seam (`App.tsx:36-42`, `OfficeView` auth-expiry/empty-poll guards, slug-bucketed terms, generation-suffixed term ids). Toggling CSS `display` instead of conditional-render is the correct mechanism and is applied uniformly.
- **Push-then-reconcile data shape.** `onAgentUpdated` patches a single agent in place with a 5s poll as a correctness backstop, rather than re-fetching the whole fleet per event. Log streaming pushes lines into a ref + listener `Set` so only the visible `ActivityStream` re-renders — composer/search keystrokes are never dropped.
- **Careful race handling.** In-flight guards, the monotonic `openSeqRef` open-token in Sessions (discards a slow response when selection changes), optimistic steer echo, and empty-poll resilience (keep last-known list while PTYs are live) are all the hard parts done right.
- **Clean pure-logic separation and honest gaps.** `fleet-helpers.ts`, `office/officeTypes.ts`, `sessions/types.ts` hold derivation with no React/`window.api`. IPC is wired to the real preload surface with greppable `// TODO(redesign)` markers wherever the design outruns the backend — the mock/real gap is explicit, not hidden.

### The biggest structural risk

**There is no data-access layer and no shared source of truth.** The single canonical `AgentState[]` is fetched, merged, and polled *three independent times* — `App.tsx:116-136`, `AgentsView.tsx:43-78`, `FleetView.tsx:100-133` — each with its own array, its own `onAgentsChanged`/`onAgentUpdated` subscription pair, its own 5s `setInterval`, and its own **divergent** patch/merge logic (Agents appends unknown paths; Fleet also runs `trackElapsed`; App only counts). Because keep-alive keeps every visited view permanently mounted, **all three loops run concurrently for the rest of the session regardless of the foreground tab.** This is the root of a cluster of downstream problems: 2–3× IPC/CPU, a nav-pill/rail/table that can visibly disagree, and a pattern every new agent-consuming view must re-implement. App's own comment calls its poll *"worthless whenever a self-counting screen is foremost."*

Two things amplify this risk into a shipping concern:

1. **No error boundary anywhere** (`main.tsx` renders `<App/>` bare in StrictMode; zero `componentDidCatch`/`getDerivedStateFromError` in the tree). Because keep-alive keeps *every* view mounted, a single render throw in *one* view — e.g. `FleetView` `a.name.localeCompare` or `OfficeView` grouping on `a.officeSlug`, both one malformed `AgentState` away — white-screens the whole app and **SIGKILLs every live PTY across all views at once**, destroying exactly what the keep-alive machinery works so hard to protect.
2. **Cross-view control flow rides an untyped `window` CustomEvent bus** (`redesign:nav`, `redesign:new-agent`, `autodev:open-agent`, `office:stop-all`, `redesign:toast`). Navigation and open-agent are parent→child routing masquerading as global broadcast; `office:stop-all` is a fire-and-forget lifecycle command that works *only because* keep-alive guarantees `OfficeView` stays mounted (documented as fragile in `App.tsx:49-52`). No compile-time contract; a renamed event silently no-ops.

Everything else (dual-shell nav, duplicated composers/inputs/menus, inline-style-only skins with no `:focus-visible`, dead legacy files, no renderer tests) is real and worth fixing, but flows from the same two absences: **no shared store, and no typed cross-cutting layer.** The four lenses converge on the same short list.

---

## 2. Proposed Target Architecture

The target keeps every strength above (keep-alive, push-then-reconcile, token system, pure helpers) and removes the duplication by introducing **one owner per domain** and **one typed cross-cutting layer**.

### 2.1 Single nav / shell model

App owns exactly one `<AppShell>`; every view is pure content passed as `children`.

```
main.tsx
 └─ <RootErrorBoundary>              // last-resort full-app fallback
     └─ <AppProviders>              // ApiContext · AppActionsContext · stores
         └─ <App>                   // owns the ONE <AppShell> + nav state
             └─ <AppShell activeNav onNavChange search counts>
                 └─ <ViewSwitch>    // keep-alive display:none layers
                     ├─ <ViewErrorBoundary key=nav-agents>  <AgentsView/>
                     ├─ <ViewErrorBoundary key=nav-fleet>   <FleetView/>
                     ├─ <ViewErrorBoundary key=nav-office>  <OfficeView/>
                     ├─ <ViewErrorBoundary key=nav-sessions><SessionsView/>
                     ├─ <ViewErrorBoundary key=nav-makeapp> <MakeAppView/>
                     └─ <ViewErrorBoundary key=nav-settings><SettingsView2/>
```

Concretely:
- **Delete** the dual-shell split: `AgentsView`/`FleetView` stop rendering their own `<AppShell>` and keep only their in-content rail/table.
- **Delete** `nav.ts`'s `navTo` + the `redesign:nav` CustomEvent and `AppShell`'s hardcoded `DEFAULT_NAV` (`AppShell.tsx:21`). Nav becomes plain React state in `App`, passed down as `activeNav` + `onNavChange`; `MAIN_NAV`/`SETTINGS_NAV` in `nav.ts` remain the single item list.
- Lift `search` value and fleet counts to `App` (they come from the store, §2.3) so the one shell renders the RunPill from the same numbers the rail/table use.

### 2.2 Component tree below the view layer

Keep the existing mid-level decomposition (it's already shallow and legible): `AgentRail/AgentRow/AgentDetail/Inspector`, `FleetHeader/StatTiles/FleetTable/FleetStatusBar`, office cards, `SessionRow/TranscriptPane`. Split the 4 god-views (`OfficeView` 781, `SettingsView2` 865, `FleetView` 619, `SessionsView` 446) into **data hook + presentational view**, so each view is mostly JSX over hook outputs:

- `OfficeView` → `useOfficeAgents()` + `useKeepAliveTerms()`; extract the login form to `components/office/OfficeLogin.tsx`, keep `TermSteer`/`NewCharacterTile` as siblings.
- `SessionsView` → `useSessions()`.
- `FleetView` → `useFleet()` (§2.3).
- Row bodies (`FleetRow`, `AgentRow`) become `React.memo`'d with stable per-row callbacks (pass `path` + one handler, not a fresh closure per row).

### 2.3 State architecture — one owner per domain

Model each domain as a **renderer-side external store bridged with `useSyncExternalStore`**. This is the idiomatic bridge because the underlying data is *pushed by IPC events*, not driven by React actions; it also lets hidden keep-alive views subscribe cheaply without re-running machinery. Prefer this over Context+reducer for the high-churn agent/log streams. (A `FleetProvider` + Context is an acceptable alternative for `useFleet` if the team prefers it, but the store keeps hidden-view subscriptions cheapest.)

| Store | Owns (single instance) | Selector hooks |
|---|---|---|
| **agentStore** | one `listAgents()` seed · one `onAgentsChanged`+`onAgentUpdated` subscription · one 5s fallback poll · the merge | `useAgents()`, `useAgent(path)`, `useFleetCounts()` → `{ running, needsYou, attention }`, plus actions `start/stop/restart` |
| **logStore** | one `onAgentLog` subscription · one `Map` keyed by path · shared tail-slice + prune-against-live-set | `useAgentLog(path)`, `subscribeLog(path)` |
| **officeStore** | one connection + one poll per resource (status/agents/messages) | `useOffice()`, `useOfficeAgents()`, `useOfficeMessages(ref)` — extends the existing `composables/useOfficeSelection.ts` |
| **sessionsStore** | one `sessionsDiscover()` seed + poll, indexed by cwd | `useSessions()` (grouped list) and `useSessionsForCwd(path)` for the Inspector card |
| **termRegistry** | the open-PTY registry (today trapped in `OfficeView` local state) | `useTerms(slug)` for rendering; `stopAll()` / `operate()` / `close()` as addressable commands |

Results: 3 agent polls → 1, 3 merges → 1, 3 arrays → 1; the Inspector's per-selection full-fleet session scan (`Inspector.tsx:226`) collapses into the shared sessions pipeline; `restart()` (stop → 400ms → start) lives once in the store instead of twice; and `stopAll()` becomes a real command against `termRegistry` rather than a DOM broadcast that depends on `OfficeView` staying mounted.

**Keep colocated** (do *not* hoist): per-view selection state — Agents' `selected` path, Fleet's `Set<string>`, Office's `selectedSlug`+`focusedId`. These are genuinely local; centralizing them would be over-engineering.

### 2.4 IPC data-layer

Two structural pieces plus a hook stack:

1. **Typed IPC contract — `src/shared/ipc.ts`.** Today 49 of 54 preload methods infer `Promise<any>`, so every view re-declares the response shape inline with `as {...}` casts (`officeStatus`, `officeMessages` typed differently in `ChatTab` vs `OfficeView`, etc.). Define request/response types once and import them into **both** the main handlers (to type their returns) and the preload signatures (to type each `Promise`). Delete the ~30 inline casts; a handler shape change now fails at compile time in the renderer instead of lying at runtime.
2. **`ApiContext` + `useApi()`.** Wrap `window.api` so components take IPC by injection — mockable in tests, and it kills the `FleetView.tsx:32` `(window as any).api` shim so the whole app reaches IPC one typed way.
3. **Generic request/subscription hooks** that domain hooks build on, so alive-guarding, error capture, and unsubscribe are uniform and unforgettable:
   - `useIpc(fn, deps) → { data, loading, error, reload }` — built-in alive-guard + try/catch + a uniform loading/error/retry concept (today: `AgentsView.refresh` has *no* guard and *no* try/catch → unhandled rejection + setState-after-unmount race; try/catch counts range 1→12 across views).
   - `useSubscription(subscribeFn, handler)` — wraps the preload `sub()` helper so a subscription can never be registered without its teardown.
   - Standardize a **visibility-gated poll** everywhere polling remains (only `SessionsView` gates today; the two heaviest pollers don't) — or, better, let the stores in §2.3 own the single poll so hidden views just subscribe.

### 2.5 Cross-cutting: typed actions, not a window bus

Replace the untyped CustomEvent bus with a small **typed `AppActionsContext`**:

```ts
interface AppActions {
  navigate(id: NavId): void
  openAgent(sel: { officeSlug: string; agentSlug: string }): void
  toast(msg: string, err?: boolean): void
  stopAll(): void            // → termRegistry command, not a DOM event
}
```

Routing and open-agent become explicit parent-provided callbacks (they were never really "broadcasts"). Keep an event channel *only* for something genuinely decoupled, and if so, type it via one declared `{ channel: payload }` event map rather than ad-hoc strings. This removes `redesign:nav`, `redesign:new-agent`, `autodev:open-agent`, `office:stop-all`, and the `nav.ts → window → App` import-cycle round-trip.

### 2.6 Error-boundary + resilience conventions

- `ui/ErrorBoundary` primitive: wrap `<App/>` at top level (last-resort fallback) **and** each per-view layer div in its own boundary so one screen's crash shows a localized *"This screen hit an error — Reload"* card while **sibling views keep their PTYs alive**. Reset the boundary on `key={nav}` change so a fixed view recovers.

### 2.7 Theming + a11y conventions

- **Stateful skins in CSS, not inline objects.** Inline `style` can't express `:hover`/`:focus-visible`/`:active`/`:disabled`, so today the app has *no* focus ring anywhere, Button's declared `transition` can never fire, and a disabled Button keeps `cursor:pointer`. Move `Button`/`NavItem`/`IconButton`/`ContextMenu-item`/`Modal-close` skins into CSS classes keyed off the existing theme vars (keep layout inline). Add one global `:focus-visible` ring + a `prefers-reduced-motion: reduce` guard (unstoppable pulse/blink is a WCAG 2.3.3 concern). This is also the **prerequisite for `:root[data-theme=light]`** light mode (mirrors the pixel-office token approach already documented in memory).
- **Focus management.** A shared `useFocusTrap` + roving-tabindex hook consumed by both `Modal` (currently no trap/initial-focus/restore — Tab walks out behind the dialog) and `ContextMenu` (currently mouse-only, no Arrow/Escape/trap) — the primary destructive-action surfaces (Remove agent, Stop loop, Switch provider) must be keyboard-operable.

### 2.8 Shared model + missing primitives (drift removal)

- **One agent model module** (`components/agent/model.ts` or `src/renderer/src/types/agent.ts`) owning `AgentState` + the `Activity` vocabulary + `ACTIVITY_LABEL`/`ATTENTION_STATES`/`STATE_LABEL`. Today it's copied verbatim in `AgentRow.tsx` and `fleet-helpers.ts` (whose header comment admits manual sync) with a third slim copy in `AgentConfigModal`. Imported everywhere instead.
- **`ui/` gains form + composite primitives:** `TextInput`, `TextArea`, `Select`, `FormField(label+control+error)` (retire 8+ inline-styled inputs); `EmptyState` (~8 hand-rolled copies); `Composer variant='steer'|'task'` (4–5 duplicated composers across `AgentStream`/`OfficeRoom`/`TermSteer`/`AgentDetail`/`TranscriptPane`); `Avatar initials` and a shared `MessageRow`/`Bubble` (office bubble duplicated between `AgentStream` and `OfficeRoom`).
- **`ContextMenu` self-positions from an `anchor={{x,y}}` prop** (self-clamps to viewport) instead of every caller owning the clamp geometry (repeated in `AgentsView`/`FleetView`/`AgentRail`); a single `agentMenuItems(agent, onAction)` factory replaces the twin 12-item menu definitions in `AgentsView` and `AgentRail`.
- **`useLogBuffer(path)`** + a `<KeepAliveLayer active>` wrapper centralize the two conventions currently open-coded across four views each.

### 2.9 Testing seam

`useApi()` injection + the extracted pure derivations make the intricate code testable. Add vitest + React Testing Library + jsdom and cover the highest-risk branches first: `OfficeView` term-bucketing and auth-expiry guards, `FleetView` sorted/filtered/elapsed — extending the existing `fleet-helpers.ts` "pure functions, unit-tested" pattern.

---

## 3. Prioritized Roadmap

Deduplicated across the four lenses and sequenced so early steps unblock later ones. **Phase A (do before shipping)** is correctness/risk — a crash today takes down every PTY, and three divergent fleet copies can visibly disagree. **Phase B** is the incremental refactor that pays down the duplication.

### Phase A — Before shipping (correctness / risk)

| # | Step | Effort | Impact | Rationale |
|---|---|---|---|---|
| A1 | **ErrorBoundary: top-level + per-view.** Add `ui/ErrorBoundary`; wrap `<App/>` and each keep-alive layer, reset on `key={nav}`. | M | High | Highest-leverage resilience gap: one render throw currently white-screens the app and SIGKILLs every live PTY. Per-view boundaries isolate the blast radius the keep-alive design exists to protect. No dependencies — do first. |
| A2 | **Single agent store** (`useSyncExternalStore`): one seed + one subscription + one poll + one merge; expose `useAgents`/`useAgent`/`useFleetCounts` + `start/stop/restart`. App, AgentsView, FleetView consume it. | M | High | Removes the biggest structural liability: 3 polls→1, 3 arrays→1, 3 divergent merges→1, and the nav-pill/rail/table divergence class. Unblocks the single-shell nav (counts come from here) and the god-view splits. |
| A3 | **Delete dead legacy files** (`App.legacy.tsx`, `PixelOfficeView`, `SessionsBrowser`, `SettingsView`) + the `CONNECT_LABEL` re-export, or move to `archive/` excluded from tsconfig. | S | Med | The redesign's `TODO(redesign)` stubs invite copy-from-dead-source; removing them prevents drift and cuts grep noise. Sequence after the styles.css consumers are handled (A4) since some legacy views use legacy classes. |
| A4 | **Resolve the global CSS leak:** fold the base reset (`box-sizing`, html/body height) into `theme.css`, migrate the ~handful of classes the 4 remaining consumers (`MakeAppView`/`TerminalTabs`/`TerminalPane`/`OfficeSelector`) need into a scoped module, delete the duplicate legacy `:root` palette, drop the global `styles.css` import. | M | Med | Two competing palettes + a reset the redesign didn't choose is a per-view visual-consistency tax; un-migrated views look like a different app. Prerequisite for A3's clean delete and for light mode. |
| A5 | **Global `:focus-visible` ring + `prefers-reduced-motion` guard.** | S | Med | Keyboard focus is invisible app-wide (accessibility failure) and pulse/blink runs unconditionally (WCAG 2.3.3). Small, standalone, ships independently of the larger CSS-skin move (B7). |

### Phase B — Incremental refactors

| # | Step | Effort | Impact | Rationale |
|---|---|---|---|---|
| B1 | **Single-shell nav:** App owns one `<AppShell>`; delete `navTo`/`redesign:nav`/`DEFAULT_NAV`; pass `activeNav`+`onNavChange`+`search`+counts by prop/context. | L | High | Collapses the three-way nav source-of-truth and the circular event routing. Depends on A2 (counts source) and B2 (typed actions). AgentsView/FleetView drop their embedded shell. |
| B2 | **Typed `AppActionsContext`** (`navigate`/`openAgent`/`toast`/`stopAll`) replacing the window CustomEvent bus; remove the `nav.ts→window→App` round-trip. | M | High | Gives cross-view control flow a compile-time contract; makes routing explicit callbacks. Unblocks B1 and B3. `stopAll` lands as a real command once B4 exists. |
| B3 | **One shared agent model module** (`AgentState` + activity vocabulary + label maps); import in AgentRow, fleet-helpers, modals, App. | S | Med | Kills the verbatim triple-copy + the "kept in sync by hand" hazard. Cheap, unblocks nothing but de-risks every later model change. Can run in parallel with A2. |
| B4 | **Move the PTY/term registry** out of `OfficeView` local state into a store / main-process registry; `stopAll`/`operate`/`close` become addressable commands. | M | Med | Decouples lifecycle commands from `OfficeView`'s mount status (today `office:stop-all` works only by coincidence of keep-alive). Feeds B2's `stopAll`. |
| B5 | **Typed IPC contract** (`src/shared/ipc.ts`) + **`ApiContext`/`useApi()`**; delete `Promise<any>` and the inline `as {...}` casts and the `(window as any).api` shim. | M | Med | Compile-time safety at the renderer↔main seam + the injection point that makes the renderer testable. Prerequisite for B6 and B9. |
| B6 | **Generic `useIpc` + `useSubscription`**, then domain hooks: `useFleet`, `useAgentLog`/`useLogBuffer`, `useOffice`/`useOfficeAgents`/`useOfficeMessages`, `useSessions`/`useSessionsForCwd`. Split the 4 god-views into hook + presentational view; extract `OfficeLogin`. | L | High | Uniform alive-guard/error/unsubscribe; dedupes the log buffer (2 copies), the office inline reimplementation + overlapping 4s/5s/8s timers, and the Inspector's per-selection full-fleet session scan. Shrinks 600–800-line views. Builds on A2/B4/B5. |
| B7 | **Stateful skins → CSS classes** for Button/NavItem/IconButton/ContextMenu/Modal (keyed off theme vars, layout stays inline). | M | Med | Enables `:hover`/`:active`/`:disabled` the design implies, and is the prerequisite for `:root[data-theme=light]`. Depends on A5 (ring) being in place. |
| B8 | **`useFocusTrap` + roving-tabindex** in Modal and ContextMenu (trap/initial-focus/restore/Arrow/Escape). | M | Med | Destructive-action surfaces become keyboard/screen-reader operable; pairs with A5/B7. |
| B9 | **UI primitives + memoized rows:** `TextInput`/`TextArea`/`Select`/`FormField`, `EmptyState`, `Composer`, `Avatar`, `MessageRow`; `ContextMenu anchor` self-clamp + `agentMenuItems` factory; `React.memo`'d `FleetRow`/`AgentRow` with stable callbacks. | M | Med | Retires the 8+ inline inputs / 4–5 composers / ~8 empty-states / twin context menus, and stops O(fleet-size) re-render on every agent tick. Best after B5/B6 so primitives compose the new hooks/injected api. |
| B10 | **`:root[data-theme=light]` light mode** mirroring pixel-office tokens; **renderer tests** (vitest + RTL + jsdom) on term-bucketing, auth-expiry, fleet derivations. | M | Med | Light mode is unblocked once B7 lands; tests are unblocked once B5's `useApi` injection exists. Both are follow-through, not blockers. |

**Critical path:** A1 → A2 → (A3/A4/A5 parallel) → B2 → B1, with B5 → B6 as the second spine and B3/B4 feeding in. Everything in Phase B is safely incremental once Phase A removes the crash-takes-down-all-PTYs risk and the three-copy divergence.
