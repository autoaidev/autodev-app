import React from 'react'
import { AgentAvatar, Button, Icon, ProviderChip } from '@renderer/ui'
import { OfficeAgent, ChatMessage } from './officeTypes'
import { ChatTab } from '@renderer/components/agent/ChatTab'
import { AgentStream } from './AgentStream'

/**
 * OfficeChat — the "Chat" view of the Office Team workspace (2c).
 *
 * A chat-centric alternative to the CharacterCard grid: a scrollable left sidebar
 * listing ALL of the office's characters (colored avatar · name · a one-line
 * latest-activity preview · a relative timestamp) beside a large chat pane that
 * takes the rest of the width. It REUSES the existing agent ChatTab (the office
 * conversation surface) rather than re-implementing chat — ChatTab resolves the
 * office link off a LOCAL workspace path, so OfficeChat renders it only once the
 * selected character has a local loop/operate session this app tracks. When it
 * doesn't, the pane mirrors the card's "Connect & operate" affordance (the same
 * action onOperate drives) instead of showing a broken, perpetually-loading chat.
 *
 * All state (selection, previews, local-path resolution, operate) lives in
 * OfficeView and is passed in, so this component is a pure presentational shell
 * that stays in lockstep with the cards view (both drive the same focusedId).
 */

/** A compact relative "now / Nm / Nh / Nd" from an epoch-ms timestamp; '' when
 *  unknown so the row renders no timestamp rather than a fabricated one. */
