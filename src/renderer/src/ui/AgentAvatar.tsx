import React from 'react'
import { identityTokens, providerAccent, initials } from '@renderer/services/identity'

/**
 * AgentAvatar — the deterministic per-agent identity tile carried EVERYWHERE an
 * agent appears (rail row lead, Fleet AGENT column, AgentDetail header, office
 * cards). It is the highest-impact de-monotony fix: a stable hue + initials turn
 * a wall of identical grey rows into recognizable colored objects.
 *
 * Color with meaning, layered:
 *   - the TILE hue is a stable function of `idKey` (IDENTITY — same agent, same
 *     color, in every view);
 *   - the RING is the PROVIDER accent (answers "which tool" — coral/violet/teal/
 *     magenta), so identity and provider read at once without a second element.
 * State color is intentionally NOT painted here (it lives on the row spine / dot),
 * so a stopped agent still keeps its identity + provider hue — no row is ever
 * 100% grey.
 */
export interface AgentAvatarProps {
  /** the agent's display name — drives the initials */
  name: string
  /** stable identity key (workspace path / office char id). Falls back to name. */
  idKey?: string
  /** provider id (grok-tui / claude-cli / …) — drives the ring accent */
  provider?: string
  /** square px size (default 22 — matches --sz-avatar) */
  size?: number
  /** draw a dashed border instead of the provider ring (disconnected office char) */
  disconnected?: boolean
  /** dim the tile (idle / offline) without losing its hue */
  dim?: boolean
  /** hide the provider ring (used where provider is shown as an adjacent chip) */
  ring?: boolean
  /**
   * The bound office character's REAL pixel-art sprite as an inline `data:` URI
   * (fetched main-side; the renderer CSP forbids remote images). When the agent is
   * `online` and this resolves + loads, the tile shows the character's actual face
   * instead of the initials monogram — with the SAME provider ring + shape + size.
   * On a load error, or when offline/absent, it falls back to the monogram.
   */
  avatarUrl?: string
  /** The office character's identity color — the tile background behind the sprite. */
  avatarColor?: string
  /** Whether the agent is connected/online to its office character. The real sprite
   *  is only shown when online (offline ⇒ monogram, even if avatarUrl is present). */
  online?: boolean
  style?: React.CSSProperties
  title?: string
}

// Sprite-sheet geometry (mirrors pixel-office pixi/engine/gridConfig): each
// /assets/characters/char_N.png is a 112×96 sheet of 16×32 frames, 7 per row × 3
// direction rows. The front-facing idle face is frame (col 0, row 0) — we crop to
// it so the tile shows a portrait, not the whole animation strip. We render the
// sheet scaled so ONE frame's WIDTH equals the tile size (scale = size / FRAME_W),
// then clip the tile to the top of that frame (head + torso) — aspect preserved.
const FRAME_W = 16
const SHEET_W = 112
const SHEET_H = 96

