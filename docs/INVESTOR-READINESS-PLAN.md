# AutoDev / Pixel Office — Investor-Readiness Master Plan

_Synthesis of 16 multi-lens audits (drunk-designer, ux-designer, novice-customer, accessibility, performance, security, devops, tech-writer, product-narrative) across every surface: the AutoDev Electron app, the Pixel Office web app + mobile, the Deployer, the Famous Fighters demo game, the pixeloffice.org marketing site, and the CLI/demo flow._

**Status:** overnight backlog + show-and-tell doc. Every item is written as an actionable checkbox: `- [ ] [SEV] title — impact — fix (effort)`.
Severity: **[BLOCKER]** demo-killer, **[MAJOR]** erodes trust, **[MINOR]** polish, **[NIT]** cosmetic.

---

## 1. Executive Summary

**The pitch.** AutoDev turns one command into a *visible* team of autonomous AI agents that live in a pixel office, take real tasks, and ship real software — proven by Famous Fighters, a complete, playable fighting game the office built and hosts live. You watch them work, steer them mid-turn, and deploy them 24/7 onto your own machines or ours. The whole stack is open. It is observability + control + coordination for fleets of agents, wrapped in a product people actually enjoy looking at.

**The core problem the audits agree on.** The product is genuinely capable, but in almost every *default* state an investor first sees, it either **looks empty** (dead office, idle agent, "0 running", empty panels) or **contradicts itself** (an agent shown as WORKING and "offline" at once; "connected" and "not connected" on one screen; a Settings page that confesses it isn't wired; a marketing site whose numbers and links don't hold up). The magic — agents alive and working — is exactly what is missing from the first 3 seconds, while developer scaffolding (temp file paths, hook telemetry, CLI version strings, SCREAMING_SNAKE task codes, terminal-only onboarding) is exactly what leaks to the front. The fix is not new capability; it is **coherence, live seed data, and hiding the console.**

### Top 10 must-fix before investors (ranked)

1. **[BLOCKER] The flagship office is a ghost town.** The #1 marketing CTA ("Enter the hosted office") and the Electron landing both open onto empty/idle states — "0 agents · 0 active", "Nothing here yet", "Agent is idle". The product refutes its own headline in the first 3 seconds. → Stand up and babysit ONE live demo office (3–5 agents genuinely looping/messaging), seat greyed sprites for offline agents so no room is ever empty, and point every hero CTA at that specific office.
2. **[BLOCKER] "Session expired" bleeds red/amber across the whole Electron app.** Header, SETUP rail, Chat body, Office, and Make-app all shout expired-session errors simultaneously — reads as a permanent error state. → Silently refresh the office token on focus/launch; when it does lapse, demote to ONE quiet neutral "Reconnect" link; keep the last transcript visible read-only.
3. **[BLOCKER] Contradictory connection/status truth on one screen.** The same agent shows "WORKING" + green "office connected" + "Office: connected" while Chat says "Not connected to a pixel-office" and the composer says "Agent is offline." → One source of truth bound to all surfaces; label distinct connections distinctly ("Agent: working" vs "Team chat: reconnecting"); never render "connected" and "offline" for one entity.
4. **[BLOCKER] Settings confesses it's a prototype: "These defaults are not saved yet … Wiring is Stage 3."** The single most damaging string in the demo — reframes every polished screen as a mockup. → Delete the disclaimer; hide unwired controls; open Settings on the Providers pane that genuinely works.
5. **[BLOCKER] "Open source — read every line" but 3 of 4 GitHub links 404** (incl. the flagship pixel-office repo and the "Star on GitHub" button). Turns the strongest trust asset into the thing that breaks trust. → Make the repos public at the linked URLs (or remove the cards + "4 repos" stat) before the demo; re-test every link.
6. **[BLOCKER] Deployer agent containers/pods have NO resource limits.** One runaway agent (documented opencode spin / 660 MB session explosion) can OOM/CPU-starve the shared host and kill every agent mid-pitch. → Add `--memory`/`--cpus`/`--pids-limit`/`--restart` to docker run and `resources` to the K8s spec; cap concurrent agents per host.
7. **[BLOCKER] The hero command `autodev office` isn't one command and isn't in the README.** It needs a pre-minted PAT, flags, a pre-built office, per-agent creds, and every provider CLI authed — and `grep` finds zero README hits. → Add `autodev login` that mints/stores the PAT, make bare `autodev office` list+prompt, add a green/red preflight checklist, document it as the headline quickstart.
8. **[BLOCKER] Deployer's Filament admin is an unthemed stock template** (white light-mode, amber default palette, Filament promo widget, generic favicon) opening straight out of a dark premium landing page — reads as two different companies. → Register a real dark Filament theme with brand tokens/font/logo/favicon, set primary to the brand violet, remove the framework promo widgets.
9. **[BLOCKER] Famous Fighters looks like a debug build:** the dense keyboard+gamepad control-legend is stamped on *every* screen and the landing has 6 equal same-weight CTAs with no "start here." → Remove the legend from gameplay screens (one quiet "Controls" affordance), elevate one hero CTA, strip engineering codenames (`WAVE_F2`, `GGPO`, `InputFrame`).
10. **[MAJOR, cross-cutting] Security optics on two credential-custody products.** Both Pixel Office and the Deployer ship **zero HTTP security headers** (F on securityheaders.com), the highest-privilege **agent `agt_` key is stored in plaintext** while PATs are hashed, and the Deployer returns a **raw 500 HTML page** on an unauthenticated API hit. A 10-second header scan during DD is an instant, avoidable trust ding. → Add a SecurityHeaders middleware to both, hash the agent key like PATs, force JSON 401s for `/api/*`.

**Runner-up must-fixes:** the Electron app's hero number (6,408 tasks/day) buried as 9px grey subtext; the "0 running" green-dot-with-zero contradiction; Fleet as a monochrome STOPPED graveyard; the mobile office canvas letterboxed over a black void; WCAG contrast failures on all secondary text; no "watch it build from zero" proof beat in the demo; no business-model / contact path on the marketing site.

---

## 2. Per-App Backlogs (de-duplicated, prioritized)

### 2.1 AutoDev Electron App (redesign v2)

_Merges: drunk-designer, ux-designer, novice-customer, accessibility, and performance lenses. Duplicate findings (session-expired, connection contradiction, Settings disclaimer, double titlebar, empty states, version footer, 6408 stat) collapsed into single entries._

