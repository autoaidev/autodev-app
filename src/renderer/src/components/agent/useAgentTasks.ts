import React from 'react'
import type { AgentState } from '@renderer/services/model'

/**
 * useAgentTasks — the ONE reconciled task truth for an agent, shared by the
 * AgentDetail header ("N/M done") and the Inspector TODO.md panel ("N / M").
 *
 * Before this the header read `agent.tasks` (the store summary) while the panel
 * re-parsed TODO.md and recomputed its own denominator, so an idle agent whose
 * file shows all-complete diverged: header "1019/1021", panel "1019/1019". Both
 * now derive done/total from THIS hook, so they can never disagree.
 *
 * The reconciliation mirrors what the panel always did: when the parsed TODO.md is
 * empty the summary's "in-progress" tasks are phantom (an idle agent isn't working
 * them), so the denominator collapses to `done` — while a running agent with real
 * remaining work keeps the full total and surfaces an in-progress row.
 */

export interface TodoItem {
  state: 'done' | 'active' | 'pending'
  text: string
}

export function parseTodo(raw: string): TodoItem[] {
  const out: TodoItem[] = []
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s*)?\[([ xX~])\]\s+(.*\S)\s*$/)
    if (!m) continue
    const flag = m[1].toLowerCase()
    out.push({ state: flag === 'x' ? 'done' : flag === '~' ? 'active' : 'pending', text: m[2] })
  }
  return out
}

export interface AgentTasks {
  /** parsed TODO.md items; null while the first read is in flight */
  items: TodoItem[] | null
  loaded: boolean
  done: number
  total: number
  ratio: number
  remaining: number
  /** running with work tracked outside TODO.md (empty file, remaining > 0) */
  inProgress: boolean
  /** file empty / all complete — the denominator has collapsed to `done` */
  emptyDone: boolean
}

/** Fetch + parse `status --all` for an agent and reconcile it against the store
 *  summary. `path` may be undefined (no selection) → an unloaded, zeroed result. */
const REFRESH_MS = 4000

export function useAgentTasks(agent?: Pick<AgentState, 'path' | 'running' | 'tasks'>): AgentTasks {
  const [items, setItems] = React.useState<TodoItem[] | null>(null)
  const path = agent?.path
  const running = agent?.running ?? false
  // A mutation signal: whenever the store summary moves (a task completed, or the
  // composer appended one via sendAgentMessage → TODO.md), re-parse the file so the
  // Inspector checklist re-renders instead of freezing at its first read.
  const sig = agent?.tasks ? `${agent.tasks.done}/${agent.tasks.total}/${agent.tasks.remaining}` : ''
  // Only blank to the loading state when the SELECTED agent actually changes; a
  // refresh from the poll or a summary bump refreshes in place (no null flash).
  const prevPath = React.useRef<string | undefined>(undefined)

  React.useEffect(() => {
    if (!path) {
      prevPath.current = undefined
      setItems(null)
      return
    }
    let live = true
    const fetchNow = (): void => {
      window.api
        .runCli(['status', path, '--all'])
        .then((r: { stdout?: string; stderr?: string }) => {
          if (!live) return
          setItems(parseTodo((r.stdout || r.stderr || '').replace(/\x1b\[[0-9;]*m/g, '')))
        })
        .catch(() => {
          if (live) setItems((cur) => cur ?? [])
        })
    }
    if (prevPath.current !== path) {
      prevPath.current = path
      setItems(null)
    }
    fetchNow()
    // While the agent is actively working, TODO.md changes without any store-summary
    // delta (an item flips ~→x); poll so the checklist tracks it live.
    const iv = running ? setInterval(fetchNow, REFRESH_MS) : null
    return () => {
      live = false
      if (iv) clearInterval(iv)
    }
  }, [path, running, sig])

  const list = items ?? []
  const loaded = items !== null
  const summary = agent?.tasks ?? { total: 0, remaining: 0, done: 0 }
  const inProgress = loaded && list.length === 0 && running && summary.remaining > 0
  const emptyDone = loaded && list.length === 0 && !inProgress
  const done = summary.done
  const total = emptyDone ? done : summary.total || list.length
  const ratio = total > 0 ? done / total : 0

  return { items, loaded, done, total, ratio, remaining: summary.remaining, inProgress, emptyDone }
}
