import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// The plugin reads its state root once, at import time.
const HOME = mkdtempSync(join(tmpdir(), 'dsh-tui-counts-'))
process.env.DSH_TUI_COUNTS_HOME = HOME
// The row-filter patch edits the installed dsh-TUI; tests must never do that.
process.env.DSH_TUI_COUNTS_NO_PATCH = '1'

const { apply, name, inject } = await import('../index.mjs')

const ev = (seq, type, data = {}, time = 1_700_000_000_000 + seq) => ({ seq, type, time, data })

/** A minimal Cordis-shaped context plus the footer-field seam. */
function fakeCtx() {
  const handlers = new Map()
  const writes = []
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    tuiStatus: {
      setField(key, text, options) {
        writes.push({ key, text, options })
        return () => {}
      },
    },
  }
  return {
    ctx,
    writes,
    emit(event, ...args) {
      const handler = handlers.get(event)
      assert.ok(handler !== undefined, `no handler for ${event}`)
      return handler(...args)
    },
    lastWrite() {
      return writes[writes.length - 1]
    },
  }
}

/** A session whose stored prefix is already on disk (a resumed session). */
function fakeSession(id, events, header = { origin: 'user' }) {
  return {
    id,
    header,
    snapshotEvents: (from = 0) => events.slice(from),
  }
}

const storedTurn = [
  ev(0, 'turn/start', { turn: 1 }),
  ev(1, 'tool/call', { callId: 'a', name: 'bash', arguments: {} }),
  ev(2, 'assistant/message', {
    message: { content: [{ type: 'reasoning', text: 'plan it' }, { type: 'text', text: 'done' }] },
    usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 400 },
  }),
  ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
]

test('the module declares the footer seam it needs', () => {
  assert.equal(name, 'tui-counts')
  assert.deepEqual(inject, ['tuiStatus'])
})

test('a resumed session is seeded from its stored log and rendered immediately', () => {
  const harness = fakeCtx()
  apply(harness.ctx)

  harness.emit('session/created', fakeSession('s1', storedTurn))
  const write = harness.lastWrite()

  assert.equal(write.key, 'counts')
  assert.equal(write.text, '工具1·思考1·1.0k')
  assert.match(write.options.detail, /本轮 #1/)
  assert.match(write.options.detail, /bash 1/)
  assert.equal(write.options.maxCells, 32)
  assert.equal(typeof write.options.onClick, 'function')
  // A click without a detail line would be refused by the host.
  assert.ok(write.options.detail.length > 0)

  harness.emit('dispose')
})

test('live events advance the counter without double counting the seed', () => {
  const harness = fakeCtx()
  apply(harness.ctx)
  const session = fakeSession('s2', storedTurn)
  harness.emit('session/created', session)

  // The bus re-delivers a stored event (host catch-up): must be ignored.
  harness.emit('session/event', session, storedTurn[1])
  assert.equal(harness.lastWrite().text, '工具1·思考1·1.0k')

  // A second turn opens: the turn scope resets, the session scope keeps going.
  harness.emit('session/event', session, ev(4, 'turn/start', { turn: 2 }))
  harness.emit('session/event', session, ev(5, 'tool/call', { callId: 'b', name: 'read', arguments: {} }))
  assert.equal(harness.lastWrite().text, '工具1')

  harness.emit('session/event', session, ev(6, 'assistant/message', {
    message: { content: [{ type: 'text', text: 'ok' }] },
    usage: { inputTokens: 20, outputTokens: 5 },
  }))
  harness.emit('session/event', session, ev(7, 'turn/end', { turn: 2, reason: { kind: 'completed' } }))
  assert.equal(harness.lastWrite().text, '工具1·25')

  // Click switches the scope and persists it.
  harness.lastWrite().options.onClick()
  assert.equal(harness.lastWrite().text, '工具2·思考1·1.0k')
  const saved = JSON.parse(readFileSync(join(HOME, 'counts.json'), 'utf8'))
  assert.equal(saved.scope, 'session')

  harness.emit('dispose')
})

test('subagent sessions never take the footer seat', () => {
  const harness = fakeCtx()
  apply(harness.ctx)
  harness.emit('session/created', fakeSession('main', storedTurn))
  const before = harness.lastWrite().text

  harness.emit('session/created', fakeSession('child', [ev(0, 'turn/start', { turn: 1 }), ev(1, 'tool/call', { name: 'bash', callId: 'x' })], { origin: 'subagent' }))
  assert.equal(harness.lastWrite().text, before)

  harness.emit('dispose')
})

test('an idle session with nothing counted clears the field instead of showing zeroes', () => {
  const harness = fakeCtx()
  apply(harness.ctx)
  harness.emit('session/created', fakeSession('s3', []))
  assert.equal(harness.lastWrite().text, '')
  harness.emit('dispose')
})

test('the foreground switch follows the resume marker', () => {
  const harness = fakeCtx()
  apply(harness.ctx)
  const first = fakeSession('s4', storedTurn)
  const second = fakeSession('s5', [ev(0, 'turn/start', { turn: 1 }), ev(1, 'tool/call', { name: 'edit', callId: 'z' }), ev(2, 'tool/call', { name: 'edit', callId: 'y' })])
  harness.emit('session/created', first)
  harness.emit('session/created', second)
  assert.equal(harness.lastWrite().text, '工具2')

  // Switching back to the parked session is only signalled by the marker file.
  writeFileSync(join(HOME, 'resume.txt'), 's4')
  // The watcher is async by nature; the assertion drives the same code path the
  // watcher calls by emitting a no-op session event with the marker in place.
  harness.emit('session/event', first, ev(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(harness.lastWrite().text, '工具1·思考1·1.0k')

  harness.emit('dispose')
})

test('a disposed plugin stops writing', () => {
  const harness = fakeCtx()
  apply(harness.ctx)
  harness.emit('session/created', fakeSession('s6', storedTurn))
  const count = harness.writes.length
  harness.emit('dispose')
  harness.emit('session/event', fakeSession('s6', storedTurn), ev(9, 'tool/call', { name: 'bash', callId: 'q' }))
  assert.equal(harness.writes.length, count)
})

test.after(() => rmSync(HOME, { recursive: true, force: true }))
