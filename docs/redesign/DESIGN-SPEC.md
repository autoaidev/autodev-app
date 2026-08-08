# AutoDev desktop — redesign design system & screen spec

Source of truth: `docs/redesign/mockup-v2.html` (canvas design doc, section `t2`, options `2a`–`2h`).
This document recovers every literal token from the inline styles and gives an implementation-ready
spec: a design-token table, a shared-primitives catalog, and one section per screen (ASCII layout +
component tree + exact measurements + interaction notes).

## Design thesis (from the `.dv-note`)

The current app repeats identical information on every row (each of 29 agents carries the same office
badge, provider, id), splits one agent across six tabs (Overview shows four zeros, Output shows raw
ANSI), and scrolls three Office columns at once. The rebuild:

1. **One detail surface, not six tabs** — live work on the left, Todo/session/config in a fixed right
   inspector, Config demoted to a modal (edited rarely).
2. **Rows carry only what differs** — office name lives on the group header; id + provider collapse
   into one dim mono meta line; the right edge is reserved for the single number that matters (tasks left).
3. **Logs are parsed, not echoed** — timestamps stripped to a gutter, severity coloured, repeated MCP
   lines folded into one summary row (`5 lines folded ▾`).
4. **A Fleet view** answers "what needs me" across 29 agents — a job no current screen does.

Constant palette rule: **IDE-native dark, ONE blue accent (`#4a9eff`), status colours reserved strictly
for state** (green running, amber needs-you, red error/timeout, grey idle).

---

# 1. Design tokens

## 1.1 Color — surfaces / backgrounds

| Token | Hex | Usage |
|---|---|---|
| `--bg-app` | `#0b0d11` | Outermost canvas behind cards (2f, 2g), deepest layer |
| `--bg-0` | `#0f1216` | Primary app background / main content panes / card body |
| `--bg-1` | `#12151a` | Right inspector panel background (2a, 2c) |
| `--bg-2` | `#13161b` | Empty/dashed "ghost" tiles (office +N more, collapsed run group) |
| `--bg-topbar` | `#14171c` | Title bar (34px) + nav bar (46px) + bottom status bars |
| `--bg-sidebar` | `#16191f` | Agents rail background; also cards/panels/message bubbles |
| `--bg-panel` | `#16191f` | Cards, stat tiles, task cards, chat bubbles, modals |
| `--bg-panel-alt`| `#171b21` | Nested panel inside a card (MCP error inline, JSON collapsed value bg) |
| `--bg-elev` | `#181c22` | Floating context menu surface |
| `--bg-input` | `#1c2027` | Inputs, pills, buttons (secondary), chips, search fields |
| `--bg-todo-active`| `#1a1f27` | Active TODO row highlight (subtle) |
| `--bg-selected` | `#1e2530` | Selected nav item, selected agent row, selected session row |
| `--bg-sel-header`| `#1a2530` | Bulk-select group header bar (with `#2a3646` border) |
| `--bg-accent-soft`| `#22303f` | Blue-tinted selected chip / provider=claude badge / menu hover |
| `--bg-chip-idle`| `#22262e` | Avatar squares / neutral icon tiles |

## 1.2 Color — borders / dividers

| Token | Hex | Usage |
|---|---|---|
| `--bd-strong` | `#2f353e` | Modal borders, elevated menu border, avatar tile border |
| `--bd-1` | `#2a2f38` | Default control border (inputs, pills, buttons) |
| `--bd-nav` | `#22262e` | Topbar / sidebar structural divider |
| `--bd-card` | `#262b33` | Card internal border, menu separators |
| `--bd-2` | `#1c2027` | Hairline divider inside main content (`border-bottom`) |
| `--bd-row` | `#171b21` | Table row separator (Fleet) — nearly invisible |
| `--bd-accent` | `#2f4a6d` | Blue-tinted border (selected filter chip, claude badge) |
| `--bd-panel-sel`| `#2a3646` | Selected office card / accent-bordered panel |
| `--bd-idle-box` | `#3a4049` | Empty checkbox border |
| `--bd-icon-btn` | `#2f3f4f` | Toolbar icon-button border |
| `--bd-track` | `#3a4657` | Inline `···` row-action button border |

## 1.3 Color — text tiers

| Token | Hex | Usage |
|---|---|---|
| `--tx-hi` | `#e4e8ee` | Primary headings, active values, selected labels |
| `--tx-1` | `#d7dbe0` | Standard body value text |
| `--tx-2` | `#c3c9d2` | Secondary body / button labels / log body |
| `--tx-3` | `#9aa1ab` | Muted nav items, dimmed agent names (idle) |
| `--tx-4` | `#8b929c` | Section-label text, meta, tertiary |
| `--tx-5` | `#7d848f` | Subtitle / "provider default" / de-emphasized |
| `--tx-dim` | `#6c737e` | Mono meta, timestamps context, icon strokes |
| `--tx-faint` | `#5f6671` | Placeholder text |
| `--tx-ghost` | `#565d67` | Mono ids/paths dim, folded-line labels, ⌘K hint |
| `--tx-gutter` | `#454b55` | Log timestamp gutter, line numbers |
| `--tx-onaccent`| `#08111d` | Text/icon on blue accent fills (near-black navy) |

## 1.4 Color — the single accent + tints

| Token | Hex | Usage |
|---|---|---|
| `--accent` | `#4a9eff` | THE blue. Primary buttons, active tab underline, selected checkbox, links, progress fill, focus rail |
| `--accent-ink`| `#9cc5f5` | Light-blue text on blue-tinted surfaces (counts, claude badge text) |
| `--accent-ink2`| `#dbe7f7` | Text inside your own (blue) chat bubble |
| `--accent-tint-06`| `rgba(74,158,255,.12)` | inset ring on connected office character card |
| `--accent-cursor`| `#4a9eff` | Blinking text cursor block |

## 1.5 Color — status (reserved for state ONLY)

| Token | Hex | State | Tints used |
|---|---|---|---|
| `--st-running` | `#46b17b` | running / working / live / ready / connected / done-check | dot glow `rgba(70,177,123,.16)`; pill bg `rgba(70,177,123,.10)` border `.28`; badge bg `.12` border `.28` |
| `--st-needsyou`| `#d8a54a` | needs-you / asked / waiting / rate-limit | chip bg `rgba(216,165,74,.10)` border `.30`; row wash `rgba(216,165,74,.05)`; badge bg `.12` border `.28` |
| `--st-error` | `#e06a5c` | error / timed-out / failing / removed / delete | wash `rgba(224,106,92,.05–.07)`; border `rgba(224,106,92,.26)`; error text bright `#f0b3aa` / `#f0b3aa` |
| `--st-idle` | `#3d434c` | idle / offline dot / separator `·` | — |
| `--st-track` | `#2f353e` | filled-but-empty progress track (idle bar 100% grey) |
| `--st-track-bg`| `#222730` | progress bar background trough |

## 1.6 Color — accent people/roles & syntax

