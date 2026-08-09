/**
 * AutoDev redesign v2 — shared UI foundation.
 *
 * Import this barrel from any screen. It loads the design tokens (theme.css)
 * exactly once as a side effect and re-exports every primitive. Primitives
 * consume ONLY the CSS custom properties in theme.css — no hardcoded colours.
 */
import './theme.css'

export { Icon } from './Icon'
export type { IconName, IconProps } from './Icon'

export { StatusDot } from './StatusDot'
export type { StatusDotProps, DotStatus } from './StatusDot'

export { Pill } from './Pill'
export type { PillProps, PillVariant } from './Pill'

export { Button } from './Button'
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button'

export { IconButton } from './IconButton'
export type { IconButtonProps } from './IconButton'

export { Card } from './Card'
export type { CardProps, CardTone } from './Card'

export { SearchInput } from './SearchInput'
export type { SearchInputProps } from './SearchInput'

export { Toolbar } from './Toolbar'
export type { ToolbarProps } from './Toolbar'

export { ContextMenu } from './ContextMenu'
export type { ContextMenuProps, ContextMenuItem, ContextMenuEntry } from './ContextMenu'

export { ErrorBoundary } from './ErrorBoundary'
export type { ErrorBoundaryProps } from './ErrorBoundary'

export { Modal } from './Modal'
export type { ModalProps } from './Modal'

export { SegmentedTabs } from './SegmentedTabs'
export type { SegmentedTabsProps, SegTab } from './SegmentedTabs'

export { AppShell, NavItem, RunPill, ConnectionPill } from './AppShell'
export type { AppShellProps, NavItemDef } from './AppShell'

export { CliBanner } from './CliBanner'

export { CommandPalette } from './CommandPalette'
export type { CommandPaletteProps, Command } from './CommandPalette'

export { InfoTip } from './InfoTip'
export type { InfoTipProps } from './InfoTip'