#### Design / UX / visual hierarchy
- [ ] [BLOCKER] Session-expired errors colonize every screen at once — reads as a permanent error state; the fastest possible trust loss in a live demo. → Auto-refresh token on focus/launch; on lapse show ONE muted neutral "Reconnect" link (never red/amber, never in the SETUP key/value rail + Chat + header simultaneously); Chat keeps last transcript read-only. (M)
- [ ] [BLOCKER] Same agent shown WORKING/connected AND "not connected / offline" simultaneously (header + rail + SETUP + Chat pane + composer disagree). → Single source of truth bound to all surfaces; distinct labels for agent-loop vs team-chat connection; a connected office must render the room, not an error. (M)
- [ ] [BLOCKER] Settings ships the disclaimer "These defaults are not saved yet — Wiring is Stage 3." (and a "COMING SOON" pill + "Preview only — not yet editable" banner). → Delete the internal roadmap text; wire the simple provider/timeout/toggle fields to persist OR hide the unwired pane and open Settings on Providers. (S)
- [ ] [MAJOR] The star of the show sits idle center-stage — default view is a dead grey "Agent is idle" panel; all three tabs default to nothing. → Auto-select a live/most-active agent on launch so center stage streams real work; make the idle state aspirational (pulsing "ready", faded last-activity preview) not a dead glyph. (M)
- [x] [MAJOR] "0 running" with a green dot contradicts itself in the persistent top-right chrome. → Grey dot + "idle" wording at 0; green + subtle pulse + "N agents working" when >0; consider surfacing the cumulative hero number here. (S)
- [x] [MAJOR] The jaw-dropping stat "6,408 tasks closed today" is buried as 9px grey run-on subtext under an unlabeled sparkline, while "Nothing needs you right now" gets a hero card. → Promote to a genuine hero stat (big numeral, high contrast, thousands separator, "vs yesterday" delta); shrink/kill the empty-inbox tile. `FleetHeader.tsx` / `StatTiles.tsx`. (S)
- [ ] [MAJOR] Fleet — the flagship overview — reads as a monochrome graveyard (all rows grey STOPPED, OFFICE column all em-dashes, one provider, "Nothing needs you"). → Demo with agents actually running: colored state dots (green WORKING / amber ASKED / red TIMED OUT), populated CURRENT TASK, ≥1 NEEDS-YOU alert; hide the OFFICE column when offices=0; seed a 2nd provider. (M)
- [ ] [MAJOR] Empty states are 700px voids, not guidance (Activity "No activity yet", blank Terminal even while WORKING, Chat error in emptiness). → Each empty state gets icon + one-line headline + one weighted primary CTA; a WORKING agent's Activity/Terminal MUST stream real content. (M)
- [ ] [MAJOR] Palette is one VS-Code blue on near-black — competent but forgettable and indistinguishable in greyscale. → Earn a second ownable signature accent reserved for the "agent alive/working" state and throughput visuals, distinct from the utility/clickable blue. (M)
- [ ] [MAJOR] Labels rendered as monospace debug output / internal tokens ("Provider grok", "Model provider default", "Files browser off", "MCP 6 servers"). → Reserve mono for code/paths; humanize to plain language ("Model: default", "File access: off", "Tools (MCP): 6 connected"); establish 3 clear type levels for the agent header. `Inspector.tsx` / `AgentDetail.tsx`. (M)
- [ ] [MAJOR] "Make app" — the headline magic — is gated behind a bare login form identical to the Office connect screen, with zero preview of the wow. → Lead with the describe-your-app input, preview the agent team animating in, defer sign-in to the moment of commitment; at minimum differentiate hard from the Office card. (L)
- [ ] [MAJOR] Hero counters contradict the inspector ("724/725 done" + filled progress bar next to "No tasks in TODO.md" + "0 msgs · 0kb"). → Header count and TODO panel read from the same list; relabel lifetime totals out of the live header; never fill a progress bar against an empty list. (M)
- [ ] [MINOR] Unlabeled numeric badges on every agent row (1, 0, 202) — can't tell if unread/tasks/errors; contradicts "0 msgs". → Give the badge one clear meaning + tooltip; reconcile with Session/Activity counts. (S)
- [ ] [MINOR] Slash-command chips (/task /pause /context /switch) float orphaned in a void above the composer. → Dock them to the composer as one input assembly, or reveal on "/" focus. (S)
- [ ] [MINOR] TODO.MD shows a blue progress bar over "No tasks in TODO.md". → Hide the bar in the empty state; show "No tasks yet — add one below". (S)
- [ ] [MINOR] Redundant CTAs — "Take over" appears 3× in the Terminal pane (header + center button + input placeholder). → One primary "Take over" per pane; reframe to outcome not mechanism ("Type commands — your agent keeps working, this won't interrupt it"); drop "^C" from primary copy. (S)
- [ ] [MINOR] Sessions transcript leaks raw internals — `temp_1786207600642.md`, `grep -nE ...`, `<system-reminder>`, "Exit code: 0". → Default "clean" transcript view that folds system-reminders/temp-file/shell bookkeeping into muted expandable "internal step" chips; surface human prose. `SessionsView.tsx`. (M)
- [ ] [NIT] Inconsistent agent name casing + raw hash suffixes + mixed metaphors (director/Editor/Costume Curator/dialogue-editor, `lead-programmer-4c7de`). → Normalize to Title Case, hide hash suffix behind tooltip, curate one coherent sample team for the demo. (S)
- [x] [NIT] Double "AutoDev" title bar (OS titlebar + redundant 34px app strip) stacked on every screen. → Single custom frameless title bar; on non-macOS suppress the duplicate strip; reclaim ~28px vertical. (S)
- [ ] [NIT] Settings version footer renders "autodev-app — / cli —" (em-dashes instead of versions). → Populate real app+CLI versions from package metadata; hide the line if genuinely unavailable — never render missing data as "—". (S)

#### Copy / plain-language / onboarding
- [ ] [MAJOR] First visit to Office greets a brand-new user with red "Your office session expired — please sign in again" (nothing expired). → Distinguish first-run (no session) from genuine lapse; first arrival shows a neutral "Sign in to connect your team of agents". (S)
- [ ] [MAJOR] Wall of unexplained jargon ("Pixel Office", "MCP · 6 servers", "steer", "trace", "^C to interrupt", "Raw log", "Files: browser off"). → Plain-language pass + tooltips ("Pixel Office" → "Your team", "MCP · 6 servers" → "Tools: 6 connected", spell out "Ctrl-C"); park raw terms behind "Advanced". (M)
- [ ] [MINOR] Two near-identical sign-in screens with mismatched names (tab "Make app" opens panel titled "Spawn agents"; Office asks login twice). → Unify to a single session both tabs reuse; make tab label and panel title agree; one sentence per tab explaining what it uniquely does. (M)

