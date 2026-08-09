import React from 'react'
import { Modal, Button, Icon } from '@renderer/ui'
import { useAppActions } from '@renderer/services/appActions'
import { useAgents } from '@renderer/services/agentStore'

/**
 * HelpPanel — the shared Help & getting-started surface. A single Modal reachable
 * from the AppShell "?" button and the ⌘K command palette (both route through
 * useAppActions().openHelp → App's open-state). Three parts:
 *
 *   1. Getting-started checklist wired to REAL signals — not a static tour:
 *        • AutoDev CLI present     → window.api.cliCheck()
 *        • Pixel Office URL set     → window.api.getSettings().officeBaseUrl
 *        • Signed in to an office   → window.api.officeStatus().connected
 *        • Provider CLI signed in   → advisory (no probe IPC exists) — a copyable
 *          `claude`/`grok` login command, never a false "done"
 *        • First agent created      → the shared agentStore fleet count
 *      Each incomplete step offers the concrete next action (navigate to the
 *      right screen / open the new-agent funnel / open the docs), so the panel
 *      is a working launcher, never a dead description.
 *   2. Keyboard-shortcuts reference — the app's real global shortcuts.
 *   3. Docs & links — the real tutorial + site (pixeloffice.org / autoaidev.com).
 *
 * All lifecycle/navigation goes through the typed appActions bus; the panel owns
 * no routing of its own. Colours come only from theme.css tokens.
 */

interface Probe {
  cli: boolean | null
  officeUrl: string
  connected: boolean | null
}

const DOCS_TUTORIAL = 'https://pixeloffice.org/tutorial'
const DOCS_SITE = 'https://autoaidev.com'
const CLI_DOWNLOAD = 'https://autoaidev.com/download'

export interface HelpPanelProps {
  open: boolean
  onClose: () => void
}

