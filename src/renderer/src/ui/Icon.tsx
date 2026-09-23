import React from 'react'

/**
 * Icon — the SVG icon set extracted verbatim from mockup-v2.html.
 *
 * Every glyph inherits `currentColor` (stroke for line icons, fill for solid
 * icons) so callers control colour with plain CSS `color` or the `color` prop.
 * Strokes are non-scaling in spirit but sized via `size` (px, square).
 */
export type IconName =
  | 'search'
  | 'play'
  | 'stop'
  | 'restart'
  | 'refresh'
  | 'plus'
  | 'folder'
  | 'editor'
  | 'terminal'
  | 'copy'
  | 'duplicate'
  | 'more'
  | 'gear'       // spoked cog (Setup)
  | 'settings'   // concentric target (top-nav settings)
  | 'dot'
  | 'chevron'    // small down caret (dropdowns)
  | 'caret'      // solid right triangle (group folders)
  | 'close'
  | 'office'     // connected nodes glyph
  | 'clock'      // live session
  | 'external'   // open-in-browser arrow
  | 'check'
  | 'trash'
  | 'help'       // question mark in a circle (Help / getting started)
  | 'agents'     // two head-and-shoulders (Agents nav tab)
  | 'fleet'      // 2×2 grid of tiles (Fleet nav tab)
  | 'sparkle'    // 4-point star (Make app nav tab)
  | 'bolt'       // lightning bolt (live steer / instant-message)
  | 'warn'       // warning triangle (failing / attention count)
  | 'paperclip'  // attach a file to a task
  | 'camera'     // take a photo (webcam capture)

type Kind = 'stroke' | 'fill'

interface Glyph {
  vb: string
  kind: Kind
  sw?: number
  body: React.ReactNode
}

