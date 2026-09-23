import { useCallback, useState } from 'react'

/**
 * useAttachments — shared attachment state for a composer (the Activity task
 * composer and the Chat steer composer both use it).
 *
 * An attachment is provider-agnostic: the raw bytes are SAVED into the agent's
 * workspace (`attachments/<name>`) via the `attachments:save` main-process IPC,
 * and the composer references the returned relative path in the task/message text
 * so the agent can read the file when it acts. We never send a multimodal payload
 * to any provider — save-to-workspace + reference is robust for every engine.
 *
 * The hook owns: the list of saved items (chips), a busy flag while a save is in
 * flight, and the last error. `addFiles` accepts a picked `FileList`; `addPhoto`
 * accepts an already-base64 PNG (from the camera modal). Both save immediately so
 * a chip only ever represents a file that is actually on disk.
 */
export interface Attachment {
  /** workspace-relative path, e.g. "attachments/photo-1723.png" */
  relPath: string
  /** display name (basename of relPath) */
  name: string
}

export interface UseAttachments {
  items: Attachment[]
  busy: boolean
  error: string
  addFiles: (files: FileList | File[]) => Promise<void>
  addPhoto: (base64Png: string, filename?: string) => Promise<void>
  remove: (relPath: string) => void
  clear: () => void
  clearError: () => void
}

/** Read a File/Blob as base64 (no data-URL prefix). */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error('Could not read file'))
    r.onload = () => {
      const s = String(r.result || '')
      const comma = s.indexOf(',')
      resolve(comma >= 0 ? s.slice(comma + 1) : s)
    }
    r.readAsDataURL(blob)
  })
}

export function useAttachments(agentPath: string): UseAttachments {
  const [items, setItems] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const saveOne = useCallback(
    async (blob: Blob, filename: string): Promise<void> => {
      const base64 = await toBase64(blob)
      const r = await window.api.attachmentsSave(agentPath, filename, base64)
      if ('error' in r) {
        setError(r.error)
        return
      }
      const name = r.relPath.split('/').pop() || r.relPath
      // Dedupe by relPath (main-process uniquifies names, so this is just defensive).
      setItems((prev) => (prev.some((a) => a.relPath === r.relPath) ? prev : [...prev, { relPath: r.relPath, name }]))
    },
    [agentPath]
  )

  const addFiles = useCallback(
    async (files: FileList | File[]): Promise<void> => {
      const list = Array.from(files)
      if (list.length === 0) return
      setBusy(true)
      setError('')
      try {
        for (const f of list) await saveOne(f, f.name || 'attachment')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to attach file')
      } finally {
        setBusy(false)
      }
    },
    [saveOne]
  )

  const addPhoto = useCallback(
    async (base64Png: string, filename?: string): Promise<void> => {
      setBusy(true)
      setError('')
      try {
        const r = await window.api.attachmentsSave(agentPath, filename || `photo-${Date.now()}.png`, base64Png)
        if ('error' in r) {
          setError(r.error)
          return
        }
        const name = r.relPath.split('/').pop() || r.relPath
        setItems((prev) => [...prev, { relPath: r.relPath, name }])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save photo')
      } finally {
        setBusy(false)
      }
    },
    [agentPath]
  )

  const remove = useCallback((relPath: string) => {
    // Drops the chip only; the saved file stays in the workspace (harmless, and
    // removing files the agent may already reference would be surprising).
    setItems((prev) => prev.filter((a) => a.relPath !== relPath))
  }, [])

  const clear = useCallback(() => setItems([]), [])
  const clearError = useCallback(() => setError(''), [])

  return { items, busy, error, addFiles, addPhoto, remove, clear, clearError }
}

/** Append a readable attachment reference to a task/message line. */
export function withAttachmentRefs(text: string, items: Attachment[]): string {
  if (items.length === 0) return text
  const refs = items.map((a) => a.relPath).join(', ')
  const base = text.trim()
  return base ? `${base} (attachments: ${refs})` : `Review the attached file(s): ${refs}`
}