| Token | Hex | Usage |
|---|---|---|
| `--role-violet` | `#9a86e8` | office/message author accent, ✎ write action, ✉ mail icon, "Connect to office" icon |
| `--role-violet-2`| `#c3b6f0` | "you" author name, your-avatar text |
| `--role-blue-av`| `#2f4a6d` (bg) / `#9cc5f5` (fg) | Agent avatar square (AD / BA) |
| `--role-violet-av`| `#3a3550` (bg) / `#c3b6f0` (fg) | PM / your avatar square |
| `--role-peach` | `#e8b7ae` | a distinct office speaker name (Game Director) |
| `--syn-key` | `#9cc5f5` | JSON keys |
| `--syn-str` | `#a8dcbf` | JSON string values |
| `--syn-bool` | `#d8a54a` | JSON booleans/literals |
| `--syn-punct` | `#8b929c` | JSON punctuation |
| `--diff-add` | `#46b17b` | `+142` additions |
| `--diff-del` | `#e06a5c` | `−18` deletions |

## 1.7 Typography

- **Sans (UI):** `'Helvetica Neue', Helvetica, Arial, sans-serif` — all labels, headings, body.
  In production use the system UI stack; the mockup's chrome uses Helvetica Neue.
- **Mono:** `'JetBrains Mono', monospace` — ids, paths, timestamps, counts, tokens, code, badges,
  keyboard hints (`⌘K`, `⏎`), any machine value.

Size scale (px) observed:

| Token | Size | Weight(s) | Typical use |
|---|---|---|---|
| `t-18` | 18px | 700 | Page titles (Fleet, Settings, section title) |
| `t-16` | 16px | 700 | Agent detail name (2a header) |
| `t-15` | 15px | 700 | Panel titles (Offices, Sessions, modal title, Famous fighters) |
| `t-14.5`| 14.5px | 700 | Session detail title |
| `t-14` | 14px | 700 | Modal titles (MCP, config) |
| `t-13` | 13px | 700 / 600 | Brand wordmark, task-card title |
| `t-12.5`| 12.5px | 600 / 700 | Office card name, settings row label, character card name |
| `t-12` | 12px | 400/600/700| Nav items, agent row name, body value, tab labels, buttons |
| `t-11.5`| 11.5px | 400/600 | Meta, secondary buttons, chat body, list values |
| `t-11` | 11px | 400/500 | Mono code lines, small values |
| `t-10.5`| 10.5px | 400/500/600| Chips, small buttons, descriptions, mono badges |
| `t-10` | 10px | 400/700 | SECTION LABELS (uppercase, `letter-spacing:.11em`), gutter mono |
| `t-9.5` | 9.5px | 400/500/600| Tiny mono (ids, LIVE, timestamps, kbd hints) |
| `t-9` | 9px | 400/700 | Group-header path mono, avatar initials, checkbox glyph |

Letter-spacing: section labels `.11em`; group headers `.09em`; STATE mono `.06–.08em`;
big titles `-.01em` to `-.015em` (tight).

## 1.8 Spacing, radii, sizing

| Token | Value | Notes |
|---|---|---|
| Radius pill | `999px` | status pills, filter chips, toggles |
| Radius lg | `11px` | modals, top-level dialog cards |
| Radius `dv-card`| `9px` | outer screen card (mockup frame only) |
| Radius md | `8px` | cards, task cards, chat bubbles, composer, JSON box |
| Radius `7px` | `7px` | inputs, small panels, message bubble body |
| Radius sm | `6px` | buttons, nav items, list rows, badges |
| Radius `5px` | `5px` | chips, menu items, small toolbar buttons, avatar tiles |
| Radius xs | `4px` | tiny badges, brand square, folded-line tag |
| Radius `3px` | `3px` | checkbox square, throughput bars |
| Radius `2px` | `2px` | progress bars, segment ticks |
| Gap tight | `5–7px` | button clusters, chip rows |
| Gap base | `9–12px` | list rows, header clusters |
| Gap section | `14–18px` | stat tiles, form sections |
| Pad control | `6px 12px` | nav item / secondary button |
| Pad card | `10–14px × 11–18px` | panels & cards |
| Pad modal head | `15–16px 18–20px` | dialog header/body |

Structural dimensions (literal):

| Element | Value |
|---|---|
| Screen card width | `1280px` (2f is flex; 2g is `700px`) |
| Title bar height | `34px` |
| Nav (topbar) height | `46px` |
| Content height (2a, 2c, 2e) | `718px` / `700px` |
| Content height (2d) | `640px`; (2h) `660px` |
| **Agents rail width (2a)** | `262px` |
| Right inspector width (2a) | `308px` |
| Office rail width (2c) | `282px`; Office room col | `300px` |
| Sessions list width (2d) | `352px` |
| Settings nav width (2h) | `208px` |
| Detail sub-tab bar height | `38px` |
| Fleet/Sessions bottom bar | `30px` |
| ⌘K search box width | `210px` |
| Toolbar icon button | `24×24px`, radius 5 |
| Row `···` inline button | `18×18px`, radius 4 |
| Checkbox square | `13–15px`, radius 3–4 |
| Status dot | `6px` (rail/list), `5px` (inline meta) |
| Avatar square | `22×22px` radius 5 (chat/team); `20px` (office); office char tile `22px` |
| Toggle (switch) | `32×18px` (settings) / `26×15px` (Follow); knob `14px`/`11px`, bg `--bg-0` |
| Progress bar height | `3px` (inline/inspector), `4px` (office segment ticks) |
| Nav brand square | `16×16px` radius 4, `#4a9eff` |

---

# 2. Shared primitives catalog

Every screen is composed from these. Build once, reuse everywhere.

### `TitleBar`
34px, `--bg-topbar`, bottom border `--bd-nav`. Centered `"AutoDev"` label `11.5px --tx-5`,
`margin:0 auto`. (macOS traffic-light strip in production.)

### `TopNav`
46px, `--bg-topbar`, bottom border `--bd-nav`, `padding:0 14px`, `gap:6px`.
- **Brand:** 16px blue square + `"AutoDev"` `13px/700 --tx-hi`, `margin-right:16px`.
- **NavItem:** `padding:6px 12px`, radius 6, `12px`. Active = bg `--bg-selected`, `--tx-hi`, weight 600.
  Inactive = `--tx-3`, no bg. Items: Agents · Fleet · Office · Sessions (Settings floats right on 2h).
- **Right cluster** (`margin-left:auto`, gap 10): `CommandBar` (2a only) + `RunPill` + optional
  connection dot/badge. On 2c the right shows `app.pixeloffice.org` pill; on 2b/2c/2d only `RunPill`.

### `CommandBar` (⌘K)
`210px`, `padding:5px 10px`, radius 6, bg `--bg-input`, border `--bd-1`. Search glyph (12px, stroke
`#6c737e`) + `"Search or run a command"` `11.5px --tx-faint` + right `⌘K` mono `9.5px #565d67`.
Interaction: opens the command palette (fuzzy search agents + run commands). Present in TopNav on 2a
and as the sidebar filter on other screens.

### `RunPill`
`padding:5px 10px`, radius 6, bg `--bg-input`, border `--bd-1`, gap 7. Green 6px dot +
`"12 running"` mono `10.5px/500 --tx-2` + `·` `#3d434c` + `"2 need you"` mono `10.5px/500 --st-needsyou`.

### `StatusDot`
Circle. running `#46b17b`, needs-you `#d8a54a`, error `#e06a5c`, idle `#3d434c`. Sizes 5/6px.
Active/live variant adds glow: `box-shadow:0 0 0 3px rgba(70,177,123,.16)`.

