import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SessionCounts,
  countReasoningBlocks,
  detailText,
  emptyLedger,
  fieldText,
  fmtTokens,
} from '../counts.mjs'

/** Build one durable event in the host's envelope shape. */
const ev = (seq, type, data = {}, time = 1_700_000_000_000 + seq) => ({ seq, type, time, data })

const reasoning = (text = 'thinking here') => ({ type: 'reasoning', text })
const text = (body = 'answer') => ({ type: 'text', text: body })

test('a fresh ledger counts nothing', () => {
  const counts = new SessionCounts()
  assert.equal(counts.hasData, false)
  assert.equal(fieldText(counts.snapshot('turn')), '')
})

test('tools, thinking blocks and usage land in both ledgers', () => {
  const counts = new SessionCounts()
  counts.fold(ev(0, 'turn/start', { turn: 1 }))
  counts.fold(ev(1, 'tool/call', { callId: 'c1', name: 'read', arguments: {} }))
  counts.fold(ev(2, 'tool/call', { callId: 'c2', name: 'bash', arguments: {} }))
  counts.fold(
    ev(3, 'assistant/message', {
      message: { content: [reasoning(), text()] },
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0 },
    }),
  )

  const turn = counts.snapshot('turn')
  assert.equal(turn.tools, 2)
  assert.equal(turn.thoughts, 1)
  assert.equal(turn.input, 1200)
  assert.equal(turn.output, 300)
  assert.equal(turn.cacheRead, 800)
  assert.deepEqual(turn.byName, { read: 1, bash: 1 })
  assert.equal(turn.running, true)

  // Session scope equals the turn so far.
  assert.deepEqual(counts.snapshot('session').byName, { read: 1, bash: 1 })
})

test('turn scope resets, session scope accumulates', () => {
  const counts = new SessionCounts()
  counts.fold(ev(0, 'turn/start', { turn: 1 }))
  counts.fold(ev(1, 'tool/call', { name: 'read', callId: 'a' }))
  counts.fold(ev(2, 'assistant/message', { message: { content: [reasoning()] }, usage: { inputTokens: 100, outputTokens: 10 } }))
  counts.fold(ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))

  assert.equal(counts.snapshot('turn').tools, 1)
  assert.equal(counts.snapshot('turn').running, false)

  counts.fold(ev(4, 'turn/start', { turn: 2 }))
  counts.fold(ev(5, 'tool/call', { name: 'edit', callId: 'b' }))

  const turn = counts.snapshot('turn')
  assert.equal(turn.turnNumber, 2)
  assert.equal(turn.tools, 1)
  assert.equal(turn.thoughts, 0)
  assert.deepEqual(turn.byName, { edit: 1 })

  const session = counts.snapshot('session')
  assert.equal(session.tools, 2)
  assert.equal(session.thoughts, 1)
  assert.deepEqual(session.byName, { read: 1, edit: 1 })
  assert.equal(session.input, 100)
})

test('replayed events are ignored, so seeding plus the live stream never double counts', () => {
  const counts = new SessionCounts()
  for (const event of [ev(0, 'turn/start', { turn: 1 }), ev(1, 'tool/call', { name: 'bash', callId: 'x' })]) {
    counts.fold(event)
  }
  // A second seed of the same log (snapshot + bus catch-up) must be a no-op.
  assert.equal(counts.fold(ev(1, 'tool/call', { name: 'bash', callId: 'x' })), false)
  assert.equal(counts.fold(ev(0, 'turn/start', { turn: 1 })), false)
  assert.equal(counts.snapshot('session').tools, 1)

  counts.fold(ev(2, 'tool/call', { name: 'read', callId: 'y' }))
  assert.equal(counts.snapshot('session').tools, 2)
})

test('unknown events and junk payloads are ignored without throwing', () => {
  const counts = new SessionCounts()
  for (const event of [null, undefined, {}, { type: 'todo/write', seq: 1, data: null }, { type: 'tool/call', seq: 2 }]) {
    counts.fold(event)
  }
  assert.equal(counts.snapshot('session').tools, 1)
  assert.equal(counts.fold({ type: 'assistant/message', seq: 3, data: { message: 'nope' } }), false)
})

