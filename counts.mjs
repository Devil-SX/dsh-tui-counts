/**
 * Pure counting core for dsh-tui-counts.
 *
 * Folds DSH durable session events into two ledgers — the current (or last)
 * turn and the whole session — with no Cordis, React or terminal dependency,
 * so the numbers can be unit-tested without booting a TUI.
 *
 * Event vocabulary comes from `@deepseek-ai/dsh-session`
 * (`SessionEventMap`): `turn/start`, `tool/call`, `assistant/message`
 * (carrying `usage` and reasoning blocks), `turn/end`.
 *
 * @module dsh-tui-counts/counts
 */

/** Fields every ledger carries. */
const EMPTY = Object.freeze({
  tools: 0,
  thoughts: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

/** A fresh mutable ledger. */
export function emptyLedger() {
  return { ...EMPTY, byName: Object.create(null) }
}

/** Deep copy a ledger (used when a turn closes into the session ledger). */
function cloneLedger(source) {
  return {
    tools: source.tools,
    thoughts: source.thoughts,
    input: source.input,
    output: source.output,
    cacheRead: source.cacheRead,
    cacheWrite: source.cacheWrite,
    byName: { ...source.byName },
  }
}

/**
 * Reasoning blocks in one assistant message.
 *
 * DSH content blocks carry `type: 'reasoning'`; older or provider-specific
 * shapes spelled it `thinking`. Anything else is ignored, so a text block can
 * never be counted as a thought. A block counts as one segment by its type
 * alone: a redacted or provider-encrypted block has no visible text but is
 * still a thinking segment the model spent output tokens on.
 * @param message - `assistant/message` payload (`data.message`).
 * @returns number of reasoning blocks, 0 for an unusable shape.
 */
export function countReasoningBlocks(message) {
  if (message === null || typeof message !== 'object') return 0
  const content = message.content
  if (!Array.isArray(content)) return 0
  let count = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'reasoning' && block.type !== 'thinking') continue
    count += 1
  }
  return count
}

/** Read one numeric usage field, treating junk as 0. */
function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

/**
 * Two-scope counter over one session's event log.
 *
 * `turn` resets at `turn/start` and stops at `turn/end`, so it always means
 * "the turn you just watched" (or the one running now). `session` accumulates
 * for the life of the session object and survives compaction: it is folded
 * from the log, not from the model-visible context.
 */
export class SessionCounts {
  /** Sequence number of the last folded event; -1 before any fold. */
  lastSeq = -1

  constructor() {
    this.turn = emptyLedger()
    this.session = emptyLedger()
    this.turnNumber = 0
    this.running = false
    this.turnStartedAt = 0
    this.lastTurnAt = 0
  }

  /**
   * Fold one durable event.
   * @param event - `SessionEvent` (`{ type, seq, time, data }`).
   * @returns true when the ledger changed.
   */
  fold(event) {
    if (event === null || typeof event !== 'object') return false
    const seq = Number(event.seq)
    if (Number.isFinite(seq)) {
      // Replay safety: a seeded snapshot followed by the live stream must not
      // count the same event twice.
      if (seq <= this.lastSeq) return false
      this.lastSeq = seq
    }
    const at = Number.isFinite(Number(event.time)) ? Number(event.time) : Date.now()
    const data = event.data ?? {}

    switch (event.type) {
      case 'turn/start': {
        this.turn = emptyLedger()
        this.turnNumber = Number.isFinite(Number(data.turn)) ? Number(data.turn) : this.turnNumber + 1
        this.running = true
        this.turnStartedAt = at
        return true
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' && data.name !== '' ? data.name : 'tool'
        for (const ledger of [this.turn, this.session]) {
          ledger.tools += 1
          ledger.byName[name] = (ledger.byName[name] ?? 0) + 1
        }
        return true
      }
      case 'assistant/message': {
        const thoughts = countReasoningBlocks(data.message)
        const usage = data.usage
        for (const ledger of [this.turn, this.session]) {
          ledger.thoughts += thoughts
          if (usage !== null && typeof usage === 'object') {
            ledger.input += num(usage.inputTokens)
            ledger.output += num(usage.outputTokens)
            ledger.cacheRead += num(usage.cacheReadTokens)
            ledger.cacheWrite += num(usage.cacheWriteTokens)
          }
        }
        return thoughts > 0 || usage !== undefined
      }
      case 'turn/end': {
        this.running = false
        this.lastTurnAt = at
        return true
      }
      default:
        return false
    }
  }