### `StatusPill` / `StateBadge`
Rounded-999 pill: dot + mono uppercase label. WORKING/LIVE/STREAMING (green), ASKED YOU / RATE LIMIT
(amber), TIMED OUT / FAILING (red), IDLE (grey `--tx-4`). Soft bg = status@10–12%, border = status@28%.
Inline table variant (Fleet) is dot + mono label with no pill background.

### `Checkbox`
Square 13–15px, radius 3. Checked = bg `--accent`, glyph `✓` `--tx-onaccent` `9px/700`. Unchecked =
transparent, border `--bd-idle-box`. Partial/group states reuse checked fill.

### `Pill` / `Chip` (filter)
`padding:4px 9px`, radius 999, `10.5px`. Selected = bg `--bg-accent-soft`, border `--bd-accent`,
`--accent-ink`, weight 600. Idle = bg `--bg-input`, border `--bd-1`, `--tx-3`. Status filter chip uses
status tints (e.g. "Needs you 2" amber@10 bg / @30 border / amber text).

### `Button`
- **Primary:** bg `--accent`, `--tx-onaccent`, `11.5px/700`, `padding:7px 15px` (or `6px` compact), radius 6.
- **Secondary:** bg `--bg-input`, border `--bd-1`, `--tx-2`, weight 600, `padding:6px 12px`, radius 6.
- **Icon-only:** 24–34px square, bg `--bg-input`, border `--bd-1`, centered glyph.
- **Split `···`:** trailing 34px square secondary button beside a primary (New agent / New office).

### `IconButton` (toolbar)
`24×24px`, radius 5, bg `--bg-input`, border `--bd-icon-btn`, centered SVG. Used in bulk-select toolbar:
Start (green ▶), Stop (red square), Restart (circular-arrow), Add task (+), More (···), Clear (✕).

### `SectionLabel`
Uppercase `10px/700 --tx-4`, `letter-spacing:.11em`. Often followed by a mono count `--tx-ghost` and a
right-aligned blue link.

### `Card` / `Panel`
bg `--bg-panel`, border `--bd-nav` (or accent variants), radius 8. Selected/active variant adds
`box-shadow:inset 2px 0 0 #4a9eff` (left accent rail) and border `--bd-panel-sel`.

### `AgentRow` (rail, 2a)
`padding:7px 8px`, radius 6, gap 9. `[Checkbox 13px][StatusDot 6px][name 12px + mono meta 9.5px][tasks-left mono]`.
Selected row = bg `--bg-selected` + inset blue rail; its tasks-left number turns `--accent` and an inline
`···` (18px) appears. Idle rows dim name to `--tx-3`; meta line carries the state color (waiting=amber,
timed out=red, else ghost `grok · d271e`).

### `GroupHeader` (office folder, 2a)
`padding:9px 7px 7px`, gap 8. `[Checkbox 13px][▸ caret 9px][OFFICE NAME 10px/700 .09em + offices/path mono 9px][right: n/m mono + status dot 5px]`.
Caret rotated 90° when expanded.

### `Toolbar` (bulk-select, 2a)
`padding:8px 11px`, bg `--bg-sel-header`, bottom border `--bd-panel-sel`. `[✓ 14px accent][count mono
--accent-ink][right: 6 IconButtons]`.

### `ContextMenu`
Floating, bg `--bg-elev`, border `--bd-strong`, radius 9, `box-shadow:0 18px 44px rgba(0,0,0,.6)`,
`padding:5px`. Header row = agent id mono `9px --tx-ghost .06em`. Items: `padding:6px 9px`, radius 5,
gap 9, 12px SVG + label `11.5px`. Hover/active item = bg `--bg-accent-soft`, `--tx-hi`, optional right
kbd hint (`⌘⏎`). Separators = 1px `--bd-card`, `margin:5px 4px`. Destructive items use `--st-error`.
Items (2a): Open agent folder · Open in editor · Open terminal here · Copy path — / — Stop loop ·
Restart · Watch live session · Connect to office… · Setup… — / — Duplicate agent · Remove…

### `Composer` (input dock)
bg `--bg-panel`, border `--bd-1`, radius 8, `padding:9px 12px`, gap 10. Leading glyph, placeholder
`12px --tx-faint`, trailing kbd hint mono or a Send primary. Variants: TODO add (`⏎ add · ⇧⏎ newline`),
office message (`⚡`), room message (`@name /task`), session interject.

### `LogRow` (parsed activity)
gap 12, `padding:6px 0`. `[timestamp mono 10px --tx-gutter width 42px][severity glyph width 14px]
[body flex]`. Severity glyphs: `⚙` gear info `--tx-dim`; `!` error `--st-error`; `✉` mail `--role-violet`.
Body may embed a **FoldedLines tag** — `5 lines folded ▾` mono `10px --tx-ghost`, bg `--bg-input`,
border `--bd-1`, `padding:1px 6px`, radius 4 — the folded MCP-summary row. Inline `Fix…` / `show full
message` links in `--accent`.

### `TaskCard` (in-activity)
bg `--bg-sidebar`, border `--bd-card`, radius 8, `padding:12px 14px`, gap 10. Header: spinner glyph
`◑ --accent` + title `13px/600 --tx-hi` + right time range mono `--tx-dim`. Body: mono action lines
(`✎` violet write w/ +add/−del, `↳` dim read, `✓` green build, waiting w/ cursor) indented 21px.
Footer: 3px progress bar (`--accent` fill on `--st-track-bg`) + `14:03 / 30:00 timeout` mono.

### `TaskDivider`
`[hairline]—TASK 3 OF 8 · 14 MIN—[hairline]` centered mono `9.5px --tx-ghost .08em`, lines `--bd-2`.

### `InboundMessageCard`
Left-accent quote: bg `--bg-sidebar`, border `--bd-card`, `border-left:2px solid #9a86e8`, radius 6,
`padding:9px 11px`. Quoted text `11.5px/1.6 --tx-3`; footer divider + mono `appended to TODO.md line 7`
+ blue `show full message`.

### `ChatBubble`
Avatar square 22px (role-colored) + bubble bg `--bg-panel` border `--bd-nav` radius 8 with
`border-top-left-radius:2px` (or top-right for own msgs). Own message bubble = bg `#1e2a3a`, border
`#2a3646`, text `--accent-ink2`, right-aligned (`row-reverse`). Timestamp mono `9.5px --tx-ghost`.
Typing indicator = 3 pulsing 5px dots. May carry mono tool-line block beneath.

### `TodoList` (inspector)
Rows `padding:5px 6px`, gap 9. `[glyph 11px][text 11.5px/1.4]`. In-progress `◑ --accent` + text
`--tx-hi/600`, active row bg `--bg-todo-active`. Pending `○ --tx-faint` + `--tx-2`. Done `✓ --st-running`
+ strikethrough `--tx-dim` (`text-decoration-color:#3d434c`). Header: `TODO.MD` + `3 / 8` mono +
`Open file` link; 3px progress bar under it.

### `KeyValueRow` (setup / list)
`[label --tx-dim width 74px][value --tx-1]`, `11.5px`, gap 10. Value may carry status suffix
(`5 servers · 1 issue` with red suffix).

