/**
 * mcp.ts — the SINGLE source of MCP vocabulary for the app's layered MCP manager,
 * the exact twin of the catalog/defaults half of lib/providers.ts.
 *
 * Everything here is sourced from the bundled CLI (`autodev mcp catalog --json`,
 * exposed as window.api.mcpCatalog()) and every MUTATION routes through
 * window.api.mcpApply() → `autodev mcp <op>` — which propagates to every provider
 * and tags `_meta`. Nothing here hand-writes .mcp.json (that's writeAgentMcp, the
 * raw-editor path, which skips provider-sync). The three layers — Settings
 * defaults, per-folder/bulk, per-agent — all read this catalog and apply through
 * the same seam, so they can never drift.
 */

import { useEffect, useState } from 'react'

/** A raw `.mcp.json` server entry (stdio and/or remote fields). Mirrors preload. */
export interface McpJsonEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  type?: string
  enabled?: boolean
  alwaysLoad?: boolean
  _meta?: { managedBy?: string; name?: string; kind?: string }
}

/** One pickable server from `autodev mcp catalog --json`. */
export interface McpCatalogServer {
  id: string
  name: string
  kind: 'builtin' | 'common' | 'creative'
  transport: 'stdio' | 'http' | 'sse'
  server: McpJsonEntry
  description?: string
  experimental?: boolean
  requiresApp?: string
}

/** One entry from `autodev mcp list --json` (a raw entry plus its `name`). */
export interface McpListEntry extends McpJsonEntry {
  name: string
}

/** A default MCP server that seeds new agents (Settings → Default MCP servers). */
export interface DefaultMcpEntry {
  id?: string
  name: string
  /** Friendly display name (catalog `s.name`, e.g. "Memory"). `name`/`id` stay the
   *  identity used for .mcp.json + mcpApply; this is DISPLAY only. Absent on legacy
   *  entries / custom servers — fall back to `name`. */
  label?: string
  server: McpJsonEntry
  kind?: 'builtin' | 'common' | 'creative' | 'custom'
}

export type McpKind = McpCatalogServer['kind']

// ---------------------------------------------------------------------------
// Core built-ins — the 4 non-disableable servers the CLI ALWAYS seeds + enables
// in every agent (autodev-cli CORE_BUILTIN_NAMES / DEFAULT_MCP_SERVERS). The
// Settings panel shows these as a locked, always-on section (no remove/disable),
// and the Add-server picker never offers them (they're already always-on).
// ---------------------------------------------------------------------------

/** Identity + display for one always-on core built-in. `id` is the `.mcp.json` key
 *  (== catalog id == CLI DEFAULT_MCP_SERVERS name). */
export interface CoreBuiltin {
  id: string
  label: string
  /** The stdio command line shown as the always-on card detail. */
  detail: string
}

/** The 4 core built-ins, mirroring the CLI's DEFAULT_MCP_SERVERS + catalog labels. */
export const CORE_BUILTIN_MCP: readonly CoreBuiltin[] = [
  { id: 'memory', label: 'Memory', detail: 'npx -y @modelcontextprotocol/server-memory' },
  { id: 'playwright', label: 'Playwright', detail: 'npx -y @playwright/mcp@latest' },
  { id: 'sequential-thinking', label: 'Sequential Thinking', detail: 'npx -y @modelcontextprotocol/server-sequential-thinking' },
  { id: 'computer-use-mcp', label: 'Computer Use', detail: 'npx -y computer-use-mcp' }
]

/** The core built-in ids/names, for excluding them from the user seed list + picker. */
export const CORE_BUILTIN_IDS: ReadonlySet<string> = new Set(CORE_BUILTIN_MCP.map((b) => b.id))

/** Human label + order for the three catalog groups (novice-legible sections). */
export const MCP_KIND_META: Record<McpKind, { label: string; order: number }> = {
  builtin: { label: 'Built-in', order: 0 },
  common: { label: 'Common', order: 1 },
  creative: { label: 'Creative apps', order: 2 }
}

// ---------------------------------------------------------------------------
// Catalog — the REAL pickable MCP list from the bundled CLI. Cached process-wide
// (static per CLI version), exactly like fetchModelCatalog.
// ---------------------------------------------------------------------------

let _catalogPromise: Promise<McpCatalogServer[]> | null = null
export function fetchMcpCatalog(): Promise<McpCatalogServer[]> {
  if (!_catalogPromise) {
    const call = window.api?.mcpCatalog?.()
    _catalogPromise = (call ? Promise.resolve(call) : Promise.resolve(undefined))
      .then((r) => (r && 'servers' in r && Array.isArray(r.servers) ? r.servers : []))
      .catch(() => [])
  }
  return _catalogPromise
}

