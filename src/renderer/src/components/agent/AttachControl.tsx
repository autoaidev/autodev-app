import React from 'react'
import { Icon, IconButton, Button, Modal } from '@renderer/ui'
import type { UseAttachments } from './useAttachments'

/**
 * AttachControl — the composer attach affordance (a paperclip button) shared by
 * the Activity task composer and the Chat steer composer. It offers two ways to
 * add a file the agent can read while doing the task:
 *   • Choose file — a hidden multi-file <input> (images, PDF, text/office docs).
 *   • Take photo  — a small camera modal (getUserMedia → <video> → capture frame
 *                   to a <canvas> → PNG), for snapping a whiteboard / screen / doc.
 *
 * Both paths save the bytes into the workspace via the `useAttachments` hook (the
 * `attachments:save` IPC) and surface each saved file as a chip (see AttachChips)
 * the composer references in the task text on submit. All state lives in the hook
 * so the two composers stay in sync with one implementation.
 */

const FILE_ACCEPT = 'image/*,application/pdf,.txt,.md,.csv,.json,.doc,.docx'

export function AttachButton({ attach }: { attach: UseAttachments }): React.JSX.Element {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [camOpen, setCamOpen] = React.useState(false)
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)

  // Close the menu on an outside click or Escape.
  React.useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  const onPickFile = (): void => {
    setMenuOpen(false)
    fileRef.current?.click()
  }
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = e.target.files
    if (files && files.length) void attach.addFiles(files)
    // Reset so picking the SAME file again re-fires change.
    e.target.value = ''
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 'none', display: 'flex' }}>
      <IconButton
        label="Attach a file or photo"
        icon="paperclip"
        active={menuOpen}
        disabled={attach.busy}
        onClick={() => setMenuOpen((o) => !o)}
      />
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={FILE_ACCEPT}
        onChange={onFileChange}
        style={{ display: 'none' }}
      />
      {menuOpen && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 0,
            minWidth: 168,
            padding: 4,
            borderRadius: 'var(--r-card)',
            background: 'var(--bg-menu, var(--bg-detail))',
            border: '1px solid var(--bd-strong, var(--bd-1))',
            boxShadow: 'var(--shadow-modal, 0 8px 24px rgba(0,0,0,.35))',
            zIndex: 40
          }}
        >
          <MenuItem icon="paperclip" label="Choose file…" onClick={onPickFile} />
          <MenuItem icon="camera" label="Take photo…" onClick={() => { setMenuOpen(false); setCamOpen(true) }} />
        </div>
      )}
      {camOpen && (
        <CameraModal
          onClose={() => setCamOpen(false)}
          onCapture={(b64) => { void attach.addPhoto(b64); setCamOpen(false) }}
        />
      )}
    </div>
  )
}

function MenuItem({ icon, label, onClick }: { icon: 'paperclip' | 'camera'; label: string; onClick: () => void }): React.JSX.Element {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        width: '100%',
        padding: '7px 9px',
        borderRadius: 'var(--r-chip)',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
        background: hover ? 'var(--bg-accent-soft)' : 'transparent',
        color: hover ? 'var(--accent-ink, var(--tx-1))' : 'var(--tx-2)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--fs-meta)'
      }}
    >
      <Icon name={icon} size={13} color="var(--tx-dim)" />
      {label}
    </button>
  )
}

/**
 * CameraModal — a live webcam preview with a Capture button. Draws the current
 * video frame to a canvas and hands back a base64 PNG. The MediaStream tracks are
 * always stopped on capture/close/unmount so the camera light never lingers. A
 * missing camera / denied permission is shown as a clear message, never a crash.
 */
function CameraModal({ onClose, onCapture }: { onClose: () => void; onCapture: (base64Png: string) => void }): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState('')

  const stop = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  React.useEffect(() => {
    let cancelled = false
    const md = navigator.mediaDevices
    if (!md || typeof md.getUserMedia !== 'function') {
      setError('No camera is available on this device.')
      return
    }
    md.getUserMedia({ video: true, audio: false })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        const v = videoRef.current
        if (v) {
          v.srcObject = stream
          void v.play().catch(() => { /* autoplay races the modal mount — ignore */ })
        }
        setReady(true)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const name = (e as { name?: string })?.name || ''
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow camera access to take a photo.'
            : name === 'NotFoundError'
              ? 'No camera was found on this device.'
              : 'Could not start the camera.'
        )
      })
    return () => { cancelled = true; stop() }
  }, [stop])

  const capture = (): void => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (!blob) return
      const r = new FileReader()
      r.onload = () => {
        const s = String(r.result || '')
        const comma = s.indexOf(',')
        stop()
        onCapture(comma >= 0 ? s.slice(comma + 1) : s)
      }
      r.readAsDataURL(blob)
    }, 'image/png')
  }

  const close = (): void => { stop(); onClose() }

  return (
    <Modal open onClose={close} title="Take a photo" width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '14px 16px',
              borderRadius: 'var(--r-card)',
              background: 'var(--st-needsyou-wash, var(--bg-input))',
              border: '1px solid var(--st-needsyou-bd, var(--bd-1))',
              color: 'var(--st-needsyou, var(--tx-2))',
              fontSize: 'var(--fs-meta)'
            }}
          >
            <Icon name="warn" size={16} />
            <span>{error}</span>
          </div>
        ) : (
          <div
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '4 / 3',
              borderRadius: 'var(--r-card)',
              overflow: 'hidden',
              background: '#000',
              border: '1px solid var(--bd-1)'
            }}
          >
            <video
              ref={videoRef}
              playsInline
              muted
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            {!ready && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--tx-dim)',
                  fontSize: 'var(--fs-meta)'
                }}
              >
                Starting camera…
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          {!error && (
            <Button variant="primary" disabled={!ready} onClick={capture}>
              <Icon name="camera" size={12} color="var(--tx-onaccent)" /> Capture
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

/**
 * AttachChips — the row of attached-file chips (filename + remove ✕) shown above
 * the composer input. Wraps so many attachments never stretch or overflow the
 * composer row. Also renders the hook's transient error. Renders nothing when
 * there are no attachments and no error.
 */
export function AttachChips({ attach }: { attach: UseAttachments }): React.JSX.Element | null {
  if (attach.items.length === 0 && !attach.error) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
      {attach.items.map((a) => (
        <span
          key={a.relPath}
          title={a.relPath}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: 220,
            padding: '3px 6px 3px 8px',
            borderRadius: 'var(--r-chip)',
            background: 'var(--bg-chip-idle, var(--bg-input))',
            border: '1px solid var(--bd-1)'
          }}
        >
          <Icon name="paperclip" size={11} color="var(--tx-dim)" />
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 'var(--fs-tiny)',
              color: 'var(--tx-1)'
            }}
          >
            {a.name}
          </span>
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            onClick={() => attach.remove(a.relPath)}
            style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', color: 'var(--tx-ghost)', lineHeight: 1 }}
          >
            <Icon name="close" size={9} />
          </button>
        </span>
      ))}
      {attach.error && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-tiny)', color: 'var(--st-error, var(--tx-dim))' }}>
          <Icon name="warn" size={11} /> {attach.error}
        </span>
      )}
    </div>
  )
}
