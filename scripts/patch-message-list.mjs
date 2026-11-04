/**
 * Optional host patch: make dsh-TUI hide tool cards and thinking blocks.
 *
 * dsh-TUI's plugin API has no transcript-row seam — a plugin can add footer
 * fields, panels and scenes, but it cannot drop rows from the chat. The rows
 * ARE filtered before virtualization for two built-ins (`thinkingVisible`,
 * `turnUsageRow`), which is the correct place to remove one: a filtered row
 * leaves no cached height, no mounted node and no stale click target.
 *
 * So this script inserts two filters next to that built-in pair:
 *
 *     if (__countsMode.hideTools === true && !expanded)   drop 'tool' rows
 *     if (__countsMode.hideThinking === true && !expanded) drop 'reasoning' rows
 *
 * `expanded` is the Ctrl+O switch and it already participates in the visible
 * rows cache key, so Ctrl+O both reveals the cards again and invalidates the
 * cached window — no host change is needed for the toggle to paint correctly.
 *
 * Rules:
 * - Idempotent: a sentinel comment marks an already-patched file.
 * - Conservative: an anchor that does not match (a host release changed shape)
 *   is a silent no-op, never a half-applied edit. The TUI keeps working.
 * - Reversible: the first patch keeps a `.dsh-tui-counts.orig` copy, and
 *   `--revert` restores it.
 * - The file is written through a temp file in the same directory and renamed,
 *   so an interrupted install cannot leave a truncated component.
 *
 * @module dsh-tui-counts/scripts/patch-message-list
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SENTINEL = '/* dsh-tui-counts:row-filter */'
const BACKUP_SUFFIX = '.dsh-tui-counts.orig'
const RELATIVE = join('lib', 'types', 'components', 'MessageList.js')

const ANCHOR = `        if (!turnUsageRow)
            out = out.filter(row => row.kind !== 'turn-summary');`

const PATCH = `${ANCHOR}
        ${SENTINEL}
        // Optional row removal (dsh-tui-counts). Both flags are read from the
        // plugin's process-global switch and are gated on Ctrl+O so expanding
        // the transcript always brings the rows back.
        const __countsMode = globalThis.__dshTuiCounts;
        if (__countsMode !== undefined && __countsMode.hideTools === true && !expanded)
            out = out.filter(row => row.kind !== 'tool');
        if (__countsMode !== undefined && __countsMode.hideThinking === true && !expanded)
            out = out.filter(row => row.kind !== 'reasoning');`

/** Places a dsh-tui host package may live, most specific first. */
export function hostCandidates() {
  const here = dirname(fileURLToPath(import.meta.url))
  const home = homedir()
  const list = [
    process.env.DSH_TUI_HOST ?? '',
    // The plugin's own install: <profile>/node_modules/dsh-tui-counts/scripts
    join(here, '..', '..', '@deepseek-harness-tui', 'dsh-tui'),
    join(home, '.dsh', 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui'),
    join(home, '.dsh', 'profiles', 'tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui'),
    join(home, '.npm-global', 'lib', 'node_modules', '@deepseek-harness-tui', 'dsh-tui'),
    '/usr/local/lib/node_modules/@deepseek-harness-tui/dsh-tui',
    '/usr/lib/node_modules/@deepseek-harness-tui/dsh-tui',
  ]
  return list.filter((entry) => entry !== '')
}

/** First existing `MessageList.js` among {@link hostCandidates}. */
export function findMessageList() {
  for (const root of hostCandidates()) {
    const file = join(root, RELATIVE)
    try {
      if (statSync(file).isFile()) return file
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

/**
 * Patch one file.
 * @param file - Absolute path to the host's `MessageList.js`.
 * @returns `'patched'`, `'already'` or `'anchor-missing'`.
 */
export function patchFile(file) {
  const source = readFileSync(file, 'utf8')
  if (source.includes(SENTINEL)) return 'already'
  if (!source.includes(ANCHOR)) return 'anchor-missing'
  const backup = `${file}${BACKUP_SUFFIX}`
  if (!existsSync(backup)) writeFileSync(backup, source)
  const next = source.replace(ANCHOR, PATCH)
  const temp = `${file}.dsh-tui-counts.tmp`
  writeFileSync(temp, next)
  renameSync(temp, file)
  return 'patched'
}

/**
 * Restore the pre-patch file.
 * @param file - Absolute path to the host's `MessageList.js`.
 * @returns `'reverted'` or `'no-backup'`.
 */
export function revertFile(file) {
  const backup = `${file}${BACKUP_SUFFIX}`
  if (!existsSync(backup)) return 'no-backup'
  writeFileSync(file, readFileSync(backup, 'utf8'))
  try {
    unlinkSync(backup)
  } catch {
    /* the restore already happened */
  }
  return 'reverted'
}

/**
 * Best-effort patch entry point. Never throws: a failed patch degrades to
 * "tool cards stay visible", never to a broken TUI or a broken install.
 * @param options - `revert` undoes the patch, `quiet` silences the report.
 */
export function applyHostPatch(options = {}) {
  try {
    const file = findMessageList()
    if (file === undefined) return { status: 'host-not-found' }
    const status = options.revert === true ? revertFile(file) : patchFile(file)
    if (options.quiet !== true) {
      const message = {
        patched: 'dsh-tui-counts: row filter installed (tool cards/thinking blocks can be hidden)',
        already: 'dsh-tui-counts: row filter already installed',
        'anchor-missing': 'dsh-tui-counts: this dsh-TUI build does not match the patch anchor — row hiding unavailable',
        reverted: 'dsh-tui-counts: row filter removed (original host file restored)',
        'no-backup': 'dsh-tui-counts: nothing to revert',
        'host-not-found': 'dsh-tui-counts: dsh-TUI not found, nothing patched',
      }[status]
      if (message !== undefined) console.log(message)
    }
    return { status, file }
  } catch (error) {
    if (options.quiet !== true) {
      console.log(`dsh-tui-counts: row filter not applied (${error instanceof Error ? error.message : String(error)})`)
    }
    return { status: 'error' }
  }
}

// CLI: node scripts/patch-message-list.mjs [--revert] [--quiet]
if (process.argv[1] !== undefined && process.argv[1].endsWith('patch-message-list.mjs')) {
  applyHostPatch({
    revert: process.argv.includes('--revert'),
    quiet: process.argv.includes('--quiet'),
  })
}