### `Toggle` / `Slider`
Toggle 32×18px pill, on = `--accent`, knob 14px `--bg-0`. Slider: 3px track `#252b34`, `--accent` fill,
13px white thumb w/ 2px `--bg-0` ring.

### `Dropdown`
bg `--bg-input`, border `--bd-1`, radius 7, `padding:8px 11px`, value `12px --tx-hi` + right chevron
(8×5 SVG, stroke `#8b929c`).

### `SegmentedControl`
Row of equal buttons radius 6. Selected segment = bg `--bg-accent-soft`, border `--bd-accent`,
`--accent-ink`, weight 600; others = bg `--bg-input`, border `--bd-1`, `--tx-3`.
(Provider: Interactive | Headless CLI | SDK · API key.)

### `Modal` / `Dialog`
bg `--bg-panel`, border `--bd-strong`, radius 11, `box-shadow:0 24px 60px rgba(0,0,0,.6)`. Header
(border-bottom `--bd-card`): title + subtitle + right `✕`. Body `padding:15–16px 18–20px`, gap 14.
Footer (border-top `--bd-card`): left mono hint + right button cluster (Cancel secondary + primary).
Scrim behind = `rgba(8,10,13,.62)`.

### `StatTile` (Fleet)
bg `--bg-panel`, border `--bd-nav` (or status-tinted), radius 9, `padding:13px 15px`. SectionLabel +
content. Variants: NEEDS YOU (amber border, mini alert list), THROUGHPUT (10-bar sparkline, last 3 bars
`--accent`, rest `#2a3646`), PROVIDERS (label/count rows).

### `DataTableRow` (Fleet)
`padding:10px 12px`, gap 14, bottom border `--bd-row`. Columns: checkbox 14 · AGENT 190 · OFFICE 130 ·
STATE 110 · CURRENT TASK flex(ellipsis) · TASKS 88 (mini 34px bar + `5/8` mono) · ELAPSED 78 · action 60.
Attention rows get a status wash (amber@5 / red@5). Header row mono `9.5px .1em --tx-dim`.

### `StatusBarBottom`
30px, `--bg-topbar`, top border `--bd-nav`, mono `10.5px --tx-dim`, `padding:0 22px`. Left = selection
count `--accent-ink` + bulk verbs; right = `showing 8 of 29`.

---

# 3. Screens

Common frame for full-window screens (2a,2b,2c,2d,2e,2h): `TitleBar(34)` → `TopNav(46)` → content.
`2f` and `2g` are card compositions on `--bg-app`/`#0b0d11` with no window chrome.

---

## 3.1 — 2a · Agent detail (replaces Overview + Output + Todo tabs)

Width 1280, content height 718. Three columns: **Agents rail (262)** | **detail center (flex)** |
**inspector (308)**.

```
┌───────────────────────── TitleBar 34 ─────────────────────────┐
├──────────── TopNav 46 · Agents|Fleet|Office|Sessions · ⌘K · RunPill · ◎ ┤
├─────────262 rail────────┬────────── detail center (flex) ──────────┬───308 inspector───┐
│ Filter 29 agents (⌘K)   │ balance-analyst  ●WORKING  14m in task    │ TODO.MD    3/8    │
│ [All29][Running12][Need2]│ 📁~/…/balance-analyst-d271e ↗ · grok — … │ ▓▓▓�automations   │
│ Group by [Office ▾] Sel..│ · office connected  [Stop][Restart][Open]│ ◑ Rebuild 8 …     │
│ ┌ bulk toolbar (7) ▶■↻+⋯✕│──────────── sub-tabs 38 ────────────────│ ○ Dual path…      │
│ ▸✓ FAMOUS FIGHTERS 7/12 ●│ Activity | Chat | Terminal  Follow● Raw │ ✓ Audit… (struck)  │
│  ✓● art-director grok·  3│ 11:29 ⚙ Loop started · TODO …            │───────────────────│
│  ✓● balance-analyst  «5» │ 11:29 ⚙ MCP applied  [5 lines folded ▾]  │ SESSION  All ↗    │
│  ✓● game-director amber 2│ 11:29 ! Email poller not started  Fix…   │ ● grok-7f5df LIVE │
│  ✓● lead-programmer   7  │ ——— TASK 3 OF 8 · 14 MIN ———             │ 17,691 · resumed  │
│  ✓○ level-designer idle  │ ┌ TaskCard ◑ Rebuild silhouettes 14:02→ │ [Watch][New sess] │
│  ✓● live-ops 1           │ │ ✎ wrote … +142 −18                     │───────────────────│
│  ✓● monetization red 4   │ │ ↳ read sprites · ✓ bundle 3.1s         │ SETUP      Edit…  │
│  ☐○ narrative-writer     │ │ ▓▓▓▓ 47%   14:03/30:00 timeout         │ Provider Grok—int │
│ ▸☐ AI SALES 0/5 ●        │ └                                        │ Model  default    │
│ ▸☐ BACKEND REWRITE 0/12 ▲│ 11:38 ✉ Task from project-manager        │ Office Famous fi. │
│ ▸☐ NO OFFICE 0/2         │  └ quote card (violet left rail)         │ MCP 5 · 1 issue   │
│─────────────────────────│──────── Composer: + Add task / …  ⏎ add ─│ Files browser off │
│ [ New agent ][···]      │                                          │                   │
└─────────────────────────┴──────────────────────────────────────────┴───────────────────┘
```