/** React hook: the full MCP catalog (empty until loaded / on an older CLI). */
export function useMcpCatalog(): { catalog: McpCatalogServer[]; loading: boolean } {
  const [catalog, setCatalog] = useState<McpCatalogServer[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    void fetchMcpCatalog().then((c) => {
      if (!live) return
      setCatalog(c)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [])
  return { catalog, loading }
}

/** Catalog split into the three kind-groups, each sorted, groups in display order. */
export function groupCatalog(catalog: McpCatalogServer[]): Array<{ kind: McpKind; label: string; servers: McpCatalogServer[] }> {
  const by = new Map<McpKind, McpCatalogServer[]>()
  for (const s of catalog) {
    const k = (MCP_KIND_META[s.kind] ? s.kind : 'common') as McpKind
    if (!by.has(k)) by.set(k, [])
    by.get(k)!.push(s)
  }
  return [...by.entries()]
    .map(([kind, servers]) => ({ kind, label: MCP_KIND_META[kind].label, servers }))
    .sort((a, b) => MCP_KIND_META[a.kind].order - MCP_KIND_META[b.kind].order)
}

/** The `.mcp.json`-shaped server spec `window.api.mcpApply({op:'add'})` consumes for
 *  a catalog server (drops the catalog-only `enabled:false` default so an explicit
 *  add is always enabled; disable is a separate op). */
export function catalogServerSpec(s: McpCatalogServer): McpJsonEntry {
  const { enabled, ...rest } = s.server
  void enabled
  return rest
}

/** A DefaultMcpEntry built from a catalog server (for the Settings seed list).
 *  `name`/`id` are the identity (the `.mcp.json` key); `label` is the friendly
 *  catalog name for display. */
export function catalogToDefault(s: McpCatalogServer): DefaultMcpEntry {
  return { id: s.id, name: s.id, label: s.name, server: catalogServerSpec(s), kind: s.kind }
}

// ---------------------------------------------------------------------------
// Default-MCP preference — the seed list applied to NEW agents (Settings). Twin of
// fetchDefaultModels/useDefaultModels. A SEED only — never mutates existing agents.
// ---------------------------------------------------------------------------

/** The persisted default-MCP seed list (`[]` on an older main / read error). */
export function fetchDefaultMcp(): Promise<DefaultMcpEntry[]> {
  const call = window.api?.getSettings?.()
  return (call ? Promise.resolve(call) : Promise.resolve(undefined))
    .then((s) => {
      const dm = (s as { defaultMcp?: DefaultMcpEntry[] } | undefined)?.defaultMcp
      return Array.isArray(dm) ? dm : []
    })
    .catch(() => [])
}

/** React hook: the default-MCP seed list + a `reload` to re-read after a Save. */
export function useDefaultMcp(): { defaults: DefaultMcpEntry[]; loading: boolean; reload: () => void } {
  const [defaults, setDefaults] = useState<DefaultMcpEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    void fetchDefaultMcp().then((d) => {
      if (!live) return
      setDefaults(d)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [tick])
  return { defaults, loading, reload: () => setTick((t) => t + 1) }
}

/** Persist the full default-MCP list (replace semantics — the UI owns the array). */
export function saveDefaultMcp(list: DefaultMcpEntry[]): Promise<unknown> {
  const call = window.api?.setSettings?.({ defaultMcp: list })
  return call ? Promise.resolve(call).catch(() => undefined) : Promise.resolve(undefined)
}

/** Apply one default server to a workspace path via the CLI seam (used by the
 *  create-time seed and the bulk "Apply defaults"). Adds, then disables when the
 *  default was marked disabled. Returns true on a successful add. */
export async function applyDefaultToPath(path: string, d: DefaultMcpEntry): Promise<boolean> {
  const r = await window.api.mcpApply({ path, op: 'add', name: d.name, server: d.server })
  if (!r.ok) return false
  if (d.server?.enabled === false) {
    try { await window.api.mcpApply({ path, op: 'disable', name: d.name }) } catch { /* add still landed */ }
  }
  return true
}

/** transport → short badge word for the picker rows. */
export function transportBadge(s: McpCatalogServer): string {
  if (s.kind === 'builtin') return 'builtin'
  return s.transport === 'http' || s.transport === 'sse' ? 'remote' : 'stdio'
}