  /**
   * The ledger a scope renders.
   * @param scope - `'turn'` (current/last turn) or `'session'`.
   */
  ledger(scope) {
    return scope === 'session' ? this.session : this.turn
  }

  /** Whether anything worth showing has happened yet. */
  get hasData() {
    const turn = this.turn
    const session = this.session
    return (
      turn.tools + turn.thoughts > 0 ||
      session.tools + session.thoughts > 0 ||
      turn.input + turn.output > 0 ||
      session.input + session.output > 0
    )
  }

  /** Immutable snapshot, safe to persist or hand to a renderer. */
  snapshot(scope) {
    const ledger = this.ledger(scope)
    return {
      scope,
      turnNumber: this.turnNumber,
      running: this.running,
      tools: ledger.tools,
      thoughts: ledger.thoughts,
      input: ledger.input,
      output: ledger.output,
      cacheRead: ledger.cacheRead,
      cacheWrite: ledger.cacheWrite,
      byName: { ...ledger.byName },
    }
  }
}

/**
 * Compact token count: 942 → `942`, 1000 → `1.0k`, 34200 → `34.2k`,
 * 1_250_000 → `1.3M`. Rounding is floored at a tenth so 999_999 never reads
 * as `1.0M` before it really is one.
 * @param value - Token count.
 */
export function fmtTokens(value) {
  const n = Math.max(0, Math.round(Number(value) || 0))
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k < 100 ? k.toFixed(1) : Math.floor(k)}k`
  }
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * One-line footer text.
 *
 * Cells stay well under the host's 32-cell field cap: `工具12·思考8·34.2k`.
 * The `·` separators are dropped before a field would be truncated — a
 * clipped count reads as a different number, so precedence is decided here.
 *
 * @param snapshot - Output of {@link SessionCounts.snapshot}.
 * @param options - `ascii: true` swaps the separators for `|`.
 */
export function fieldText(snapshot, options = {}) {
  const sep = options.ascii === true ? ' | ' : '·'
  if (snapshot === undefined) return ''
  const parts = []
  if (snapshot.tools > 0) parts.push(`工具${snapshot.tools}`)
  if (snapshot.thoughts > 0) parts.push(`思考${snapshot.thoughts}`)
  const billed = snapshot.input + snapshot.output
  if (billed > 0) parts.push(fmtTokens(billed))
  if (parts.length === 0) return snapshot.running ? '…' : ''
  return parts.join(sep)
}

/**
 * Hover detail: the whole ledger, including the per-tool split.
 *
 * Capped at 160 cells by the host; the tool list is shortened first.
 * @param snapshot - Output of {@link SessionCounts.snapshot}.
 * @param options - `scopeLabel` names the scope, `ascii` drops the CJK glyphs.
 */
export function detailText(snapshot, options = {}) {
  if (snapshot === undefined) return ''
  const scope = options.scopeLabel ?? (snapshot.scope === 'session' ? '会话' : '本轮')
  const style = options.ascii === true
  const sep = style ? ' | ' : ' · '
  const lines = []
  lines.push(`${scope}${snapshot.turnNumber > 0 ? ` #${snapshot.turnNumber}` : ''}${snapshot.running ? (style ? ' (running)' : '（进行中）') : ''}`)
  lines.push(`${style ? 'tools' : '工具'} ${snapshot.tools}${style ? '' : ' 次'}${style ? '' : ''}`)
  lines.push(`${style ? 'thinking' : '思考'} ${snapshot.thoughts}${style ? ' blocks' : ' 段'}`)
  const tokens = `in ${fmtTokens(snapshot.input)} / out ${fmtTokens(snapshot.output)}`
  const cache = snapshot.cacheRead + snapshot.cacheWrite > 0
    ? ` / cache ${fmtTokens(snapshot.cacheRead)}r ${fmtTokens(snapshot.cacheWrite)}w`
    : ''
  lines.push(`${style ? 'tokens' : 'token'} ${tokens}${cache}`)
  const names = Object.entries(snapshot.byName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name} ${count}`)
  if (names.length > 0) lines.push(names.join(sep))
  lines.push(style ? 'click: switch turn/session' : '点击：切换 本轮 / 会话')
  return lines.join(sep)
}