**Component tree**
- `Rail(262, --bg-sidebar, border-right --bd-nav)`
  - `FilterHeader` (padding 11 12 9, border-bottom): `CommandBar`("Filter 29 agents") → `Pill`×3
    (All 29 selected / Running 12 / Needs you 2 amber) → `GroupByControl` (label + dropdown "Office
    folder" + right `Select all 29` link `--accent`).
  - `Toolbar` (bulk-select, shown when ≥1 checked): count `7` + IconButton×6.
  - `List(flex, overflow, padding 4 6 0)`:
    - `GroupHeader` FAMOUS FIGHTERS (checkbox, caret▸ rotated, name+path, `7/12`+green dot).
    - `AgentRow`×8 (see states below). Selected = balance-analyst (bg `--bg-selected`, inset rail,
      tasks `5` blue, inline `···`).
    - `GroupHeader` AI SALES `0/5` green · BACKEND REWRITE `0/12` amber · NO OFFICE `0/2`.
  - `RailFooter` (border-top, padding 10 12): primary `New agent` + `···` split.
  - `ContextMenu` (absolute, left 212 top 262) — see primitive; the 2a menu content.
- `DetailCenter(flex, --bg-0)`
  - `DetailHeader` (padding 14 18 12, border-bottom `--bd-2`): name `16/700` + WORKING pill +
    `14m in task` mono; second line = **PathChip** (folder icon + dim base path ellipsized + bright
    `balance-analyst-d271e` + blue open-external icon, max-width 392) · `grok — interactive` ·
    `office connected` green. Right cluster: `Stop`,`Restart`,`Open folder` secondary + `···`.
  - `SubTabBar(38, border-bottom)`: Activity (active, `inset 0 -2px 0 #4a9eff`) · Chat · Terminal;
    right = `Follow` toggle (26×15, on) + `Raw log`.
  - `ActivityStream(flex, padding 12 18, font 12)`: `LogRow`×3 → `TaskDivider` → `TaskCard` →
    `LogRow`(✉) with `InboundMessageCard`.
  - `Composer` (border-top): `+ Add a task to TODO.md — or type / for commands`, right `⏎ add · ⇧⏎ newline`.
- `Inspector(308, --bg-1)` — three stacked sections divided by `--bd-2`:
  - `TodoSection` (padding 13 15 11): header `TODO.MD` + `3/8` + `Open file`; 3px bar 37%; `TodoList` 7 rows.
  - `SessionSection`: label `SESSION` + `All sessions` link; a session card (green dot + `grok-7f5dfec08a`
    + `LIVE`; `17,691 tokens sent` / `resumed 11:39`; two half-buttons `Watch live` / `New session`).
  - `SetupSection`: label `SETUP` + `Edit…`; `KeyValueRow`×5 (Provider/Model/Office/MCP/Files); MCP value
    carries red `· 1 issue`.

**Exact agent-row states (top→bottom):** art-director green/`3`; balance-analyst **selected** green-glow
/`5` blue/`···`; game-director amber meta="waiting on you"/`2`; lead-programmer green/`7`;
level-designer idle grey, name dim, meta="idle · all done", no count; live-ops green/`1`;
monetization-lead red meta="timed out · retry 2/2"/`4`; narrative-writer **unchecked**, idle grey.

**Interaction notes**
- **⌘K command bar** (TopNav) opens command palette; the rail's own field filters the 29 list live.
- **Right-click any agent row / the `···`** opens `ContextMenu` at cursor. `⌘⏎` = Open agent folder.
- **Bulk select:** checking rows/headers reveals `Toolbar`; header checkbox selects the whole office;
  `Select all 29` selects everything; group tri-state.
- **Folded MCP log:** the `5 lines folded ▾` tag expands the repeated MCP lines inline on click.
- **`Fix…` / `show full message`** are inline blue affordances (jump to MCP editor / expand quote).
- **Fixed inspector** never scrolls with the activity stream; Follow toggle auto-scrolls the stream.
- Sub-tabs Chat/Terminal swap the center pane (rendered separately as 2f).

---

## 3.2 — 2b · Fleet (triage 29 agents at once — new)

Width 1280. Frame → summary band (`--bg-0`, padding 18 22 0) → table → `StatusBarBottom(30)`.
TopNav right = RunPill only.

```
├── TopNav (Fleet active) ······················· RunPill ─┤
│ Fleet                                    [Start all idle][Stop all] │
│ 29 agents · 3 offices · 118 open · 37 closed today                  │
│ ┌ NEEDS YOU·2 (amber border) ┐┌ THROUGHPUT·24H ┐┌ PROVIDERS ┐       │
│ │ ● monetization timed out Retry ││ ▁▂▂▄▅▃▅█▇▅ ││ grok 21   │       │
│ │ ● game-director asked  Answer ││ 37 closed  ││ claude 5  │       │
│ └───────────────(flex)──────────┘└──224──────┘└──224─────┘        │
│ ☐ AGENT190  OFFICE130 STATE110  CURRENT TASK(flex)  TASKS88 ELAP78 ·│
│ ✓ art-director  Famous… ●WORKING  Rebuild 8 …      ▓62% 5/8  14m  ⋯│
│ ✓ balance-analyst        ●WORKING  Tune damage…    ▓37% 3/8  14m  ⋯│
│ ☐ game-director  (amber wash) ●ASKED YOU "Ship A…" ▓80% 8/10 6m Ans│
│ ☐ lead-programmer        ●WORKING  Wire edit-…     ▓22% 2/9  3m   ⋯│
│ ☐ monetization  (red wash) ●TIMED OUT never [x]    ▓44% 4/9 30m Rtr│
│ ☐ level-designer         ●IDLE     TODO empty…     ░100%0/6  —  Add│
│ ☐ api-gateway   Backend  ●RATE LIMIT sleep 21:14   ▓50% 6/12 2h41 ⋯│
│ ☐ outreach-writer AI sales ●WORKING Draft seq B    ▓75% 6/8  22m  ⋯│
├ 2 selected  Start Stop Switch provider… Add task…     showing 8/29 ┤
```

**Component tree**
- `FleetHeader`: title `Fleet 18/700` + subtitle mono `29 agents across 3 offices · 118 tasks open ·
  37 closed today`; right `Start all idle` / `Stop all` secondary.
- `StatTileRow` (gap 12, margin-bottom 18): `StatTile`NEEDS YOU (flex, amber border, 2 alert rows each
  = dot + name + reason + right blue action Retry/Answer) · `StatTile`THROUGHPUT (224, 10-bar sparkline,
  last 3 `--accent`) · `StatTile`PROVIDERS (224, 4 label/count rows).
- `DataTable` (`--bg-0`, padding 0 22 20): header row (mono labels) + `DataTableRow`×8.
- `StatusBarBottom`: `2 selected` + Start/Stop/Switch provider…/Add task to all… + `showing 8 of 29`.

**Interaction notes**
- Rows needing attention are washed (amber@5 / red@5) and end in a blue verb (`Answer`/`Retry`/`Add task`)
  instead of `···`.
- Selecting rows updates the bottom bulk bar; `Switch provider…` opens a provider picker for the selection.
- TASKS cell = 34px mini progress (status-colored fill) + `n/m` mono; idle uses full grey `#2f353e` track.
- ELAPSED colored by state (`--tx-5` normal, amber "6m idle", red "30m", ghost "—").

---

## 3.3 — 2c · Office (one stream at a time, not three columns)

Width 1280, height 718, `--bg-0`. **Office rail (282)** | **office detail (flex)**. TopNav right =
`app.pixeloffice.org` connection pill.

```
├ TopNav (Office active) ················· ● app.pixeloffice.org ─┤
│ 282 rail                    │ Famous fighters  12 chars·8 conn·3:30 [Connect all][Open browser]│
│ Offices                     │ ┌──── character grid 4-col (gap10) ────────────────────────────┐│
│ Run a character as agent    │ │ ▣ Art Director grok-tui ●  │ Game Director ● amber │ Sound … ││
│ [ New office ][↻]           │ │ building walk/jump chains  │ asked you a question  │ …       ││
│ ┌ Famous fighters (sel)    ┐│ │ Project Manager claude ●   │ Level Designer(dim) Connect&op ││
│ │ 8/12 LIVE  ▓▓▓▓▓▓▒▓░░░░  ││ │ Live Ops (dim) Connect     │ Monetization(dim)  │ +5 more    ││
│ │ [Stop office][Open map]  ││ └───────────────────────────────────────────────────────────────┘│
│ └──────────────────────────┘│ ┌ Art Director stream (flex, border-right) ┬ OFFICE ROOM 300 ──┐│
│ ┌ AI sales 0/5 [Spawn]     ┐│ │ ▣ Art Director  offices/…-9f68d          │ #famous-fighters     ││
│ ┌ Backend rewrite 2/12     ┐│ │  [read-only][Open agent]                 │ Project Manager 11:38││
│ │ [Connect remaining 10]   ││ │ 11:38 Received task from Project Manager │  ART_QUALITY shipped ││
│ └──────────────────────────┘│ 11:39 Session grok-7f5df launched WAL    │ Art Director 11:39   ││
│                             │ 11:40 ✎ Inspecting idle sprites…         │  On it. Rejecting…   ││
│                             │ 11:42 ✓ 3 of 8 pass identity check       │ Game Director 11:41  ││
│                             │ 11:44 Working…▮                          │  Ship A or hold?     ││
│                             │─ Composer ⚡ Message Art Director…    ⏎ ─│  [Ship A][Hold U1.1] ││
│                             │                                          │ you 11:43 @art-dir…  ││
│                             │                                          │─ Message the room… ──││
```

**Component tree**
- `OfficeRail(282, border-right --bd-2)`:
  - Header (padding 15 15 12, border-bottom): `Offices 15/700` + subtitle + `New office` primary + `↻` icon.
  - `OfficeCard`×3 (padding 11 12, radius 8): name + status badge (`8/12 LIVE` green pill /
    `0/5 LIVE` grey / `2/12 LIVE` amber). **SegmentTicks** = one 4px bar per character
    (green=live, amber=needs-you, grey `#2f353e`=not connected). Footer half-buttons
    (Stop office/Open map · Spawn office · Connect remaining 10). Selected card = accent border +
    inset blue rail.
- `OfficeDetail(flex)`:
  - Header: office name `15/700` + mono `12 characters · 8 connected · uptime 3:30` + right
    `Connect all` / `Open in browser`.
  - `CharacterGrid` (`grid-template-columns:repeat(4,1fr)`, gap 10, border-bottom): `CharacterCard`
    (22px avatar tile + name `11.5/600` + provider mono `grok-tui`/`claude-tui` + status dot; subtitle
    = current activity or amber "asked you a question"). **Disconnected cards** dashed avatar border,
    `opacity:.55`, blue `Connect & operate` CTA. Last tile = dashed `+ 5 more / show all`.
    Connected+selected card has inset accent ring `inset 0 0 0 1px rgba(74,158,255,.12)`.
  - Split lower area: **AgentStream(flex, border-right)** + **OfficeRoom(300, --bg-1)**.
    - Stream header: avatar + name + agent path mono + `read-only` mono chip + `Open agent`.
      Stream body = timeline rows `[time mono 38][body]`, severity-colored (violet ✎, green ✓, cursor).
      Composer `⚡ Message Art Director in the office…  ⏎`.
    - OfficeRoom: label `OFFICE ROOM · #famous-fighters`. Chat entries = colored author name
      (violet/blue/peach/`you`=`#c3b6f0`) + mono time + line. Game Director's message carries inline
      decision buttons `Ship A` (primary) / `Hold U1.1` (secondary). Composer `Message the room…
      @name /task`.

**Interaction notes**
- Selecting an office in the rail swaps the whole detail; selecting a character focuses its stream.
- **One stream at a time** — the design explicitly replaces 3 simultaneously-scrolling columns; only the
  focused agent's stream + the shared room scroll.
- Character stream is **read-only** unless you `Open agent` (jumps to 2a) or `Take over`.
- Decision buttons in the room post an answer back to the asking agent (clears its ASKED YOU state).

---

## 3.4 — 2d · Sessions (grouped, named, never a wall of "(untitled)")

Width 1280, height 640, `--bg-0`. **Session list (352)** | **transcript (flex)**. TopNav has no right cluster.

```
├ TopNav (Sessions active) ┤
│ 352 list                            │ transcript (flex)                                   │
│ Sessions  127·1 live  [New session] │ Rebuild 8 hero silhouettes ●STREAMING  [Resume][Export]│
│ 🔍 Search prompts and output        │ grok-7f5df · art-director-9f68d · started 11:39      │
│ [All127][grok82][claude26][oc12]…   │ ┌PM┐ Rebuild all 8 heroes with props… 16-col CPS2    │
│ LIVE NOW                            │ ┌AD┐ Marking in progress, loading brief…             │
│ ●▎Rebuild 8 hero silhouettes  LIVE  │      ✎ Write ART_QUALITY_V2 +142 −18                │
│   art-director·grok·38s·17.7k       │      ↳ Read sprites/*.png · 8   ✓ Bundle 3.1s        │
│ EARLIER TODAY  42                   │ ┌AD┐ 3 of 8 pass the identity check ▮               │
│ ○ Read task file, execute TODO      │                                                     │
│ ○ Balance pass on damage curves     │                                                     │
│ ○ Complete TODO — edit-chain wiring │                                                     │
│ ┌ 31 runs of same poller  expand ┐  │                                                     │
│ YESTERDAY  38                       │                                                     │
│ ○ Recolor-template experiment       │─ Interject in this session… ────────────────────────│
```

**Component tree**
- `SessionList(352, border-right)`:
  - Header: `Sessions 15/700` + mono `127 · 1 live` + `New session` primary; `SearchInput`
    ("Search prompts and output"); provider `Pill` row (All 127 selected / grok 82 / claude 26 /
    opencode 12 / copilot 7).
  - `SessionGroups`: `SectionLabel` `LIVE NOW` → live `SessionRow` (selected: bg `--bg-selected` +
    inset rail; green dot; title `12/600`; mono `art-director · grok · 38s ago · 17.7k tokens`; right
    `LIVE`). `SectionLabel` `EARLIER TODAY` + count `42` → 3 grey-dot rows → **FoldGroupRow** (dashed
    `--bd`, `31 runs of the same task-poller prompt` + blue `expand`). `SectionLabel` `YESTERDAY` `38`
    → row.
- `Transcript(flex)`:
  - Header: title `14.5/700` + STREAMING pill; sub mono `grok-7f5dfec08a · art-director-9f68d ·
    started 11:39`; right `Resume here` / `Export trace`.
  - Body: `ChatBubble` PM (avatar `PM` violet) → AD (avatar `AD` blue) with mono tool-line block →
    AD streaming bubble with cursor.
  - Footer `Composer`: `Interject in this session…`.

**Interaction notes**
- **Named, not "(untitled)":** each session shows the task title as the row headline; the id lives only
  in the dim mono meta.
- **Folded duplicate runs:** the `31 runs of the same task-poller prompt` row collapses identical
  repeated sessions; `expand` unfolds them.
- Search filters across prompts + output; provider chips filter the list; selecting a row loads its
  transcript. `Resume here` starts a new session seeded from this one.

---

## 3.5 — 2e · Spawn a team + agent-config modal

Width 1280, height 700. Base = dimmed Agents screen (`--bg-0` + scrim `rgba(8,10,13,.62)`) with **two
overlapping modals** demonstrated: the **Spawn-team** dialog (left, 600) and the **agent-Setup** modal
(right, 492). In production these are separate flows; shown together to spec both.

**Spawn a team modal** (`left:44 top:38 width:600`)
```
┌ Spawn a team ─────────────────────────────────────┐
│ Describe the work — AutoDev proposes roles…       │
├───────────────────────────────────────────────────┤
│ WHAT ARE YOU BUILDING?                             │
│ [ A 2D fighting game with 8 heroes, CPS2 pixel… ] │
│ TEAM SIZE [4 ▲▼]   DEFAULT PROVIDER [Grok—inter ▾]│
│ [✓] Put them in an office                        ▾│
│     Famous fighters — 12 characters               │
│ ─────────────────────────────────────────────────│
│ PROPOSED TEAM  edit any row            Regenerate │
│ ▣ art-director   silhouettes, palette…    [grok]  │
│ ▣ balance-analyst damage curves, matrix   [grok]  │
│ ▣ lead-programmer engine, edit-chains     [claude]│
│ ▣ live-ops-manager event calendar         [grok]  │
├───────────────────────────────────────────────────┤
│ creates 4 folders under …/famous-fighters [Cancel][Spawn & run]│
└───────────────────────────────────────────────────┘
```
- Header title+subtitle. Body: `SectionLabel` + read-only prompt box (bg `--bg-input`); a
  TEAM SIZE stepper (132, mono `4` + `▲▼`) + DEFAULT PROVIDER dropdown; a checkbox card
  "Put them in an office" (checked, subtitle + chevron). Divider. PROPOSED TEAM header (label +
  mono `edit any row` + blue `Regenerate`). `TeamRow`×4 = avatar tile + name `12/600` + role
  description `10.5 --tx-5` + provider badge (grok neutral `#171b21`/`--bd-1`; claude blue
  `#22303f`/`--bd-accent`/`--accent-ink`). Footer: mono creation note + `Cancel` + `Spawn & run` primary.

**Agent Setup modal** (`right:44 top:96 width:492`)
```
┌ balance-analyst · setup ················· ✕ ┐
│ changes apply to the next task              │
├─────────────────────────────────────────────┤
│ PROVIDER [Interactive|Headless CLI|SDK·API]│
│  Interactive gives a terminal you can watch │
│ ENGINE [Grok ▾]        MODEL [provider def] │
│ TASK TIMEOUT ●──────── 30 min               │
│  [✓] Retry once on timeout, then ask me     │
│ [ ] Enable file browser                     │
│     lets the office browse & edit files     │
│ ─────────────────────────────────────────── │
│ MCP servers  5 configured · zerolib missing │
│                              [Edit .mcp.json]│
├──────────────────────── [Cancel][Save] ─────┤
```
- Header: `balance-analyst · setup 14/700` + mono `changes apply to the next task` + `✕`.
- Body: `SegmentedControl` PROVIDER (Interactive selected) + helper text; ENGINE dropdown + MODEL
  field row; TASK TIMEOUT `Slider` (44%, `30 min`) + checkbox "Retry once on timeout, then ask me";
  checkbox "Enable file browser" (unchecked) + subtitle; divider; MCP row (label + mono
  `5 configured · zerolib-email missing` red + `Edit .mcp.json` secondary).
- Footer: right-aligned `Cancel` + `Save` primary.

**Interaction notes**
- Config is a **modal, not a tab** — the whole thesis of demoting rarely-edited config.
- `Regenerate` re-proposes roles from the prompt; each team row's name/provider is inline-editable.
- Provider segmented control switches ENGINE/MODEL affordances; `Edit .mcp.json` opens 2g.
- Both dialogs Save/Spawn apply on the **next task**, never mid-run.

---

## 3.6 — 2f · Chat & Terminal (the other two agent sub-tabs)

Card composition on `--bg-app #0b0d11`, `padding 20`, two side-by-side panels each `flex`, height 600,
border `--bd-nav`, radius 8. Each shows the SubTabBar (Activity | Chat | Terminal) with the respective
tab active.

**Chat panel**
```
┌ Activity  [Chat]  Terminal ······· grok-7f5df ● ┐
│ ——— TASK 3 · 11:39 ———                          │
│ ┌BA┐ Damage curves done 6/8. Ravi spikes…  11:52│
│           Leave Ravi. Fix Odile… 11:54·you ┌PZ┐ │  ← own bubble, row-reverse, #1e2a3a
│ ┌BA┐ Understood — patching Odile now.           │
│      ✎ curves.json +11 −4  ✓ sim 10k 49.2%      │
│ ——— ↳ APPENDED TO TODO.MD · LINE 9 ———          │
│ ┌BA┐ ●●●  (typing)                              │
├─ /task /pause /context /switch grok→claude ─────│
│ [ Reply to balance-analyst… ]          [Send]   │
```
- `SubTabBar` (Chat active) + right session id mono + green dot.
- Message stream: `TaskDivider` → `ChatBubble` (avatar `BA` blue) → **own** `ChatBubble`
  (`row-reverse`, avatar `PZ` violet, bubble `#1e2a3a`/`--accent-ink2`, footer `11:54 · you`) →
  agent bubble with mono tool-line block → `TaskDivider` (`↳ APPENDED TO TODO.MD · LINE 9`) →
  typing-indicator bubble (3 pulsing dots).
- Footer: **slash-command chip row** (`/task` `/pause` `/context` `/switch grok→claude`) + Composer
  (`Reply to balance-analyst…` + `Send` primary).

**Terminal panel**
```
┌ Activity Chat [Terminal] ···· READ-ONLY [Take over]┐
│ tmux grok-7f5df · ~/…/balance-analyst-d271e   96×34│
│ ▐ grok interactive · model account default         │
│ ❯ read TODO.md, take the first unchecked task       │
│ Reading TODO.md … 8 tasks, 3 done                   │
│ Task: Tune damage curves for the dual-path roster   │
│ ┌ tool · read_file                                  │
│ │ balance/curves.json        412 lines              │
│ └ ok 0.2s                                           │
│ ┌ tool · bash  │ node sim/run.js --matches 10000    │
│ │ Ravi 61.4% Odile 43.8% Kwan 50.1%   └ ok 14.6s    │
│ ✓ curves.json patched · re-sim Odile 49.2%          │
│ ❯ ▮                                                 │
├ [ Take over to type into this session… ] ⌃C stops──│
```
- `SubTabBar` (Terminal active) + right `READ-ONLY` amber mono chip + `Take over` secondary.
- **tmux info bar** (border-bottom): `tmux grok-7f5dfec08a` `--tx-3` · `·` · agent path · right `96×34`.
- Terminal body: mono `11.5px/1.75`. `❯` prompt green, user text `--tx-1`, model prose `--tx-4`,
  tool blocks framed with `┌│└` `--tx-dim` (`ok` durations green), `✓` success green, violet filenames,
  blinking cursor block `#8b929c`.
- Footer: read-only input `Take over to type into this session…` + mono `⌃C stops the loop`.

**Interaction notes**
- Chat is conversational (your messages appended to TODO.md — note the divider announcing the line);
  slash-commands drive the loop.
- Terminal is **read-only by default**; `Take over` grabs the tmux session for direct typing; `⌃C`
  stops the loop. These are the two non-Activity states of the 2a center pane.

---

## 3.7 — 2g · MCP editor (status first, JSON second)

Card `width 700`, `padding 26`, on `#0b0d11`. Single centered `Modal` (radius 11, big shadow).

```
┌ MCP servers ··················· [Recheck] ✕ ┐
│ balance-analyst-d271e/.mcp.json · applies next task │
├─────────────────────────────────────────────────────┤
│ CONNECTIVITY  4 ready · 1 failing        ＋ Add server│
│ ● computer-use-mcp  [stdio] npx -y computer-use…  ready ⋯│
│ ● memory            [stdio] npx -y …server-memory ready ⋯│
│ ┌ red-wash group ─────────────────────────────────────┐│
│ │ ✗ pixel-office [stdio] autodev mcp-operate .  failing⋯││
│ │ ┌ Runner `autodev` not on PATH ─ [Install CLI][Set…]┐││
│ │ │ Office bridge can't start — won't answer messages ││││
│ └───────────────────────────────────────────────────┘│
│ ● playwright        [stdio] npx -y @playwright/mcp ready ⋯│
│ ● sequential-thinking [stdio] npx -y …sequential… ready ⋯│
│ RAW .MCP.JSON  ● valid          Format  Open in editor │
│ ┌ 1 {  2 "mcpServers": {                              ┐│
│ │▎3 "pixel-office": {   ← red gutter+rail             ││
│ │ 4 "command": "autodev",                             ││
│ │ 5 "args": ["mcp-operate","."],                      ││
│ │ 6 "alwaysLoad": true   7 },  8 "memory": {…}         ││
│ │ line 3 · runner not resolvable      json · 24 lines ││
│ └─────────────────────────────────────────────────────┘│
├ shared with: 12 agents in this office [Cancel][Save & recheck]│
```

**Component tree**
- `Modal` header: `MCP servers 14/700` + mono `balance-analyst-d271e/.mcp.json · applies on next task`;
  right `Recheck` secondary + `✕`.
- `ConnectivitySection` (padding 14 18 6): `SectionLabel` `CONNECTIVITY` + mono `4 ready · 1 failing`
  + right `＋ Add server` link.
- `ServerRow`×5 (padding 9 10, radius 6, gap 11): `StatusDot 6px` + name `12/600` width 150 + transport
  badge (`stdio` mono `9.5px` chip) + command mono `10.5px --tx-dim` flex/ellipsis + state mono
  (`ready` green / `failing` red) + `···`. The **failing row** is wrapped in a red-wash container
  (`rgba(224,106,92,.06)` bg, `.26` border) whose glyph is `✗` red, and carries an inline **error panel**
  (bg `--bg-panel-alt`): bold `Runner autodev is not on PATH` `--st-error-bright #f0b3aa` + explanation +
  `Install CLI` primary + `Set path…` secondary.
- `RawJsonSection`: label `RAW .MCP.JSON` + green `● valid` + right `Format` / `Open in editor`.
  `CodeBlock` (bg `--bg-0`, border `--bd-card`, radius 8): line-numbered mono; **line 3 highlighted**
  with red gutter number, red left rail (`inset 2px 0 0 #e06a5c`), red-wash bg. Syntax colors per §1.6.
  Footer strip: red `line 3 · runner not resolvable on this machine` + right `json · 24 lines`.
- Footer: mono `shared with: 12 agents in this office` + `Cancel` + `Save & recheck` primary.

**Interaction notes**
- **Status first, JSON second** — connectivity list on top, raw JSON below; you rarely touch the JSON.
- Failing server surfaces the actionable fix inline (`Install CLI` / `Set path…`) rather than a stack trace.
- The JSON editor **cross-highlights** the offending line (red gutter + rail + footer message) matching
  the failing server.
- `Save & recheck` writes `.mcp.json` and re-runs connectivity; changes apply on the agent's next task;
  edits are shared with all 12 office agents (noted in footer).
- Server-row `···` = per-server menu (edit / duplicate / remove / recheck one).

---

## 3.8 — 2h · Settings (one page, sectioned, real defaults)

Width 1280, height 660, `--bg-0`. **Settings nav (208)** | **content (flex)**. Settings sits in the
TopNav's right slot (active pill), not the main nav group.

```
├ TopNav  Agents Fleet Office Sessions ········· [Settings] ┤
│ 208 nav             │ Agent defaults                              │
│ SETTINGS            │ Applied to every new agent. Override in setup.│
│ ▸ Agent defaults    │ Provider            [ Grok — interactive ▾]  │
│   Providers         │  Interactive gives a terminal…               │
│   Pixel Office      │ Task timeout        ●──────── 30 min         │
│   MCP               │ Retry on timeout                    [ ●on ]  │
│   Notifications     │ Fall back on rate limit [Claude—interactive▾]│
│   Storage & logs    │ Agents folder   [~/.autodev-app/offices][Br]│
│   About             │ Keep loops running when window closes [ ●on ]│
│                     │ ┌ Pixel Office ······· ● connected·3 offices┐│
│ autodev-app 2.0.4   │ │ SERVER URL [https://app.pixeloffice.org]  ││
│ cli 1.4.125         │ │            [Reset][Save]                   ││
│                     │ │ https only — http allowed for localhost…  ││
└─────────────────────┴───────────────────────────────────────────────┘
```

**Component tree**
- `SettingsNav(208, border-right, padding 16 10)`: label `SETTINGS`; nav items (Agent defaults active
  = bg `--bg-selected`/`--tx-hi`/600; rest `--tx-3`): Agent defaults · Providers · Pixel Office · MCP ·
  Notifications · Storage & logs · About. Footer (margin-top:auto) mono version block
  `autodev-app 2.0.4 / cli 1.4.125` `9.5px --tx-ghost`.
- `SettingsContent(flex, padding 22 26, max-width 660)`:
  - Title `Agent defaults 18/700` + subtitle.
  - `SettingRow`×6 (padding 14 0, border-bottom `--bd-2`, gap 18): left `[label 12.5/600 + description
    11px --tx-5]`, right control fixed 210: **Provider** dropdown · **Task timeout** slider (44%, 30 min)
    · **Retry on timeout** toggle (on) · **Fall back to another provider on rate limit** dropdown
    (Claude — interactive) · **Agents folder** mono field + `Browse` · **Keep loops running when window
    closes** toggle (on, last row no border).
  - `PixelOfficeCard` (margin-top 24, bg `--bg-panel`, border `--bd-nav`, radius 9, padding 15 16):
    header `Pixel Office 12.5/700` + right `● connected · 3 offices` green mono; SERVER URL label +
    mono field `https://app.pixeloffice.org` + `Reset` / `Save`; helper text `https only — http allowed
    for localhost. Applies on next connect…`.

**Interaction notes**
- One scrolling page with in-page sections + a nav that scrolls to / filters sections (not separate windows).
- Every control shows a **real default** (Grok interactive, 30 min, retry on, fallback Claude) — no empty zeros.
- Toggles/sliders write immediately; the Pixel Office URL is the only Save-gated field; changes apply on
  next connect / next task, never retroactively.

---

# 4. Implementation notes (cross-cutting)

- **Theme:** single dark theme. Do not introduce a second accent — status colors must never be used for
  non-state chrome (no blue "info" that isn't actionable, no green that isn't "running/ok").
- **Mono vs sans discipline:** any machine-generated value (id, path, token count, timestamp, count,
  transport, code) is JetBrains Mono; everything human-authored is sans.
- **Left accent rail** (`box-shadow:inset 2px 0 0 #4a9eff`) is the universal "selected/active" marker
  across rows, cards, and code lines (red variant for error lines).
- **Attention washes** are ≤7% status tints (`rgba(...,.05)`) so rows stay legible; borders go to ~28%.
- **Fixed panels don't co-scroll:** inspector (2a), office room (2c), stat band (2b) stay put while the
  primary stream scrolls.
- **Folding** is a first-class pattern: MCP log lines, duplicate sessions, `+N more` characters, JSON
  value elision — all collapse to one summary row with an expand affordance.
- **Everything applies "on next task"** — config/MCP/provider changes never mutate a running loop.
```