function relAgo(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return ''
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export interface OfficeChatProps {
  /** Every character in the selected office (the sidebar lists them all). */
  agents: OfficeAgent[]
  /** The focused character's id (shared with the cards view's focusedId). */
  selectedId: string
  onSelect: (id: string) => void
  /** agentId → latest office-event one-liner (OfficeView's latestByAgent). */
  previews: Map<string, string>
  /** agentId → epoch ms of the last witnessed activity, for the row timestamp. */
  lastActivity: Map<string, number>
  /** agentId → local workspace path, when THIS app tracks a loop/operate session
   *  for the character (so ChatTab can resolve its office link). Absent → not
   *  connected locally, so the chat pane offers Connect & operate instead. */
  localPaths: Map<string, string>
  /** Connect & operate the character — mints a local session so chat resolves. */
  onOperate: (a: OfficeAgent) => void
  /** `officeSlug + id` of the character currently being operated (busy spinner). */
  operatingId: string
  /** The character is online but not managed from this app (no local session, and no
   *  same-host loop matched) → watch-only here; Operate is withheld (it could steal a
   *  live session). */
  isLiveElsewhere: (a: OfficeAgent) => boolean
  /** The selected character's backend conversation (assistant/system turns) for the
   *  read-only watch view — the SAME stream the cards view shows, no local session. */
  watchMessages: ChatMessage[]
  /** Advanced shows the full watch timeline; Basic a compact summary (AgentStream). */
  advanced: boolean
  /** Jump the character into the Agents tab (AgentStream's "Open agent"). */
  onOpenAgent: (a: OfficeAgent) => void
  /** Live instant-message a character via the OFFICE BACKEND (officeService.steer),
   *  so a character not managed from this app is still messageable — only local
   *  Operate (takeover) is withheld for it. */
  onSteer: (agentId: string, text: string) => void
}

/** One sidebar row: avatar · name (bold) · preview (grey, truncated) · timestamp. */
function ChatListRow({
  agent,
  selected,
  preview,
  time,
  onSelect
}: {
  agent: OfficeAgent
  selected: boolean
  preview: string
  time: string
  onSelect: () => void
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={agent.name}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        textAlign: 'left',
        padding: '9px 10px',
        borderRadius: 'var(--r-card)',
        border: '1px solid transparent',
        background: selected ? 'var(--bg-accent-soft)' : hover ? 'var(--bg-hover)' : 'transparent',
        boxShadow: selected ? 'inset 0 0 0 1px var(--bd-accent)' : undefined,
        cursor: 'pointer',
        outline: 'none',
        fontFamily: 'var(--font-sans)'
      }}
    >
      <AgentAvatar
        name={agent.name}
        idKey={agent.id}
        provider={agent.provider}
        size={34}
        disconnected={!agent.online}
        dim={!agent.online}
        avatarUrl={agent.avatarUrl}
        avatarColor={agent.color}
        online={agent.online}
        title={agent.name}
      />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 'var(--fs-meta)',
              fontWeight: 600,
              color: 'var(--tx-hi)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {agent.name}
          </span>
          {time && (
            <span style={{ flex: 'none', fontSize: 'var(--fs-tiny)', color: 'var(--tx-ghost)' }}>{time}</span>
          )}
        </div>
        <span
          style={{
            minWidth: 0,
            fontSize: 'var(--fs-desc)',
            color: 'var(--tx-5)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {preview}
        </span>
      </div>
    </button>
  )
}

export function OfficeChat({
  agents,
  selectedId,
  onSelect,
  previews,
  lastActivity,
  localPaths,
  onOperate,
  operatingId,
  isLiveElsewhere,
  watchMessages,
  advanced,
  onOpenAgent,
  onSteer
}: OfficeChatProps): React.JSX.Element {
  // Resolve the focused character, defaulting to the first so the pane is never
  // empty while the office has characters (mirrors the cards view's focus default).
  const selected = agents.find((a) => a.id === selectedId) ?? agents[0]
  const localPath = selected ? localPaths.get(selected.id) : undefined
  // Watch-only when online but not managed from this app AND not tracked locally here.
  const elsewhere = !!selected && !localPath && isLiveElsewhere(selected)
  const busy = !!selected && operatingId === selected.officeSlug + selected.id

  const previewFor = (a: OfficeAgent): string =>
    previews.get(a.id) || (a.status && a.status.trim()) || (a.online ? 'Online' : 'Offline')

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
      {/* LEFT — scrollable sidebar listing every character. */}
      <div
        style={{
          width: 280,
          flex: 'none',
          borderRight: '1px solid var(--bd-2)',
          background: 'var(--bg-sidebar)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0
        }}
      >
        <div
          style={{
            padding: '11px 14px 9px',
            borderBottom: '1px solid var(--bd-2)',
            fontSize: 'var(--fs-desc)',
            fontWeight: 600,
            letterSpacing: 'var(--ls-section)',
            textTransform: 'uppercase',
            color: 'var(--tx-dim)'
          }}
        >
          Characters · {agents.length}
        </div>
        <div
          role="listbox"
          aria-label="Office characters"
          style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 3 }}
        >
          {agents.length === 0 ? (
            <div style={{ padding: '18px 10px', fontSize: 'var(--fs-desc)', color: 'var(--tx-5)' }}>
              No characters in this office yet.
            </div>
          ) : (
            agents.map((a) => (
              <ChatListRow
                key={a.id}
                agent={a}
                selected={a.id === selected?.id}
                preview={previewFor(a)}
                time={relAgo(lastActivity.get(a.id))}
                onSelect={() => onSelect(a.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* RIGHT — the dominant chat pane (takes the rest of the width). */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-detail)' }}>
        {!selected ? (
          <div style={{ margin: 'auto', color: 'var(--tx-5)', fontSize: 'var(--fs-meta)' }}>
            Select a character to chat.
          </div>
        ) : elsewhere ? (
          // WATCH + MESSAGE — the character is online but not managed from this app.
          // Reuse AgentStream (the backend-sourced stream); its composer stays ENABLED
          // and routes through onSteer (office backend → delivered to whichever machine
          // runs it), so it's readable AND messageable from here. Only local Operate
          // (takeover) is withheld for it — operating here could steal its session.
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '8px 18px',
                borderBottom: '1px solid var(--bd-2)',
                background: 'var(--bg-input)',
                color: 'var(--tx-4)',
                fontSize: 'var(--fs-desc)'
              }}
            >
              <Icon name="external" size={12} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <strong style={{ color: 'var(--tx-2)', fontWeight: 600 }}>{selected.name}</strong> is online, but not managed from this app — watch and message it here; it can&rsquo;t be operated from this machine.
              </span>
            </div>
            <AgentStream
              agent={selected}
              messages={watchMessages}
              disabled={!selected.online}
              onSend={(t) => onSteer(selected.id, t)}
              onOpenAgent={() => onOpenAgent(selected)}
              advanced={advanced}
            />
          </div>
        ) : (
          <>
            {/* chat header — avatar + name + provider/status */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                padding: '12px 18px',
                borderBottom: '1px solid var(--bd-2)',
                background: 'var(--bg-detail-cap)'
              }}
            >
              <AgentAvatar
                name={selected.name}
                idKey={selected.id}
                provider={selected.provider}
                size={30}
                disconnected={!selected.online}
                dim={!selected.online}
                avatarUrl={selected.avatarUrl}
                avatarColor={selected.color}
                online={selected.online}
                title={selected.name}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 'var(--fs-panel-title)',
                    fontWeight: 700,
                    color: 'var(--tx-hi)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {selected.name}
                </div>
                <div style={{ fontSize: 'var(--fs-tiny)', color: selected.online ? 'var(--st-running)' : 'var(--tx-5)', marginTop: 2 }}>
                  {selected.online ? 'online' : 'offline'}
                </div>
              </div>
              {selected.provider && <ProviderChip provider={selected.provider} />}
            </div>

            {/* body — the reused ChatTab when a local session resolves, else the
                Connect & operate affordance (never a broken empty chat). Keyed by
                path so ChatTab remounts fresh on a character switch (it holds no
                PTY, so re-keying is safe). */}
            {localPath ? (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <ChatTab key={localPath} agentPath={localPath} />
              </div>
            ) : (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  padding: 24,
                  textAlign: 'center'
                }}
              >
                <div style={{ color: 'var(--tx-dim)' }}>
                  <Icon name="office" size={26} />
                </div>
                <div style={{ fontSize: 'var(--fs-agent-name)', fontWeight: 700, color: 'var(--tx-hi)' }}>
                  {selected.online ? `Operate ${selected.name} to chat` : `Connect ${selected.name} to chat`}
                </div>
                <div style={{ maxWidth: 380, fontSize: 'var(--fs-meta)', color: 'var(--tx-dim)', lineHeight: 1.55 }}>
                  Chat is this character&rsquo;s shared office conversation — steered live from here.
                  {selected.online
                    ? ' This app isn’t running a local session for it yet; operate it to read and steer it here.'
                    : ' Connect & operate it to start a session you can read and steer here.'}
                </div>
                <Button variant="primary" disabled={busy} onClick={() => onOperate(selected)}>
                  <Icon name="play" size={12} /> {busy ? 'Connecting…' : selected.online ? 'Operate' : 'Connect & operate'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default OfficeChat
