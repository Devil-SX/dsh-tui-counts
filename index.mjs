/**
 * dsh-tui-counts — a prompt-footer counter for DeepSeek Harness sessions.
 *
 * Instead of reading every tool card and thinking block, fold the durable
 * session log into two ledgers (current turn / whole session) and show one
 * compact cell in the footer: `工具12·思考8·34.2k` — tool calls, thinking
 * segments, billed tokens. Hover for the per-tool split, click to switch the
 * scope.
 *
 * Design constraints:
 * - Rendering is a footer FIELD (`ctx.tuiStatus.setField`), never a new row:
 *   it must not compete with the TUI's own status line.
 * - Counting is presentation-only. The plugin reads the append-only log and
 *   never writes to it, so prompts, compaction and resume are untouched.
 * - Counters are per session and seeded from `snapshotEvents(0)` on first
 *   sight, then advanced by `session/event`. Restored sessions do not replay
 *   their stored prefix on the bus, so seeding is the only correct way to
 *   count a resumed session.
 * - Nothing in here may throw into the host: every seam call is guarded.
 *
 * @module dsh-tui-counts
 */

import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SessionCounts, detailText, fieldText } from './counts.mjs'
import { applyHostPatch } from './scripts/patch-message-list.mjs'

export const name = 'tui-counts'
export const inject = ['tuiStatus']

const FIELD_KEY = 'counts'
// `DSH_TUI_COUNTS_HOME` exists so tests (and unusual installs) can point the
// saved scope and the resume marker somewhere other than the real home.
const ROOT = process.env.DSH_TUI_COUNTS_HOME || join(homedir(), '.dsh-tui')
const SETTINGS_FILE = join(ROOT, 'counts.json')
const RESUME_FILE = join(ROOT, 'resume.txt')
const RENDER_DELAY_MS = 120

const envFlag = (key) => ['1', 'true', 'yes', 'on'].includes(String(process.env[key] ?? '').toLowerCase())

/** Read the saved settings object, tolerating a missing or broken file. */
function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return raw !== null && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/**
 * Which transcript rows to remove.
 *
 * The host has no plugin seam for rows, so these flags are consumed by the
 * optional `MessageList.js` patch (see `scripts/patch-message-list.mjs`). They
 * are read at module scope, before the TUI mounts, so the very first frame is
 * already filtered.
 *
 * `DSH_TUI_COUNTS_HIDE` is a comma list of `tools` / `thinking` / `none` / `all`
 * and outranks the saved booleans.
 */
function readHideMode() {
  const saved = readSettings()
  let hideTools = saved.hideTools === true
  let hideThinking = saved.hideThinking === true
  const raw = String(process.env.DSH_TUI_COUNTS_HIDE ?? '').trim().toLowerCase()
  if (raw !== '') {
    const wanted = new Set(raw.split(/[,\s]+/).filter(Boolean))
    if (wanted.has('none')) {
      hideTools = false
      hideThinking = false
    } else if (wanted.has('all')) {
      hideTools = true
      hideThinking = true
    } else {
      hideTools = wanted.has('tools')
      hideThinking = wanted.has('thinking')
    }
  }
  return { hideTools, hideThinking }
}

function readScope() {
  const fromEnv = String(process.env.DSH_TUI_COUNTS_SCOPE ?? '').trim().toLowerCase()
  if (fromEnv === 'turn' || fromEnv === 'session') return fromEnv
  const saved = readSettings().scope
  if (saved === 'session' || saved === 'turn') return saved
  return 'turn'
}

function writeSettings(patch) {
  try {
    mkdirSync(ROOT, { recursive: true })
    const next = { version: 1, ...readSettings(), ...patch }
    writeFileSync(SETTINGS_FILE, JSON.stringify(next), { mode: 0o600 })
  } catch {
    /* a failed save must not block the toggle */
  }
}