export function HelpPanel({ open, onClose }: HelpPanelProps): React.JSX.Element | null {
  const app = useAppActions()
  const agents = useAgents()
  const [probe, setProbe] = React.useState<Probe>({ cli: null, officeUrl: '', connected: null })

  // Re-probe the real signals every time the panel opens so the checklist reflects
  // the live state (the user may have just set a URL / signed in and reopened it).
  React.useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      const next: Probe = { cli: null, officeUrl: '', connected: null }
      try {
        const c = (await window.api.cliCheck()) as { found: boolean }
        next.cli = !!c?.found
      } catch {
        next.cli = false
      }
      try {
        const cfg = (await window.api.getSettings()) as { officeBaseUrl?: string }
        next.officeUrl = cfg?.officeBaseUrl || ''
      } catch {
        next.officeUrl = ''
      }
      try {
        const s = (await window.api.officeStatus()) as { connected: boolean }
        next.connected = !!s?.connected
      } catch {
        next.connected = false
      }
      if (alive) setProbe(next)
    })()
    return () => {
      alive = false
    }
  }, [open])

  const [copiedCmd, setCopiedCmd] = React.useState<string | null>(null)
  const copyCmd = (cmd: string): void => {
    void navigator.clipboard?.writeText(cmd).then(
      () => {
        setCopiedCmd(cmd)
        window.setTimeout(() => setCopiedCmd((c) => (c === cmd ? null : c)), 1500)
      },
      () => {}
    )
  }

  const go = (fn: () => void): void => {
    onClose()
    fn()
  }
  const openUrl = (url: string): void => {
    void window.api?.openExternal?.(url)
  }

  const steps: {
    key: string
    title: string
    done: boolean | null
    body: string
    /** Advisory steps can't be verified by the app (no provider-auth probe IPC), so
     *  they render as a neutral to-do with a command — never a false "done"/"missing". */
    advisory?: boolean
    action?: { label: string; run: () => void }
  }[] = [
    {
      key: 'cli',
      title: 'Install the AutoDev CLI',
      done: probe.cli,
      body: 'The runner that actually drives your agents on this machine. Everything else needs it.',
      action: { label: 'Get the CLI', run: () => openUrl(CLI_DOWNLOAD) }
    },
    {
      key: 'url',
      title: 'Set your Pixel Office URL',
      done: probe.officeUrl ? true : false,
      body: 'The server your agents connect to for shared offices, chat and A2A. Optional for local-only agents.',
      action: { label: 'Open Settings', run: () => go(() => app.navigate('settings')) }
    },
    {
      key: 'signin',
      title: 'Sign in to your office',
      done: probe.connected,
      body: 'Connect with your office email + password to see characters, spawn teams and use office-backed flows.',
      action: { label: 'Open Office', run: () => go(() => app.navigate('office')) }
    },
    {
      key: 'provider-auth',
      title: 'Sign in to your provider',
      done: false,
      advisory: true,
      body: 'Your agents run on a provider CLI (Claude, Grok, OpenCode, Copilot) that must be logged in on THIS machine. Run it once in a terminal and follow its login — otherwise a headless loop or “Connect all” fails at runtime with a needs-auth error. The app can’t verify this for you yet.',
      action: { label: copiedCmd === 'claude' ? 'Copied' : 'Copy “claude”', run: () => copyCmd('claude') }
    },
    {
      key: 'agent',
      title: 'Create your first agent',
      done: agents.length > 0,
      body: 'Describe what you want and let AutoDev generate a team — or spawn a single agent in a folder.',
      action: { label: 'New agent', run: () => go(() => app.newAgent()) }
    }
  ]

  // Advisory steps aren't verifiable, so they don't count toward the "X of N" tally.
  const verifiable = steps.filter((s) => !s.advisory)
  const doneCount = verifiable.filter((s) => s.done === true).length

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Help & getting started"
      subtitle={`${doneCount} of ${verifiable.length} steps complete`}
      width={560}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
          <span style={{ fontSize: 'var(--fs-desc)', color: 'var(--tx-dim)' }}>
            New to AutoDev? The tutorial walks through the whole flow.
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={() => openUrl(DOCS_TUTORIAL)}>
              <Icon name="external" size={11} /> Open tutorial
            </Button>
            <Button variant="primary" size="sm" onClick={onClose}>
              Got it
            </Button>
          </div>
        </div>
      }
    >
      {/* ── Getting-started checklist ── */}
      <Section label="Getting started">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {steps.map((s, i) => (
            <ChecklistRow
              key={s.key}
              index={i + 1}
              title={s.title}
              body={s.body}
              done={s.done}
              advisory={s.advisory}
              action={s.action}
            />
          ))}
        </div>
      </Section>

      {/* ── Keyboard shortcuts ── */}
      <Section label="Keyboard shortcuts">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'max-content 1fr',
            gap: '7px 14px',
            alignItems: 'center'
          }}
        >
          {SHORTCUTS.map((sc) => (
            <React.Fragment key={sc.desc}>
              <Kbd>{sc.keys}</Kbd>
              <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-2)' }}>{sc.desc}</span>
            </React.Fragment>
          ))}
        </div>
      </Section>

      {/* ── Glossary ── */}
      <Section label="Words you'll see">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {GLOSSARY.map((g) => (
            <div key={g.term} style={{ fontSize: 'var(--fs-meta)', color: 'var(--tx-2)', lineHeight: 1.5 }}>
              <span style={{ fontWeight: 700, color: 'var(--tx-hi)' }}>{g.term}</span>
              <span style={{ color: 'var(--tx-dim)' }}> — {g.def}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Docs & links ── */}
      <Section label="Docs & links" last>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <LinkChip label="Tutorial" sub="pixeloffice.org/tutorial" onClick={() => openUrl(DOCS_TUTORIAL)} />
          <LinkChip label="AutoDev site" sub="autoaidev.com" onClick={() => openUrl(DOCS_SITE)} />
          <LinkChip label="Download CLI" sub="autoaidev.com/download" onClick={() => openUrl(CLI_DOWNLOAD)} />
        </div>
      </Section>
    </Modal>
  )
}

/* ─────────────────────────────────────────────────────────── helpers */

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: '⌘K  /  Ctrl+K', desc: 'Open the command palette (navigate + run actions)' },
  { keys: '↑  ↓', desc: 'Move between commands / list rows' },
  { keys: 'Enter', desc: 'Run the highlighted command' },
  { keys: 'Esc', desc: 'Close the palette, a dialog, or this panel' }
]