test('every reasoning block counts as one segment, text or not', () => {
  assert.equal(countReasoningBlocks({ content: [reasoning(), text()] }), 1)
  assert.equal(countReasoningBlocks({ content: [{ type: 'reasoning', text: '   ' }] }), 1)
  // A redacted block carries an encrypted payload instead of text; it is still
  // a thinking segment the model paid for.
  assert.equal(countReasoningBlocks({ content: [{ type: 'reasoning' }] }), 1)
  assert.equal(countReasoningBlocks({ content: 'text' }), 0)
  assert.equal(countReasoningBlocks(null), 0)
  assert.equal(countReasoningBlocks({ content: [{ type: 'thinking', text: 'ok' }] }), 1)
})

test('interrupted turns still count their delivered prefix', () => {
  const counts = new SessionCounts()
  counts.fold(ev(0, 'turn/start', { turn: 1 }))
  counts.fold(
    ev(1, 'assistant/message', {
      interrupted: true,
      message: { content: [reasoning(), text('partial')] },
      usage: { inputTokens: 10, outputTokens: 2 },
    }),
  )
  counts.fold(ev(2, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }))
  assert.equal(counts.snapshot('turn').thoughts, 1)
  assert.equal(counts.snapshot('turn').input, 10)
})

test('token formatting stays short enough for the footer cap', () => {
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(942), '942')
  assert.equal(fmtTokens(1000), '1.0k')
  assert.equal(fmtTokens(34200), '34.2k')
  assert.equal(fmtTokens(999_999), '999k')
  assert.equal(fmtTokens(1_250_000), '1.3M')
  assert.equal(fmtTokens(-5), '0')
  assert.equal(fmtTokens('junk'), '0')
})

test('field text reports only what happened', () => {
  const counts = new SessionCounts()
  counts.fold(ev(0, 'turn/start', { turn: 1 }))
  assert.equal(fieldText(counts.snapshot('turn')), '…')

  counts.fold(ev(1, 'tool/call', { name: 'bash', callId: 'a' }))
  assert.equal(fieldText(counts.snapshot('turn')), '工具1')

  counts.fold(ev(2, 'assistant/message', { message: { content: [reasoning()] }, usage: { inputTokens: 30000, outputTokens: 200 } }))
  assert.equal(fieldText(counts.snapshot('turn')), '工具1·思考1·30.2k')
  assert.equal(fieldText(counts.snapshot('turn'), { ascii: true }), '工具1 | 思考1 | 30.2k')
})

test('field text fits the 32-cell cap in the worst plausible case', () => {
  const counts = new SessionCounts()
  counts.fold(ev(0, 'turn/start', { turn: 9 }))
  for (let i = 0; i < 120; i += 1) counts.fold(ev(i + 1, 'tool/call', { name: 'bash', callId: `c${i}` }))
  counts.fold(ev(500, 'assistant/message', { message: { content: [reasoning(), reasoning()] }, usage: { inputTokens: 1_200_000, outputTokens: 40_000 } }))
  const text = fieldText(counts.snapshot('turn'))
  const cells = Array.from(text).reduce((sum, ch) => sum + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0)
  assert.ok(cells <= 32, `${text} is ${cells} cells`)
})

test('detail text explains the scope and the split', () => {
  const counts = new SessionCounts()
  counts.fold(ev(0, 'turn/start', { turn: 3 }))
  counts.fold(ev(1, 'tool/call', { name: 'read', callId: 'a' }))
  counts.fold(ev(2, 'tool/call', { name: 'read', callId: 'b' }))
  counts.fold(ev(3, 'tool/call', { name: 'bash', callId: 'c' }))
  const detail = detailText(counts.snapshot('turn'))
  assert.match(detail, /本轮 #3/)
  assert.match(detail, /工具 3 次/)
  assert.match(detail, /read 2/)
  assert.match(detail, /点击/)
})

test('ledger factory is a fresh object every call', () => {
  const a = emptyLedger()
  const b = emptyLedger()
  assert.notEqual(a, b)
  a.tools = 5
  assert.equal(b.tools, 0)
})