function readResumeId() {
  try {
    return readFileSync(RESUME_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

/** True for a session the user is not driving directly (a subagent's log). */
function isBackgroundSession(session) {
  const header = session?.header
  return header !== null && typeof header === 'object' && header.origin === 'subagent'
}

// The host's MessageList reads this while rendering; setting it at module
// scope (not inside apply) gives the first frame the final answer.
const hideMode = readHideMode()
globalThis.__dshTuiCounts = { ...hideMode }

// Patch the host's row filter as early as possible: at module evaluation the
// host's Chat/MessageList modules are still behind a dynamic import, so a patch
// written here can land before React renders its first frame. The later retry
// inside apply() covers package managers that import plugins differently.
if ((hideMode.hideTools || hideMode.hideThinking) && !envFlag('DSH_TUI_COUNTS_NO_PATCH')) {
  try {
    applyHostPatch({ quiet: true })
  } catch {
    /* an optional patch never disturbs the TUI */
  }
}

export function apply(ctx) {
  const ascii = envFlag('DSH_TUI_COUNTS_ASCII')
  // A skipped postinstall (workspace install, --ignore-scripts) would leave the
  // row filter out of the host; retry it here. The host module is usually
  // already imported by now, so a fresh patch takes effect on the next launch.
  try {
    if (!envFlag('DSH_TUI_COUNTS_NO_PATCH')) applyHostPatch({ quiet: true })
  } catch {
    /* never disturb the TUI for an optional patch */
  }
  let scope = readScope()
  let disposed = false
  let fieldDispose
  let renderTimer
  let watcher
  let lastSessionId = ''

  /** @type {Map<string, { session: unknown, counts: SessionCounts }>} */
  const sessions = new Map()

  /**
   * Get (and seed) the counter for one session.
   *
   * `snapshotEvents` is the only complete view of a restored session: the
   * stored prefix never publishes on `session/event`, so a resumed session
   * would otherwise start at zero. `lastSeq` inside {@link SessionCounts}
   * makes a re-seed idempotent.
   */
  const stateFor = (session) => {
    const id = String(session?.id ?? '')
    if (id === '') return undefined
    const known = sessions.get(id)
    if (known !== undefined) {
      if (known.session !== session) known.session = session
      return known
    }
    const counts = new SessionCounts()
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(0) : undefined
      if (Array.isArray(events)) for (const event of events) counts.fold(event)
    } catch {
      /* a detached or closed session simply keeps live-only counts */
    }
    const entry = { session, counts }
    sessions.set(id, entry)
    return entry
  }

  /** The session whose numbers the single footer seat shows. */
  const activeSession = () => {
    const resumeId = readResumeId()
    if (resumeId !== '') {
      const parked = sessions.get(resumeId)
      if (parked !== undefined) return parked
    }
    if (lastSessionId !== '') {
      const last = sessions.get(lastSessionId)
      if (last !== undefined) return last
    }
    return undefined
  }

  const render = () => {
    if (disposed) return
    const active = activeSession()
    const snapshot = active?.counts.snapshot(scope)
    const text = snapshot === undefined || !active.counts.hasData ? '' : fieldText(snapshot, { ascii })
    const detail = text === '' ? '' : detailText(snapshot, { ascii })
    try {
      // An empty text clears the field, so an idle fresh session shows nothing
      // instead of a row of zeroes.
      fieldDispose = ctx.tuiStatus.setField(FIELD_KEY, text, {
        slot: 'left-tail',
        tone: snapshot?.running === true ? 'accent' : 'dim',
        maxCells: 32,
        minColumns: 100,
        ...(detail === '' ? {} : { detail }),
        ...(detail === ''
          ? {}
          : {
              onClick: () => {
                scope = scope === 'turn' ? 'session' : 'turn'
                writeSettings({ scope })
                render()
              },
            }),
      }, ctx)
    } catch {
      /* the field seam being unavailable must not disturb the TUI */
    }
  }

  const scheduleRender = (immediate = false) => {
    if (disposed) return
    if (immediate) {
      if (renderTimer !== undefined) {
        clearTimeout(renderTimer)
        renderTimer = undefined
      }
      render()
      return
    }
    if (renderTimer !== undefined) return
    renderTimer = setTimeout(() => {
      renderTimer = undefined
      render()
    }, RENDER_DELAY_MS)
    renderTimer.unref?.()
  }

  // --- durable log -------------------------------------------------------
  ctx.on('session/created', (session) => {
    if (isBackgroundSession(session)) return
    stateFor(session)
    lastSessionId = String(session?.id ?? '')
    scheduleRender(true)
  })

  ctx.on('session/event', (session, event) => {
    if (isBackgroundSession(session)) return
    const entry = stateFor(session)
    if (entry === undefined) return
    lastSessionId = String(session?.id ?? '')
    const changed = entry.counts.fold(event)
    if (!changed) return
    // A turn closing is the one moment the counter must be exact right away.
    scheduleRender(event?.type === 'turn/end' || event?.type === 'tool/call')
  })

  ctx.on('session/disposed', (session) => {
    const id = String(session?.id ?? '')
    if (id !== '') sessions.delete(id)
    if (lastSessionId === id) lastSessionId = ''
    scheduleRender(true)
  })

  // --- foreground session -------------------------------------------------
  // `tui/session-switched` is a DecisionEvent (a plain `ctx.on` never sees it),
  // and switching to a parked live session fires no `session/created`. The TUI
  // rewrites resume.txt on every foreground switch, so that file is the
  // reliable "which session is on screen" signal.
  let lastResumeId = readResumeId()
  const onResumeChanged = () => {
    const next = readResumeId()
    if (next === lastResumeId) return
    lastResumeId = next
    scheduleRender(true)
  }
  try {
    watcher = watch(RESUME_FILE, { persistent: false }, onResumeChanged)
  } catch {
    try {
      watcher = watch(ROOT, { persistent: false }, (_event, filename) => {
        if (filename === 'resume.txt' || filename === null) onResumeChanged()
      })
    } catch {
      /* no watcher: event-driven switching still covers new sessions */
    }
  }
  watcher?.unref?.()
  watcher?.on?.('error', () => {
    try {
      watcher.close()
    } catch {
      /* already closed */
    }
  })

  scheduleRender(true)

  ctx.on('dispose', () => {
    disposed = true
    if (renderTimer !== undefined) clearTimeout(renderTimer)
    try {
      watcher?.close()
    } catch {
      /* teardown */
    }
    try {
      fieldDispose?.()
    } catch {
      /* teardown */
    }
    sessions.clear()
  })
}