#### Accessibility (WCAG 2.1 AA)
- [x] [BLOCKER] Secondary/meta text tiers fail 4.5:1 (`--tx-dim` 3.68:1, `--tx-faint` 3.04:1, `--tx-ghost` 2.65:1, `--tx-gutter` 2.00:1) — most informational text in Fleet/Sessions/rail is sub-minimum. → Raise content greys to ≥4.5:1 (bump `--tx-dim` to ~#9098a2 5.28:1; collapse faint tiers to one "meta" token ~#969da7); reserve faint tokens for decorative rules only. Pure token edit. (S)
- [x] [MAJOR] Input/control borders effectively invisible (`--bd-1` 1.31:1, `--bd-card` 1.24:1, empty checkbox 1.80:1) — login/connect forms look unfinished. → New `--bd-field` token ≥3:1 (e.g. #6c737e 3.68:1) on inputs/checkboxes/primary outlines; keep faint dividers only for passive tables. (S)
- [x] [MAJOR] Running/stopped state signalled by a 6px color dot alone (green/grey) — fails for ~8% color-blind and on a projector; the list (primary scan surface) has no text pill. → Add a redundant non-hue cue: hollow ring idle vs solid dot running, or a left accent bar / "live" ring. (S)
- [ ] [MAJOR] Icon-only controls (··· overflow, copy-path, folder-open, mic/attach) lack accessible names; context menu + Connect modals need focus-trap/Escape/return-focus. → `aria-label` every icon button; trap Tab, close on Escape, restore focus, set `role=dialog`/`aria-modal`. (M)
- [ ] [MINOR] Micro type (9–9.5px ids/paths/hints) painted in the failing greys — small AND low-contrast. → Floor readable metadata at 10.5px paired with corrected ≥4.5:1 greys; keep 9px for decorative glyphs only. (M)
- [ ] [MINOR] Disabled primary button conveyed by opacity alone (Make-app Connect); offline/steer notice + composer hints below contrast. → `aria-disabled` + non-opacity legible cue; raise the offline notice to `role=status` live region at corrected grey. (S)

#### Performance / first-paint
- [ ] [MAJOR] Single 1.02 MB unsplit renderer chunk — xterm + all 6 views eager-loaded, blocking cold-launch first paint (white window). → `manualChunks` for react/react-dom + @xterm/*; `React.lazy`+Suspense for Office/Sessions/MakeApp/Settings (keep Agents/Fleet eager); set a `chunkSizeWarningLimit` budget. (M)
- [ ] [MAJOR] `ActivityStream` re-parses the entire 20 KB buffer with ~8 regexes on every streamed line and re-renders all rows unvirtualized — quadratic stutter exactly on the "live agent working" surface. → Incremental delta-parsing with a cursor; coalesce appends to one rAF; virtualize rows (react-window); cap the Raw `<pre>` tail. (M)
- [ ] [MINOR] Keep-alive log panes each re-render a full-text `<pre>` on every tick; xterm instances accumulate for the session (heavier at minute 20 than minute 1). → Scope subscriptions per path; render last ~500 lines only; dispose xterm/FitAddon for exited PTYs. (M)
- [x] [MINOR] `agentStore` fleet poll (5s) runs with no window-focus/visibility gate; multiple fixed-cadence polls stack during a demo. → Gate on `visibilityState==='visible'` + pause on blur (mirror officeService.onFocus); same for sessionsService; back off when fleet idle. (S)
- [x] [MINOR] No first-paint skeleton — cold-start blank frame is unmasked. → Inline zero-JS skeleton (logo + nav silhouette) in index.html that React paints over; loading state on the Agents landing. (S)
- [ ] [NIT] No bundle-size / render-cost budget enforced — the 1 MB chunk grew unnoticed. → Fail the build over a gzipped budget; capture a React Profiler baseline of the streaming path in docs/performance. (S)

---

### 2.2 Pixel Office Web App (app.pixeloffice.org) — desktop + mobile + security

_Merges: drunk-designer, mobile, customer-persona, and security lenses. The empty-office finding recurs across three lenses and is collapsed to one blocker._

#### Design / UX / visual coherence
- [ ] [BLOCKER] The flagship office loads as an empty room — no agent characters, while the UI insists it is "Live" and the copy blames the viewer's terminal. → Seat lightweight greyed/sleeping sprites for every registered agent by default (org chart always legible); keep 3–4 genuinely online for the demo; add a subtle idle animation loop so the room reads alive. (M)
- [ ] [BLOCKER] Two visual languages bolted together: light-monospace "form" shell (landing, Register/Generate modals) vs dark-sans game world. Investors read inconsistency as immaturity. → Commit to ONE brand system (the distinctive pixel/monospace identity) across shell + interior; same wordmark, type scale, color tokens; make light/dark a deliberate tokenized toggle, not an accident of screen. (L)
- [ ] [MAJOR] "Your Offices" front door is 80% empty grey void with two tiny cards and a truncated "Pixel Office D…" label. → Turn the office card into a live pixel-scene thumbnail (map + sprites + pulsing "3 online of 13"), enlarge/center it, fill the space with a confident hero line. (M)
- [ ] [MAJOR] The hero — the living office — is quiet background; four dense text panels (Agents/Tasks/Messages/Hooks) win the eye. → Give the world dominant real estate; collapse the panels to slim tabbed rails (one open at a time); add motion (agents pathing to desks, thinking bubbles). (M)
- [ ] [MAJOR] Raw hook/telemetry console is a first-class panel ("Hook Events 22,615", `run_ter`, `use_too`, "< 1s") — debug output on stage; its own empty state says "you can safely ignore it." → Hide Hooks by default; if a liveness feel is wanted, render a clean human timeline ("Grace wrote TROUBLESHOOTING.md · 2s"); keep raw behind a dev toggle. (S)
- [ ] [MAJOR] Task list is machine gibberish — 100 near-identical "Message from X: SCREAMING_SNAKE" rows; reads like agents spamming code constants, not doing work. → Strip the "Message from…[task]" wrapper, Title-Case codenames, assignee as avatar chip, move VERIFY/ACK status-echoes out of the primary task list into a secondary activity view. (M)
- [ ] [MAJOR] No confident "it's ALIVE" heartbeat; the headline stat literally reads "0 active" during the demo, buried under IDLE/online/CLAUDE/CLI/XP noise. → One dominant liveness signal (animated pulse/typing indicator on working agents, in-world bubble + card), a top-line "N working now" that isn't zero; demote plumbing to an expander. (S)
- [ ] [MAJOR] Connect/Deploy wizard greets you as a sysadmin (npm install, signed setup URL, "Step 0 — give your agent a brain", git-commit/skip-hooks/force-overwrite checkboxes). → Lead with the one-click "Deploy online — run 24/7" hero framed as "Hire Art Director → at her desk in ~15s"; progressively disclose CLI/manual behind "Advanced". (M)
- [ ] [MAJOR] Empty-state copy blames the viewer ("12 agents registered · none connected. An agent comes online once its CLI or MCP connects.") and contradicts the green "Live" pill above it. → Rewrite for the person: "Your team is resting. Wake the office →"; make the "Live" pill honest (show "Idle/Resting" at 0 online). (S)
- [ ] [MAJOR] Office picker signals "nothing is running" before entry — every card grey "0 online of N", identical building emojis, an empty "traders 0 online of 0". → Give cards a floor thumbnail + one-line "what this team builds" + "N agents · M tasks done"; keep the demo office green; drop the empty office. (M)
- [ ] [MAJOR] Chat lands on an OFFLINE agent with duplicated "Session ended" markers and a "queue forever" composer note. → Default selection to an ONLINE agent; de-dupe the "Session ended" render; set honest expectation ("Grace is offline — this runs when she next comes online" + "Wake her now"). (S)
- [ ] [MAJOR] Demo seed data contains junk — an agent literally named "test" (slug `test-694b0`); "tasks" that are relayed messages. → Curate the demo office: delete/rename "test", real role names + avatars, seed genuine human-readable tasks with a healthy Pending/Done mix. (S)
- [ ] [MINOR] Truncation mid-word everywhere ("Pixel Office D…", `run_ter`, "PLAYTEST_M…", wraps as "D ONE"). → Widen rails / fewer items per card; 2-line clamps + word-break for UPPER_SNAKE; never truncate a wordmark; real labels + tooltips instead of sliced tokens. (S)
- [ ] [MINOR] Raw internal identifiers leak everywhere (agent slugs, "CLI 1.4.125", "TODO [4f6034…] marked done"). → Hide slugs/CLI/TODO-hash behind a details expander; show human name+role on primary surfaces; "TODO [hash] marked done" → "Marked task done." (S)
- [ ] [MINOR] Office floor is a flat grey placeholder grid — doesn't feel like a "place." → Floor tone/rug + light per zone (Open Plan / Meeting / Break), cluster desks by team, trim empty margins. (M)
- [ ] [MINOR] After the (good) Welcome modal closes, a first-timer faces an empty grid with no next-step nudge. → Persist a pulsing "+ Task" / "Wake your team" affordance until first agent online or first task posted. (M)
- [ ] [NIT] Gamification/version cruft ("0 XP → Lv2 at 50", "via WS + MCP", minimap, shouting orange CLAUDE/GROK tags) blurs the agent cards. → Strip cards to avatar/name/role/one liveness line; move XP/CLI/transport to hover; provider as a small muted glyph. (S)

#### Mobile (375px iOS / Android)
- [ ] [BLOCKER] Office canvas is letterboxed — bottom half of the screen is dead black void; the hero screen looks broken/half-loaded. → Size the canvas to `100dvh` minus top bar + bottom nav; fit-to-content camera; use `dvh` to survive URL-bar collapse. (M)
- [ ] [MAJOR] Top bar overflows the viewport — the destructive no-confirm logout button is clipped at the right edge next to "+". → Responsive flex row; collapse +/overflow/logout into the "…" menu at small widths; safe-area padding; never put a clipped no-confirm sign-out at the edge. (M)
- [ ] [MAJOR] Seven bottom-nav tabs crammed into 375px with colliding badges and sub-44px targets. → Keep 4–5 primary tabs (Office/Chat/Agents/Tasks), fold Feed/Hooks/Runs into one "Activity" or overflow; 48px targets. (M)
- [ ] [MAJOR] Desktop macOS traffic-light window chrome rendered inside mobile modals (Post Task, Register Agent), sometimes stacked modal-on-modal. → Hide window-chrome below a tablet breakpoint; native bottom sheets with a drag handle; no modal-on-modal on mobile. (S)
- [ ] [MAJOR] "Bring an agent online" is terminal-only and dead-ends on a phone (`npm install -g autodev-cli`, truncated overflowing command). → Detect touch viewports and lead with a cloud-deploy / QR "send to your computer" handoff; demote CLI to an "Advanced (on your computer)" accordion; make the command box wrap/scroll with a reachable copy button. (L)
- [ ] [MAJOR] One-tap destructive trash icon on every Tasks/Feed row with no confirm, sitting exactly where a scroll-fling lands. → Swipe-to-delete or move behind row overflow; confirm/undo toast; grow the hit target away from the scroll edge. (M)
- [ ] [MAJOR] Feed renders a raw agent UUID instead of a name; whole app reads "Offline / 7d". → Fix the sender-name fallback (never render a bare UUID); seed 1–2 agents online with recent timestamps for the demo. (M)
- [ ] [MINOR] Off-brand brown "new conversation" FAB overlaps/obscures the last chat row and competes with the Office FAB system. → Recolor to brand blue, add a list end-spacer, unify one FAB pattern across Office and Chat. (S)
- [ ] [MINOR] Double stacked headers (global bar + section subheader + a third Manage/+Task row) eat ~25% of a small screen. → Merge section title into the top bar on mobile or collapse it on scroll. (S)
- [ ] [NIT] Add-task sheet action row wraps and crowds at 375px ("+ Add Another" wraps, Cancel next to primary). → Stack actions: full-width primary "Post Task" on top, secondary/tertiary below or in overflow. (S)

#### Security / trust posture
- [ ] [MAJOR] Agent `agt_` api_key stored in plaintext in the DB while PATs are SHA-256 hashed and webhook secrets encrypted — the highest-privilege long-lived key is the least protected; a backup/replica/log/SQLi leak hands over working keys for every tenant. → Store `sha256(api_key)` in a new `api_key_hash` column (mirror `UserApiToken::hashFor`), switch the five lookups (WsAuthService, McpController, OfficeMcpController, AgentMcpController/AgentSkillController, HookEventController), show plaintext once at issue, backfill then drop the column. (M)
- [ ] [MAJOR] Zero HTTP security headers (no CSP, X-Frame-Options/frame-ancestors, HSTS, X-Content-Type-Options, Referrer-Policy) — the SPA and public `/public/{slug}` view are iframe-able (clickjacking owner controls); securityheaders.com gives an F on a live URL. → SecurityHeaders middleware on web+api: CSP (report-only → enforce), X-Frame-Options DENY, HSTS, nosniff, Referrer-Policy, Permissions-Policy. (S)
- [ ] [MAJOR] Unsafe shipped defaults: `.env.example` has `APP_DEBUG=true`, no `SESSION_SECURE_COOKIE`, no forced-HTTPS / TrustProxies — a self-host prospect stands up a debug-mode, insecure-cookie box. → `APP_DEBUG=false`, `SESSION_SECURE_COOKIE=true`, `SESSION_SAME_SITE=lax`, TrustProxies, `URL::forceScheme('https')` when not local; document in the self-host guide. (S)
- [ ] [MINOR] Account enumeration is inconsistent — `/auth/register` returns `unique:users,email` and `/offices/{slug}/invite` returns 404 "User not found", though login/forgot-password were hardened to uniform responses. → Register returns neutral success + out-of-band "you already have an account" email; invite creates a pending invitation keyed by email with a uniform response. (M)
- [ ] [MINOR] Login brute-force protection is per-IP throttle only (`throttle:10,1`) and remember-me is forced on (`Auth::attempt(...,true)`) for every login. → Add a per-email RateLimiter with backoff/lockout; make remember-me an opt-in checkbox. (S)
- [ ] [MINOR] CORS is `allowed_origins:['*']` + `allowed_headers:['*']` on `api/*` — a red flag on an authenticated API (and it weakens the CSRF preflight assumption). → Env-driven allowlist of your own origins + explicit `allowed_headers` incl. Authorization, X-XSRF-TOKEN. (S)

---

### 2.3 Deployer (deployer.pixeloffice.org)

_Merges: security, devops, and Filament-admin UX lenses. The "zero security headers" finding recurs and is kept once here (also flagged for Pixel Office above)._

#### Design / UX (Filament admin)
- [ ] [BLOCKER] Brand rupture at the threshold: dark premium landing → stock white light-mode Filament panel with amber default palette — reads as two different companies / an unfinished internal tool. → `->viteTheme()` real Filament theme carrying the landing tokens: default `->darkMode()`, `->brandName()`/`->brandLogo()`, `->font('Instrument Sans')`, dark surface palette. (M)
- [ ] [BLOCKER] Primary color is Filament's default `Color::Amber` — matches nothing on the violet brand and renders near-illegible amber-on-white. → Set primary to the brand indigo/violet (~#7c6cff) + explicit success/danger/info aliases. One-line, removes the strongest "unconfigured template" tell. (S)
- [ ] [MAJOR] Dashboard ships Filament's own `FilamentInfoWidget` (framework advert) + stock `AccountWidget` as first-screen content. → Remove both; lead with one clean PlatformStats metric row + the Quick Deploy action; move account/logout to the top-right user menu. (S)
- [ ] [MAJOR] Sidebar is a flat ungrouped list of nine technical nouns with arbitrary sort jumps. → `navigationGroup` labels: Agents / Infrastructure (Servers, Templates, Volumes, Snapshots) / Credentials & Secrets / Automation (Webhooks) / Audit (Activity Logs). (S)
- [ ] [MAJOR] Login is a bare card in an empty white void — no logo, no framing — indistinguishable from a default install, on a product that pitches credential custody. → Dark branded split-screen matching the landing (brand mark + one-line value prop + form), reusing landing surface/typography. (M)
- [ ] [MAJOR] The flagship entity — Agents — is faceless, keyed by raw `id` (search/breadcrumbs/pickers surface "12"). → Give agents a human name/label, set `recordTitleAttribute` to it, first column = name + provider identity, demote raw id. (M)
- [ ] [MAJOR] Quick Deploy "Lambda Workflow" widget renders explainer text as disabled multi-Selects under a "💡 Lambda Workflow Explained" emoji heading — looks broken/half-built in the widget investors click most. → Replace disabled Selects with a prose/callout block, heroicon not emoji, rename action to plain "Snapshot & Pause Billing". (S)
- [ ] [MAJOR] No credential-custody reassurance at the exact moment users paste a live GitHub PAT + Anthropic token (the backend already encrypts/masks/never-returns/revokes — invisible in the UI). → Add a trust affordance beside the secret field: "Encrypted at rest (AES-256), masked in the UI, never returned by the API, revocable anytime." Purely presentational. (S)
- [ ] [MINOR] Color is scattered not hierarchical — four stat colors, mixed amber/green buttons, three consecutive grey badges; no single primary action stands out. → Reserve saturated color for status semantics only; neutral metric tiles/badges; one branded primary (Deploy) per screen. (S)
- [ ] [MINOR] The brand font (Instrument Sans in app.css) never reaches the panel (no viteTheme) — landing and product use different typefaces. → Register the panel theme so the font + tokens load inside `/admin` (folds into the theming item). (S)
- [ ] [NIT] Browser tab shows the default Laravel/Filament favicon during screen-share. → Add a branded favicon + wire `->favicon()`. (S)

#### Functionality / DevOps / operational readiness
- [ ] [BLOCKER] Agent containers/pods have NO resource limits — one runaway agent (documented opencode 3s-spin / 660 MB session explosion) OOM/CPU-starves the shared host and kills every agent mid-pitch. → `--memory=2g --cpus=1.5 --pids-limit=512 --restart=on-failure:0` on docker run; `resources.requests/limits` on the K8s spec; cap concurrent agents per host. `DockerAgentService.php:58`, `k8s/agent-job.yaml.tpl`. (S)
- [ ] [MAJOR] Agent image is non-reproducible: `npm install -g autodev-cli@latest @anthropic-ai/claude-code` (both unpinned) baked in AND re-pulled on every boot; K8s uses `IfNotPresent` against mutable `:latest`. A live spawn can pull a just-published broken CLI on stage. → Pin claude-code + base digest; drive CLI version only from `AUTODEV_CLI_VERSION`; tag images by git SHA. (M)
- [ ] [MAJOR] Prod deploy has no rollback path and no post-deploy smoke test — `deploy-prod.sh` prints "DEPLOY SUCCESS" from bash exit codes, never curls the site; no maintenance window. → Wrap migrate/build in `artisan down`/`up`; add a `curl -fsS .../up` gate that fails+rolls back on non-200; document a one-command rollback runbook. (M)
- [ ] [MAJOR] QUEUE + CACHE + SESSION all on the single app DB — the exact contention OPERATIONS.md documents as the "Loading servers… forever" freeze; a lock spike freezes the screen you're presenting from. → Move CACHE + SESSION to redis (file cache minimum); keep queue on redis/dedicated DB; confirm prod is MySQL everywhere. (M)
- [ ] [MAJOR] No alerting when an agent silently dies (grok "online but idle", reauth_required, token lapse) — only visible if a human watches the panel. → Add Sentry/Flare + a lightweight email/Slack/webhook alert on ERROR/reauth_required and failed queue jobs; have `ReconcileAgentsJob` page, not just reconcile. (M)
- [ ] [MAJOR] Unauthenticated API hit in a browser returns a raw Laravel 500 "Server Error" HTML page (Sanctum redirects guests to a missing `login` route). → In `bootstrap/app.php` force JSON for `/api/*` (`shouldRenderJsonWhen`) / set `redirectGuestsTo` to a 401 JSON body; add a regression test hitting `/api/agents` with `Accept: text/html`. (S)
- [ ] [MAJOR] Zero HTTP security headers on a credential-custody product (F on securityheaders.com); Filament clickjackable, no HSTS. → Global SecurityHeaders middleware (HSTS preload, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, scoped CSP) on web+api; verify grade flips to A. (S)
- [ ] [MAJOR] Known-vulnerable dependency shipped: `league/commonmark` <2.9.0 (2 High DoS advisories). → `composer update league/commonmark` to ≥2.9.0, redeploy, confirm `composer audit` clean; commit `composer.lock` (currently gitignored) and gate deploys on `composer audit`. (S)
- [ ] [MINOR] Health check `/up` is Laravel's shallow default and nothing external probes it. → Point an uptime monitor at `/up`; extend it to assert DB connectivity + a queue-worker heartbeat + one cloud API reachable; show a green public status page in DD. (S)
- [ ] [MINOR] Session files stored unencrypted (`SESSION_ENCRYPT=false`) on the host that runs Docker/kubectl/SSH. → `SESSION_ENCRYPT=true` (prefer DB/redis driver). (S)
- [ ] [MINOR] K8s agent Job runs as root, `backoffLimit:0` (transient crash = permanently dead), logs vanish after 1h TTL. → `securityContext` (runAsNonRoot, drop ALL caps, readOnlyRootFilesystem where feasible); small backoffLimit; ship logs to durable storage before cleanup. (M)
- [ ] [NIT] Server banner disclosed (`Server: Apache`). → `ServerTokens Prod` + `ServerSignature Off` (bundle with the headers change). (S)

---

### 2.4 Famous Fighters demo game (ff.epicmovies.net)

_UX/visual + product-narrative lenses._

#### Design / UX
- [ ] [BLOCKER] The dense keyboard+gamepad control-legend is stamped on every screen (landing, character-select, under every fight + result) — the #1 "prototype not product" tell. → Remove it from all gameplay screens; collapse to one quiet "Controls" affordance + a one-time first-round tooltip. (M)
- [ ] [BLOCKER] Landing has no dominant primary action — 6 equal-size buttons in arbitrary blue/pink/gray. → Elevate one hero CTA ("Play" / "Vs CPU"), demote the rest to a consistent secondary grid; reserve color for meaning. (M)
- [ ] [MAJOR] Engineering/internal jargon leaks into player UI ("Stage (WAVE_F2)", "Region UV from Level Designer (±2%)", "synced via Reverb + API", "not online GGPO", "InputFrame online", "no PII", "8 codenames"). → Strip all backstage terms; real stage names; a genuine tagline instead of a feature checklist. (S)
- [ ] [MAJOR] The best asset — the fight canvas — is buried under overlaid chrome (keycap strip, floating name labels over sprites, touch joystick a keyboard player never uses). → Move the keycap strip out of the canvas, drop floating name labels (names live in HP bars), hide touch controls on non-touch devices. (M)
- [ ] [MAJOR] UI chrome (rounded blue panels, plain sans, bootstrap-ish cards) doesn't match the game's pixel-art identity — two products bolted together. → Commit the whole UI to the arcade identity: one display typeface for headings, panel framing + accent palette pulled from the sprite art. (L)
- [ ] [MAJOR] Character-select cards are cramped (portrait + 3 lines of stats) and the selected state is a barely-visible 1px border. → Simplify card face to portrait + name + archetype; reveal stats only for the highlighted fighter; make selection unmistakable (fill + glow + scale). (M)
- [ ] [MAJOR] Combo feedback renders as duplicated/overlapping indicators ("3 HIT COMBO" + "3 HIT!" + floating numbers) — looks like a rendering bug at the juiciest moment. → One combo readout, one anchored location, one animation curve near the attacker. (S)
- [ ] [MINOR] Destructive "Clear History" is the brightest element on an empty Match-History screen. → Hide it when history is empty; render as a quiet tertiary/text button otherwise. (S)
- [ ] [MINOR] Personality flavor text ("Smile for the poster. Then hit the mat.") styled as a cyan system-alert box. → Render as understated italic caption integrated into the scene. (S)
- [ ] [MINOR] Accent color carries no consistent meaning (same pink = Online, Combo Trials, Clear History, S/SP buttons). → Two roles only — one accent for primary/positive, one for danger; apply consistently. (S)

#### Presentation / narrative (game as demo proof)
- [ ] [MAJOR] The payoff — actual combat — looks janky (tiny overlapping sprites, odd opponent card-frame, floating "74") next to the gorgeous character-select; investors equate output quality with agent capability. → Rehearse the click path to lead with the strongest slice (select → clean combo → super-meter cash-in) and cut before messy exchanges; file a real combat polish pass (sprite scale, hit-spark/damage-number layering). (S)
- [ ] [MINOR] Off-brand hosting — the shipped game footer reads "ff.epicmovies.net". → Deploy to a clean on-brand URL (a pixeloffice.org subdomain) and update the footer before the demo. (S)

---

### 2.5 Marketing site (pixeloffice.org)

_Merges: customer-persona and tech-writer lenses._

#### Functionality / trust (the funnel actually working)
- [ ] [BLOCKER] Primary CTA "Enter the hosted office" lands on an EMPTY office ("0 agents · 0 active", "Nothing here yet") — the product contradicts its headline the instant you enter. → Babysit one flagship demo office with 3–5 agents genuinely looping/messaging during the demo window + an uptime check; point the hero CTA at that specific office, not the picker. (M)
- [ ] [BLOCKER] "Open source — read every line" but 3 of 4 GitHub repo links 404 (incl. flagship pixel-office and the "Star on GitHub" button); makes the "4 repos in the open" stat provably false. → Make the repos public at the linked URLs (or remove cards + stat); re-test all four links + the Star button. (M)
- [ ] [MAJOR] No public spectator demo — the hosted-office CTA hits a sign-in wall for a cold visitor; "Enter" implies walk-right-in. → Publish a read-only public demo office (no login) with live agents, linked as "Watch a live office →"; keep "Enter" as the secondary sign-in path. (M)
- [ ] [MINOR] Headline stats are unverifiable/contradicted in the live env ("10 coworkers" vs 0 online, "4 repos" vs 3× 404). → Make each number literally true in the demo path, or soften; show "~15s deploy" as a real timed clip. (S)
- [ ] [MINOR] Site tab has no favicon (`/favicon.ico` 404). → Add the pixel-office square-logo favicon referenced site-wide. (S)
- [ ] [MINOR] Mobile: the XP taskbar nav clips tabs (`overflow:hidden`) on index/tour and duplicates the top nav; open-source.html already fixes this inconsistently. → Apply the `overflow-x:auto` scrollable pattern site-wide, or hide the taskbar on mobile and keep the top nav; verify every tab reachable at 390px. (S)

#### Design / brand
- [ ] [MAJOR] Brand whiplash: bright Frutiger-Aero glossy marketing vs dark monospace terminal app — reads as bait-and-switch. → Carry one identity across the seam (echo the app palette/type in the hero/CTAs, or land investors in the app's light/XP theme); add a "opens the live app" expectation-setter. (M)
- [ ] [MAJOR] Tour "proof" screenshots are illegible at display size — including the "two commands" setup, the exact thing skeptics want to read. → Replace setup shots with legible copy-pasteable command blocks; crop/zoom office/chat shots to the referenced element with a callout. (M)
- [ ] [MAJOR] Hero product shot is a dense full-app capture — unparseable in the 3-second first impression; the "watch agents work" magic is invisible in a still. → Lead with a focused autoplaying loop (agent walks to a desk, task flips to done, XP ticks) or a tight 2–3-agent crop with a status bubble; move the full-house shot down. (M)
- [ ] [MINOR] Competing equal-weight primary CTAs (Deployer page + Tour end each show two blue primaries side by side). → One primary per view; demote the secondary to the existing ghost/outline style. (S)

#### Copy / narrative / docs (investor questions)
- [ ] [MAJOR] No business model anywhere — "free & private" is the only pricing signal next to a hosted SaaS + managed deployer; reads as an open-source hobby project. → Add a "Hosted vs self-host" band / Pricing tab: self-host = free & private, hosted = paid convenience tier for teams/fleet ("Free to self-host · Team plans for hosted fleets — talk to us"). (M)
- [ ] [MAJOR] No contact / team / "book a demo" path — every CTA is self-serve "Open the app"; the fundraising visitor hits a dead end and there's no credibility anchor. → Footer contact + one "Talk to the team / Book a demo" CTA + a one-line "Built by the AutoDev team" with a link. (S)
- [ ] [MAJOR] The strongest proof point — Famous Fighters, a real playable game shipped by the office (12 agents, 100 tasks, 22k events) — is buried on the Tutorial tab, never on the home page. → Add a "Proof: shipped by a Pixel Office" home-page band linking ff.epicmovies.net with the 12/100/22k stat trio. (M)
- [ ] [MAJOR] Stale/internal files served from the public web root (a grok bug-report .md, "Pixel Office Frutiger Aero Redesign.zip", `index.html.bak-*`, `index_old.html`, `_dc-source`) — a confidentiality + hygiene red flag in DD. → Delete/move them out of public_html to a non-served backup; add a deploy step that publishes only canonical assets. (S)
- [ ] [MAJOR] Headline agent/skin counts drift across pages (home "10 coworkers"/"7 skins", Tour "7 agents"/"9 of 10 online", Tutorial "12 agents"). → Pick canonical numbers everywhere: "up to 10 agents per office" as capability, 12 as a specific case study; reconcile the two adjacent "7"s. (S)
- [ ] [MAJOR] Hero leads with the toy framing (pixel coworkers, XP, skins) instead of the category; the clear "what is this" lives only in the meta description. → Add a plain category line under the H1: "The observability and control layer for teams of autonomous AI agents — see, steer, and deploy them in the open." (S)
- [ ] [MINOR] "MCP" and "A2A" used constantly but never expanded once (the string "Model Context Protocol" appears nowhere). → Expand "Model Context Protocol (MCP)" on first use + a half-sentence gloss for A2A ("agent-to-agent messaging"). (S)
- [ ] [MINOR] Feature copy padded with aphorisms that assert rather than inform ("no yak-shaving", "Autonomy without a steering wheel is just risk"). → Cut the lead aphorism from each card; lead with the concrete capability + a verifiable specific (what, over what protocol, how fast); keep at most one voice line per page. (M)
- [ ] [MINOR] Open-source credibility undercut by split ownership (flagship repo under personal `github.com/peter-mw` next to `github.com/autoaidev/*`) and a "Star on GitHub" with no star count. → Consolidate public repos under the org (or explain the split), verify all four resolve to populated repos, show a real star count or drop the implied-popularity CTA. (M)

---

### 2.6 CLI / Product-demo narrative (`autodev office` → a team builds a real game)

- [ ] [BLOCKER] The hero command `autodev office` isn't one command and isn't in the README — it needs a pre-minted PAT (`POST /api/auth/tokens`), `--url`/`--token`, a pre-built office with characters + per-agent creds, and each provider CLI installed + freshly authed; `grep autodev office README.md` = 0 hits. → Add `autodev login` (device-code/browser) that mints+stores the PAT; make bare `autodev office` list+prompt; add a green/red preflight checklist (token ok, N characters found, each provider CLI present+authed) BEFORE spawning; document it as the headline quickstart. (M)
- [ ] [BLOCKER] No "watch it happen from zero" proof — investors assume the demo is pre-recorded/canned. → Script one live beat: start from a near-empty branch, drop a task, stream that agent's real Edit/Bash/commit activity (mcp-operate already ships hook_event frames + git panel), then hot-reload the game; add a visible "Live" badge + commit ticker tied to the real repo. (L)
- [ ] [MAJOR] Fragility risk — a mid-demo "please login" 401, stuck "working" badge, or grok-token expiry (documented: Claude subscription 401s, grok tokens die ~6h and hang silently, opencode session spin) turns "autonomous org" into "brittle science project." → Gate `autodev office` startup on a `--preflight` that verifies every character's provider-token freshness and refuses to start with "Agent X needs re-auth" instead of failing live; pre-warm/refresh all tokens right before the demo; pin known-stable providers; rehearse a recovery line. (M)
- [ ] [MAJOR] The team/division-of-labor story is invisible — the differentiator (an org of specialized agents, not one model) never lands; generic "agents working" is indistinguishable from a single-agent loop. → Surface a per-agent contribution line ("Nora — 12 sprites + palette", "Kai — netcode", "Ada — combat + super meter") derived from commits/task titles; give the presenter a 30-sec "meet the team, here's who built which part" beat. (M)
- [ ] [MAJOR] No cost/usage story — investors will ask "what did the overnight run cost?" and there's no number on screen; "we shipped a complete playable game autonomously overnight for $X" is a killer unit-economics stat. → Surface a per-office token + $ tally in the cockpit (reuse the deployer's per-key usage bars); bake the concrete overnight figure into the closing line. (M)
- [ ] [MINOR] The auto-spawn "add a teammate live" moment exists in code (office.ts watcher auto-binds+starts a new character within ~15s) but isn't dramatized — the single most delightful hard-to-fake wow. → Choreograph it: mid-demo add a 4th character in pixel-office, it appears in the app and picks up a task within one `--interval`; tighten the demo `--interval`; add a "New teammate joined" toast. (S)
- [ ] [MINOR] No self-serve "try it yourself" path after the demo — excitement decays; "I couldn't get it running" is a deal-cooler. → A one-page "Run your first office in 3 steps" (login → create office w/ 2 starter characters → `autodev office <slug>`) + a pre-seeded demo office template so a new user reaches a working animated office in minutes. (M)

---

## 3. The 5-Minute Investor Demo Script

The demo's job is to deliver the one emotion the product exists for — **"they're actually working, right now, as a team, and they built something real"** — and to never expose a contradiction or a raw seam. Rehearse the exact click path; pre-warm every token; have a fallback for each live beat.

**Pre-flight (before anyone is in the room)**
- Run `autodev office <demo-slug> --preflight`; confirm all provider tokens fresh, all characters bound, all CLIs authed. Refresh grok/Claude tokens now (they lapse).
- Confirm the flagship demo office shows **green "N working now"**, agents seated and moving, tasks flowing — not "0 active".
- Confirm all 4 GitHub repo links + the marketing hero CTA + ff.epicmovies.net resolve.
- Pre-authenticate the Electron demo account so Office and Make-app land on live content, not a login/expired-session wall.
- Open only branded tabs (favicons present); close anything with a raw framework error.

**Minute 0–1 — The hook: a living office.** Open the marketing site → click the hero into the **live** flagship office (public read-only demo, no login). Investor sees agents at desks, thinking bubbles, tasks moving, "3 working now". _This is the whole pitch in 15 seconds. It must never be empty._

**Minute 1–2 — It's a real team that ships real software.** Cut to Famous Fighters (clean on-brand URL). Character-select screen (studio-quality) → one clean combo → super-meter cash-in on the best fighter/stage. Then flip back to the office and show the **per-agent contribution lines** — "Nora did the art, Kai the netcode, Ada the combat." The differentiator lands: an *org*, not one model.

**Minute 2–3.5 — Watch it build from zero (live proof).** Drop a task into the office. Show the cockpit streaming that agent's real Edit/Bash/**commit** activity, "Live" badge + commit ticker on the real repo, then a hot-reload of the game reflecting the change. _This is what defeats "it's canned."_ Fallback: a pre-recorded clip of the same beat, clearly labeled.

**Minute 3.5–4.5 — Hire a teammate on stage.** Add a 4th character in pixel-office; within one interval it walks in and picks up a task ("New teammate joined" toast). Then the Electron cockpit: streaming Activity, mid-turn steer, the Fleet view alive with colored WORKING states and the hero stat **"6,408 tasks completed today."**

**Minute 4.5–5 — The business.** One line on deploy-anywhere (your machines or ours, 24/7), one line on the model (self-host free & private / hosted team plans), and the unit-economics kicker: **"this complete, playable game was built and shipped autonomously overnight for $X."** Close on the open-source proof (4 working repos).

**What must be flawless (zero tolerance):** no "session expired", no "0 active/0 running", no "not connected" contradiction, no Settings "Stage 3" disclaimer, no 404 repo link, no raw temp-path/UUID/SCREAMING_SNAKE on screen, no janky combat as the climax, no mid-demo 401/stuck-badge.

---

## 4. Cross-Cutting Themes

These recur across every app and are the highest-leverage fixes because one pattern-fix pays off in many places.

**1. Coherence / one brand.** The single loudest trust signal. Recurring rupture: marketing (Frutiger-Aero) vs app (dark terminal); Pixel Office shell (light mono) vs interior (dark sans); Deployer landing (dark violet) vs Filament admin (white amber); Famous Fighters art vs generic-web UI. → Pick one identity per product and carry tokens/type/logo/favicon across every seam, including admin panels and modals.

**2. Live seed data / kill the empty state.** Every default state an investor sees is empty or idle (dead office, "0 running", "0 active", idle center-stage agent, empty Activity/Terminal, "Nothing needs you", empty office picker). The product's whole magic is motion, and motion is exactly what's absent. → Never show a fully empty floor for an office with history (seat greyed sprites); auto-focus a running agent; keep 3–5 agents genuinely live for the demo; make empty states aspirational with a single CTA.

**3. Status truth / no self-contradiction.** WORKING+offline, connected+not-connected, filled progress bar over "no tasks", green dot with "0", "Live" pill over "0 online". These read as "the indicators lie." → One source of truth per state, bound to every surface; make badges honest at zero.

**4. Hide the console / speak human.** Developer scaffolding leaks everywhere: temp file paths, `<system-reminder>`, exit codes, hook telemetry (22,615 events), CLI version strings, agent slugs/UUIDs, TODO hashes, SCREAMING_SNAKE task codes, terminal-only onboarding, engineering codenames (WAVE_F2, GGPO). → Default to human prose + friendly labels; park raw internals behind an "Advanced"/dev toggle; humanize task titles and agent names.

**5. Trust/security signals for DD.** Both credential-custody products score F on securityheaders.com, store the highest-privilege key in plaintext, and have unsafe env defaults — while the good work (hashed PATs, encrypted secrets, closed IDORs, fail-closed WS auth) is invisible. → Add security headers everywhere, hash the agent key, fix the 500-on-guest-API, and surface the existing custody controls as a visible affordance.

**6. Mobile is a squeezed desktop.** Letterboxed canvas over black void, clipped top bar, 7 crammed tabs, desktop traffic-lights in mobile modals, terminal-only onboarding that dead-ends on a phone, no-confirm deletes at the scroll edge. → Responsive breakpoints, `dvh` sizing, bottom sheets, a non-terminal mobile connect path.

**7. Empty-state → first-action.** Blank panes must pull to one weighted CTA, not report absence — Activity, Terminal, office floor, office picker, post-Welcome-modal grid all fail this.

**8. Performance for perceived polish.** 1 MB unsplit chunk (blank cold-start), quadratic ActivityStream re-parse on the live-agent surface, ungated polls. → Code-split + lazy views, incremental parsing + virtualization, visibility-gated polls, an inline skeleton, and a bundle budget in CI.

**9. Onboarding leads with the hard path.** Everywhere the terminal/CLI/npm path is the default and the one-click/no-terminal/hosted path is buried. → Invert: lead with the one-click hero, demote CLI to "Advanced".

---

## 5. Sequencing

### Wave 0 — Demo-safe stage dressing (hours, do first)
Highest impact-per-effort; makes the live walkthrough survivable without touching architecture.
- Stand up + babysit the live flagship demo office (real agents looping); point every hero CTA at it. _(unblocks #1, marketing, office empty-state)_
- Delete the Settings "Stage 3 / not saved yet / COMING SOON" strings; open Settings on Providers.
- Make all 4 GitHub repos public at the linked URLs; re-test links + Star button.
- Curate demo seed data: rename/delete the "test" agent, humanize task titles, Title-Case names, hide slugs/CLI/UUIDs on primary surfaces.
- Pre-authenticate the Electron demo account; refresh grok/Claude tokens; pin stable providers.
- Deployer: set Filament primary to brand violet + brandName/logo/favicon + remove FilamentInfoWidget/AccountWidget (a handful of one-liners that kill the "template" tell).
- Move stale/internal files out of the marketing public web root.
- Famous Fighters: remove the control-legend from gameplay screens; strip codenames; rehearse the strongest fight slice.

### Wave 1 — Quick high-impact wins (1–2 days)
- Security headers middleware on **both** Pixel Office and Deployer (F→A); `ServerTokens Prod`.
- Deployer: add container/pod resource limits; force JSON 401 on `/api/*`; `composer update league/commonmark`.
- Electron: session-expired → single quiet neutral "Reconnect" + silent token refresh; "0 running" grey-at-zero; promote the "6,408 today" hero stat + thousands separators.
- WCAG token edits: raise secondary-text greys ≥4.5:1 and control borders ≥3:1 (pure token file).
- Pixel Office: hide the Hooks panel by default; make the "Live" pill honest; de-dupe "Session ended"; recolor/reposition the mobile FAB.
- Marketing: add favicon, category line under the H1, contact/book-a-demo CTA, fix the mobile taskbar overflow; reconcile the drifting stat numbers.
- CLI: `--preflight` checklist + document `autodev office` as the quickstart.

### Wave 2 — Structural fixes (3–7 days)
- Electron: one connection source-of-truth bound to all surfaces; auto-focus a live agent on launch; make empty states stream real content; humanize labels + type hierarchy; code-split bundle + lazy views + incremental ActivityStream.
- Pixel Office: rebalance the office as the hero (slim tabbed rails, in-world motion); seat greyed sprites for offline agents; mobile canvas `100dvh` + responsive top bar + 4–5 tabs + non-terminal connect path.
- Deployer: real dark Filament theme (viteTheme + font + tokens), grouped sidebar, branded login, named agents; deploy rollback + smoke test; move CACHE/SESSION off the app DB; error tracking + agent-death alerting; pinned reproducible agent image.
- Security: hash the agent `agt_` key + migrate; fix enumeration + CORS + remember-me.
- CLI: `autodev login` (device-code PAT); per-agent contribution lines; per-office token/$ tally.

### Wave 3 — Bigger bets (post-demo / week+)
- One coherent brand system across every marketing↔app↔admin seam (the "two companies" fix, tokenized).
- The "build from zero, live" demo beat wired to a real repo with a Live badge + commit ticker.
- Make-app pre-auth teaser (type-your-idea → team animates in).
- Famous Fighters: full arcade-identity UI pass + combat-scene polish (sprite scale, hit-spark layering).
- Public read-only spectator demo office; self-serve "run your first office in 3 steps" + seeded template.
- Business-model / pricing band + team/credibility content on the marketing site.

---

_End of plan. Treat every checkbox as a backlog item; treat Section 3 as the rehearsal contract._