export function AgentAvatar({
  name,
  idKey,
  provider,
  size = 22,
  disconnected = false,
  dim = false,
  ring = true,
  avatarUrl,
  avatarColor,
  online,
  style,
  title
}: AgentAvatarProps): React.JSX.Element {
  const id = identityTokens(idKey || name)
  const accent = providerAccent(provider)
  // Initials scale with the tile: ~45% of the box, floored so a 16px chip stays legible.
  const fontSize = Math.max(9, Math.round(size * 0.42))
  const border = disconnected
    ? '1px dashed var(--bd-idle-box)'
    : '1px solid transparent'
  // The provider ring is an inset stroke so it never changes the tile's box size.
  const ringShadow = ring && !disconnected ? `inset 0 0 0 1.5px ${accent.ring}` : undefined

  // Show the REAL pixel-art face only when the character is online, has a resolvable
  // sprite, and that sprite actually loaded — otherwise fall back to the monogram so
  // an offline / avatar-less / broken-image agent is never a blank or broken tile.
  const [imgError, setImgError] = React.useState(false)
  // Reset the broken-image flag when the sprite URL changes, using the "adjust state
  // during render" pattern (NOT an effect): an effect runs asynchronously after
  // paint, so a load error that fires before it would be clobbered back to false and
  // the broken image re-shown. Setting state during render re-renders in place first.
  const [lastUrl, setLastUrl] = React.useState(avatarUrl)
  if (avatarUrl !== lastUrl) { setLastUrl(avatarUrl); setImgError(false) }
  const showReal = !!avatarUrl && online !== false && !disconnected && !imgError
  // Broken-image → monogram, race-proof. A data: URI can finish (or fail) decoding
  // BEFORE React attaches its synthetic onLoad/onError, so those events get missed.
  // Instead, in the ref callback (which runs the instant we hold the node) we (a)
  // synchronously catch an already-complete image with naturalWidth 0 (broken), and
  // (b) attach NATIVE load/error listeners for the async path. A genuine failure
  // fires `error`; a malformed image can instead fire `load` with naturalWidth 0 —
  // both fall back. Never a blank or broken tile.
  const imgRef = React.useCallback((el: HTMLImageElement | null) => {
    if (!el) return
    const fail = (): void => setImgError(true)
    const onLoad = (): void => { if (el.naturalWidth === 0) fail() }
    if (el.complete) { onLoad(); return } // already resolved before this ref ran
    el.addEventListener('error', fail, { once: true })
    el.addEventListener('load', onLoad, { once: true })
  }, [])

  const shell: React.CSSProperties = {
    width: size,
    height: size,
    flex: 'none',
    borderRadius: 'var(--r-chip)',
    border,
    boxShadow: ringShadow,
    opacity: dim ? 0.68 : 1,
    userSelect: 'none',
    overflow: 'hidden',
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  }

  if (showReal) {
    // Crop to the front-idle frame (col 0, row 0). The full sheet is rendered at
    // SHEET_COLS×size wide so one frame's WIDTH fills the tile; the tile clips to the
    // top (head + torso) — reading as an avatar rather than a tiny full body. Pixel
    // art stays crisp (image-rendering: pixelated). The provider ring is re-drawn as
    // a top overlay so the sprite can't paint over the inset stroke.
    return (
      <span aria-hidden title={title} style={{ ...shell, background: avatarColor || id.bg, ...style }}>
        <img
          ref={imgRef}
          src={avatarUrl}
          alt=""
          draggable={false}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            // scale = size / FRAME_W → frame(0,0) is `size` wide; aspect preserved.
            width: (SHEET_W / FRAME_W) * size,
            height: (SHEET_H / FRAME_W) * size,
            imageRendering: 'pixelated',
            pointerEvents: 'none'
          }}
        />
        {ringShadow && (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 'var(--r-chip)',
              boxShadow: ringShadow,
              pointerEvents: 'none'
            }}
          />
        )}
      </span>
    )
  }

  return (
    <span
      aria-hidden
      title={title}
      style={{
        ...shell,
        background: id.bg,
        color: id.fg,
        fontFamily: 'var(--font-mono)',
        fontSize,
        fontWeight: 700,
        letterSpacing: '.01em',
        lineHeight: 1,
        ...style
      }}
    >
      {initials(name)}
    </span>
  )
}

/**
 * ProviderChip — a small provider-tinted label ("Claude" / "Grok" / …). Uses the
 * provider `-tint` background + `-ink` text (AA), so it reads as the tool's brand
 * without shouting. `dot` adds a leading brand-hue dot for the compact form.
 */
export interface ProviderChipProps {
  provider?: string
  /** compact = dot + label at chip size; default = boxed tinted chip */
  compact?: boolean
  style?: React.CSSProperties
}

export function ProviderChip({ provider, compact = false, style }: ProviderChipProps): React.JSX.Element {
  const accent = providerAccent(provider)
  if (compact) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--fs-micro)',
          fontWeight: 600,
          color: accent.ink,
          whiteSpace: 'nowrap',
          ...style
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            flex: 'none',
            borderRadius: '50%',
            background: accent.fg
          }}
        />
        {accent.label}
      </span>
    )
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 7px',
        borderRadius: 'var(--r-chip)',
        background: accent.tint,
        border: `1px solid ${accent.ring}`,
        color: accent.ink,
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-micro)',
        fontWeight: 600,
        letterSpacing: '.02em',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        ...style
      }}
    >
      {accent.label}
    </span>
  )
}

export default AgentAvatar
