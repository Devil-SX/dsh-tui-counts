import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { patchFile, revertFile } from '../scripts/patch-message-list.mjs'

const ANCHOR = `        if (!turnUsageRow)
            out = out.filter(row => row.kind !== 'turn-summary');
`

/** A stand-in for the host file: the anchor plus unrelated surroundings. */
function hostSource(extra = '') {
  return `// host component
export function MessageList() {
    let out = []
${ANCHOR}    // consecutive-job groups
    return out
${extra}}
`
}

test('patching inserts both filters once, next to the built-in pair', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-counts-patch-'))
  const file = join(dir, 'MessageList.js')
  writeFileSync(file, hostSource())

  assert.equal(patchFile(file), 'patched')
  const patched = readFileSync(file, 'utf8')
  assert.match(patched, /dsh-tui-counts:row-filter/)
  assert.match(patched, /__countsMode\.hideTools === true && !expanded/)
  assert.match(patched, /row\.kind !== 'tool'/)
  assert.match(patched, /__countsMode\.hideThinking === true && !expanded/)
  assert.match(patched, /row\.kind !== 'reasoning'/)
  // The anchor it replaced must still be there: `turnUsageRow` is untouched.
  assert.ok(patched.includes(ANCHOR))
  // Nothing outside the anchor block changed.
  assert.ok(patched.startsWith('// host component\n'))

  // Idempotent.
  assert.equal(patchFile(file), 'already')
  assert.equal(readFileSync(file, 'utf8'), patched)

  rmSync(dir, { recursive: true, force: true })
})

test('a host build without the anchor is left untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-counts-patch-'))
  const file = join(dir, 'MessageList.js')
  const original = 'export function MessageList() { return [] }\n'
  writeFileSync(file, original)

  assert.equal(patchFile(file), 'anchor-missing')
  assert.equal(readFileSync(file, 'utf8'), original)
  assert.equal(revertFile(file), 'no-backup')

  rmSync(dir, { recursive: true, force: true })
})

test('revert restores the byte-identical original and drops the backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-counts-patch-'))
  const file = join(dir, 'MessageList.js')
  const original = hostSource('    // tail comment\n')
  writeFileSync(file, original)

  patchFile(file)
  assert.notEqual(readFileSync(file, 'utf8'), original)
  assert.equal(revertFile(file), 'reverted')
  assert.equal(readFileSync(file, 'utf8'), original)
  // A second revert has nothing left to do.
  assert.equal(revertFile(file), 'no-backup')

  rmSync(dir, { recursive: true, force: true })
})

test('patching twice never duplicates the filters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-counts-patch-'))
  const file = join(dir, 'MessageList.js')
  writeFileSync(file, hostSource())
  patchFile(file)
  const once = readFileSync(file, 'utf8')
  // A re-patch must hit the sentinel, not insert a second copy.
  assert.equal(patchFile(file), 'already')
  assert.equal(readFileSync(file, 'utf8'), once)
  assert.equal(once.split("row.kind !== 'tool'").length - 1, 1)
  rmSync(dir, { recursive: true, force: true })
})