const G: Record<IconName, Glyph> = {
  search: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.4,
    body: <><circle cx="6" cy="6" r="4" /><path d="M9 9l3.5 3.5" /></>
  },
  play: {
    vb: '0 0 10 10', kind: 'fill',
    body: <path d="M2 1l6 4-6 4z" />
  },
  stop: {
    vb: '0 0 10 10', kind: 'fill',
    body: <rect x="1" y="1" width="8" height="8" rx="1" />
  },
  restart: {
    vb: '0 0 12 12', kind: 'stroke', sw: 1.3,
    body: <><path d="M10 6a4 4 0 1 1-1.3-3" /><path d="M9.4 1.4v2h-2" /></>
  },
  refresh: {
    vb: '0 0 12 12', kind: 'stroke', sw: 1.3,
    body: <><path d="M10 6a4 4 0 1 1-1.3-3" /><path d="M9.4 1.4v2h-2" /></>
  },
  plus: {
    vb: '0 0 12 12', kind: 'stroke', sw: 1.4,
    body: <path d="M6 2v8M2 6h8" />
  },
  folder: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.3,
    body: <path d="M1.5 11V3.5h3.6l1.2 1.4h6.2V11z" />
  },
  editor: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.3,
    body: <><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" /><path d="M5.5 2.5v9" /></>
  },
  terminal: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.3,
    body: <><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" /><path d="M4 6l2 1.6L4 9.2" /></>
  },
  copy: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.3,
    body: <path d="M2 7h10M8.5 3.5L12 7l-3.5 3.5" />
  },
  duplicate: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.3,
    body: <><rect x="4" y="4" width="8.5" height="8.5" rx="1.4" /><path d="M10 1.5H1.5V10" /></>
  },
  more: {
    vb: '0 0 16 16', kind: 'fill',
    body: <><circle cx="3" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="13" cy="8" r="1.3" /></>
  },
  gear: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.3,
    body: <><circle cx="7" cy="7" r="1.6" /><path d="M7 1.6v1.8M7 10.6v1.8M1.6 7h1.8M10.6 7h1.8" /></>
  },
  settings: {
    vb: '0 0 20 20', kind: 'stroke', sw: 1.4,
    body: <><circle cx="10" cy="10" r="3" /><circle cx="10" cy="10" r="7" /></>
  },
  dot: {
    vb: '0 0 10 10', kind: 'fill',
    body: <circle cx="5" cy="5" r="3" />
  },
  chevron: {
    vb: '0 0 8 5', kind: 'stroke', sw: 1.2,
    body: <path d="M1 1l3 3 3-3" />
  },
  caret: {
    vb: '0 0 10 10', kind: 'fill',
    body: <path d="M2 1l5 4-5 4z" />
  },
  close: {
    vb: '0 0 12 12', kind: 'stroke', sw: 1.4,
    body: <path d="M3 3l6 6M9 3l-6 6" />
  },
  office: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.3,
    body: <path d="M4 10a2.6 2.6 0 0 1 .3-5.2 3.4 3.4 0 0 1 6.4 1A2.3 2.3 0 0 1 10.2 10z" />
  },
  clock: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.3,
    body: <><circle cx="7" cy="7" r="5" /><path d="M7 4.2V7l2 1.4" /></>
  },
  external: {
    vb: '0 0 12 12', kind: 'stroke', sw: 1.4,
    body: <><path d="M4.5 2.5H9.5V7.5M9.5 2.5L5 7" /><path d="M9 8.5v1.2H2.5V3.5h1.4" /></>
  },
  check: {
    vb: '0 0 12 12', kind: 'stroke', sw: 1.6,
    body: <path d="M2.5 6.2l2.4 2.3L9.5 3.5" />
  },
  trash: {
    vb: '0 0 12 12', kind: 'stroke', sw: 1.3,
    body: <path d="M2.5 3.5h7M4.8 3.5V2.4h2.4v1.1M3.4 3.5l.5 6h4.2l.5-6" />
  },
  help: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.3,
    body: <><circle cx="7" cy="7" r="5.4" /><path d="M5.3 5.2a1.7 1.7 0 1 1 2.4 1.6c-.5.3-.7.6-.7 1.1v.3" /><circle cx="7" cy="10" r=".55" fill="currentColor" stroke="none" /></>
  },
  // Two head-and-shoulders — a back figure and a front figure — reads as "agents".
  agents: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.2,
    body: <><circle cx="9.4" cy="4.4" r="1.6" /><path d="M6.6 10.4a2.9 2.9 0 0 1 5.7 0" /><circle cx="4.6" cy="4.8" r="1.8" /><path d="M1.4 11a3.2 3.2 0 0 1 6.1-.9" /></>
  },
  // 2×2 grid of tiles — the fleet table / roster.
  fleet: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.2,
    body: <><rect x="2" y="2" width="4" height="4" rx="1" /><rect x="8" y="2" width="4" height="4" rx="1" /><rect x="2" y="8" width="4" height="4" rx="1" /><rect x="8" y="8" width="4" height="4" rx="1" /></>
  },
  // 4-point star — "make / generate" spark.
  sparkle: {
    vb: '0 0 14 14', kind: 'fill',
    body: <path d="M7 1c.45 2.7 1.3 3.55 4 4-2.7.45-3.55 1.3-4 4-.45-2.7-1.3-3.55-4-4 2.7-.45 3.55-1.3 4-4z" />
  },
  // Lightning bolt — live steer / instant-message affordance.
  bolt: {
    vb: '0 0 14 14', kind: 'fill',
    body: <path d="M8 1L3 8h3l-.6 5L11 6H7.6z" />
  },
  // Warning triangle with a bang — failing servers / attention counts.
  warn: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.3,
    body: <><path d="M7 2.2l5.3 9.1H1.7z" /><path d="M7 5.9v2.7" /><circle cx="7" cy="10.4" r=".55" fill="currentColor" stroke="none" /></>
  },
  // Paperclip — attach a file to a task.
  paperclip: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.3,
    body: <path d="M10.5 5.2 5.6 10a2.3 2.3 0 0 1-3.3-3.3l5.4-5.4a1.5 1.5 0 0 1 2.1 2.1l-5 5a.7.7 0 0 1-1-1l4.6-4.6" />
  },
  // Camera — take a photo (webcam capture).
  camera: {
    vb: '0 0 14 14', kind: 'stroke', sw: 1.3,
    body: <><rect x="1.5" y="4" width="11" height="7.5" rx="1.6" /><circle cx="7" cy="7.7" r="2" /><path d="M5 4l1-1.6h2L9 4" /></>
  }
}

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  /** square px size (default 14) */
  size?: number
  /** convenience colour override; otherwise inherits currentColor */
  color?: string
  /** override stroke width for line icons */
  strokeWidth?: number
}

export function Icon({ name, size = 14, color, strokeWidth, className, style, ...rest }: IconProps): React.JSX.Element {
  const g = G[name]
  const common = {
    width: size,
    height: size,
    viewBox: g.vb,
    className,
    style: { flex: 'none' as const, color, ...style },
    'aria-hidden': true,
    focusable: false,
    ...rest
  }
  if (g.kind === 'fill') {
    return <svg {...common} fill="currentColor" stroke="none">{g.body}</svg>
  }
  return (
    <svg
      {...common}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? g.sw ?? 1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {g.body}
    </svg>
  )
}

export default Icon