const GLOSSARY: { term: string; def: string }[] = [
  { term: 'Office', def: 'a shared room of agents ("characters") that can see and message each other.' },
  { term: 'Character', def: 'one agent as it appears inside an office, with a role and a workspace.' },
  { term: 'Steer', def: 'send a mid-run instruction to a working agent without stopping it.' },
  { term: 'MCP', def: 'Model Context Protocol — the tool servers an agent can call (per-agent .mcp.json).' },
  { term: 'Interactive / Headless / SDK', def: 'how a provider runs — a live terminal, a background loop, or via its SDK.' }
]

function Section({
  label,
  last,
  children
}: {
  label: string
  last?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      style={{
        paddingBottom: last ? 0 : 16,
        marginBottom: last ? 0 : 16,
        borderBottom: last ? 'none' : '1px solid var(--bd-card)'
      }}
    >
      <div
        style={{
          fontSize: 'var(--fs-section)',
          fontWeight: 700,
          letterSpacing: 'var(--ls-section)',
          textTransform: 'uppercase',
          color: 'var(--tx-dim)',
          marginBottom: 10
        }}
      >
        {label}
      </div>
      {children}
    </div>
  )
}

function ChecklistRow({
  index,
  title,
  body,
  done,
  advisory,
  action
}: {
  index: number
  title: string
  body: string
  done: boolean | null
  advisory?: boolean
  action?: { label: string; run: () => void }
}): React.JSX.Element {
  const isDone = done === true && !advisory
  const pending = done === null && !advisory
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 11,
        padding: '10px 12px',
        background: isDone ? 'var(--st-running-wash)' : 'var(--bg-input)',
        border: `1px solid ${isDone ? 'var(--st-running-bd)' : 'var(--bd-card)'}`,
        borderRadius: 'var(--r-card)'
      }}
    >
      <span
        aria-hidden
        style={{
          flex: 'none',
          width: 20,
          height: 20,
          marginTop: 1,
          borderRadius: 'var(--r-pill)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: isDone ? 'var(--st-running)' : 'var(--bg-chip-idle)',
          border: isDone ? 'none' : '1px solid var(--bd-strong)',
          color: isDone ? 'var(--tx-onaccent)' : 'var(--tx-dim)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-tiny)',
          fontWeight: 600
        }}
      >
        {isDone ? <Icon name="check" size={11} /> : advisory ? <Icon name="terminal" size={11} /> : index}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 'var(--fs-meta)',
            fontWeight: 600,
            color: 'var(--tx-hi)',
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}
        >
          {title}
          {isDone && (
            <span style={{ fontSize: 'var(--fs-tiny)', fontWeight: 500, color: 'var(--st-running)' }}>Done</span>
          )}
          {advisory && (
            <span style={{ fontSize: 'var(--fs-tiny)', fontWeight: 500, color: 'var(--tx-dim)' }}>Do this once</span>
          )}
          {pending && (
            <span style={{ fontSize: 'var(--fs-tiny)', fontWeight: 500, color: 'var(--tx-dim)' }}>Checking…</span>
          )}
        </div>
        <div style={{ marginTop: 3, fontSize: 'var(--fs-desc)', color: 'var(--tx-dim)', lineHeight: 1.5 }}>{body}</div>
      </div>
      {!isDone && action && (
        <Button variant="secondary" size="sm" onClick={action.run} style={{ flex: 'none' }}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 8px',
        borderRadius: 'var(--r-chip)',
        background: 'var(--bg-input)',
        border: '1px solid var(--bd-field)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-tiny)',
        color: 'var(--tx-2)',
        whiteSpace: 'nowrap'
      }}
    >
      {children}
    </span>
  )
}

function LinkChip({
  label,
  sub,
  onClick
}: {
  label: string
  sub: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '8px 12px',
        borderRadius: 'var(--r-card)',
        background: 'var(--bg-input)',
        border: '1px solid var(--bd-card)',
        cursor: 'pointer',
        textAlign: 'left'
      }}
    >
      <Icon name="external" size={13} color="var(--accent)" />
      <span style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 'var(--fs-meta)', fontWeight: 600, color: 'var(--tx-hi)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-tiny)', color: 'var(--tx-dim)' }}>{sub}</span>
      </span>
    </button>
  )
}

export default HelpPanel
