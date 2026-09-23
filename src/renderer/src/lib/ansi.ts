/**
 * ansi.ts — strip terminal escape sequences from raw loop/provider output before
 * it's shown in a NON-terminal surface (the read-only loop LogPane, the Raw-log
 * pre). Those panes render text in a plain <pre>, so an ESC byte (\x1b) shows as a
 * □ box and its `[90m…[0m` colour codes leak in as literal text — the reported
 * "squares in the swarm/loop rendering" bug.
 *
 * We handle the full SGR/CSI/OSC families, not just `\x1b[…m`, so cursor-move and
 * erase codes are removed too, then drop any leftover C0 control bytes (keeping
 * \t \n \r). Kept as a standalone, side-effect-free helper so it's cheap to reuse.
 */

/* eslint-disable no-control-regex */
// CSI: ESC [ params intermediates final-byte (colour, cursor, erase, private '?').
const CSI = /\x1b\[[0-9;?:]*[ -/]*[@-~]/g
// OSC: ESC ] ... terminated by BEL (\x07) or ST (ESC \). Window titles etc.
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g
// A single-character escape (ESC + one byte) — charset selects, RIS, etc.
const SINGLE = /\x1b[@-_]/g
// Any remaining stray ESC.
const STRAY_ESC = /\x1b/g
// Leftover C0 control chars EXCEPT tab (\x09), newline (\x0a), carriage return (\x0d).
const C0 = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
/* eslint-enable no-control-regex */

/** Remove ANSI/terminal escape sequences and stray control bytes from `s`. */
export function stripAnsi(s: string): string {
  if (!s || s.indexOf('\x1b') === -1 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) return s
  return s
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(SINGLE, '')
    .replace(STRAY_ESC, '')
    .replace(C0, '')
}

export default stripAnsi
