# dsh-tui-counts

A `dsh-tui` plugin that turns the transcript into numbers: **tool calls, thinking segments and billed tokens** for the current turn or the whole session, in one footer cell.

```
工具12·思考8·34.2k        ← one cell in the prompt footer
```

Hover it to see the split (`read 5 · bash 4 · edit 3`, in/out tokens, cache), click it to switch between **this turn** and **the whole session**.

It counts from the append-only session log, so it keeps working whether the transcript shows every card or none at all. If you want the cards gone too, there is an **opt-in row filter** (below): the transcript then shows only your prompts, the answers, and this one line of numbers.

## Install

```bash
dsh plugin --profile dsh-tui add github:Devil-SX/dsh-tui-counts   # from GitHub
dsh plugin --profile dsh-tui add file:$PWD                        # from a checkout
```

The package declares `dsh.bundle.patch`, so the profile picks the plugin up on the next boot — no hand-edited `cordis.patch.yml`:

```yaml
- insert:
    - id: tui-counts
      name: 'dsh-tui-counts'
```

Then start the TUI in any workspace:

```bash
dst
```

## What is counted

| Field | Source event | Meaning |
|---|---|---|
| 工具 N | `tool/call` | Tool calls the model issued. A call counts once when dispatched, including calls that later fail or are interrupted. |
| 思考 N | `assistant/message` | Reasoning **segments**, one per `reasoning` content block. A redacted block still counts. Segments are not estimated from tokens. |
| N k | `assistant/message` | `inputTokens + outputTokens` (billed). Cache reads/writes are shown separately in the hover detail. `reasoningTokens` is a subset of output and is never added twice. |

Scope:

- **本轮 (turn)** — resets at every `turn/start`, keeps the last finished turn's numbers until the next turn opens. Default.
- **会话 (session)** — accumulates for the life of the session, folded from the append-only log, so it survives compaction (compaction changes the model's context, not the log).

A resumed session is seeded from `session.snapshotEvents(0)` on first sight; the stored prefix of a restored session is never replayed on the event bus, so seeding is the only way its history gets counted. Re-seeding is idempotent — every event carries a monotonic `seq` and the folder ignores anything it has already seen.

Subagent sessions (`header.origin === 'subagent'`) are ignored: they would otherwise steal the single footer seat.

## Hiding the tool cards and thinking blocks

dsh-TUI's plugin API has no transcript-row seam — a plugin can add footer fields, panels and scenes, but it cannot drop a row. The rows *are* filtered before virtualization for two built-ins (`thinkingVisible` behind `/thinking`, and `turnUsageRow`); a filtered row leaves no cached height, no mounted node and no stale click target, which is why removing one has to happen there and not by rendering null.

This package therefore ships an **optional, reversible patch** for the installed host file `lib/types/components/MessageList.js`, which inserts two filters right next to that built-in pair:

```js
if (__countsMode.hideTools   === true && !expanded) out = out.filter(r => r.kind !== 'tool');
if (__countsMode.hideThinking === true && !expanded) out = out.filter(r => r.kind !== 'reasoning');
```

`expanded` is the `Ctrl+O` switch, so **Ctrl+O always brings the rows back** — and because it already participates in the visible-rows cache key, the repaint is correct with no extra plumbing.

Turn it on in `~/.dsh-tui/counts.json` and restart:

```json
{ "version": 1, "hideTools": true, "hideThinking": true }
```

or per launch:

```bash
DSH_TUI_COUNTS_HIDE=all dst     # tools,thinking, all, none
```

The patch is applied by `postinstall`, and again by the plugin on boot if the package manager skipped install scripts (pnpm 10 blocks them by default). A boot-time patch takes effect on the **next** launch, because the host module is already imported — so after a fresh install, the first `dst` writes the patch and the second one (or `/restart`) hides the rows. To make the first launch count, allow the install script once:

```bash
pnpm --dir ~/.dsh/profiles/dsh-tui approve-builds   # tick dsh-tui-counts
dsh plugin --profile dsh-tui add github:Devil-SX/dsh-tui-counts
```

What you give up: the patch edits a file inside the host package, so a dsh-TUI upgrade (`dst update`) replaces it and the filter is re-applied on the next install/boot. Nothing else changes, and the anchor check makes an unrecognized future build a silent no-op (the TUI keeps working, rows stay visible). Revert with:

```bash
node scripts/patch-message-list.mjs --revert   # or: npm run patch:revert
```

The first patch keeps a byte-identical `MessageList.js.dsh-tui-counts.orig` next to the file, which is what `--revert` restores.

## Configuration

Small on purpose — three switches, all optional:

| Variable | Values | Default |
|---|---|---|
| `DSH_TUI_COUNTS_SCOPE` | `turn` / `session` | saved choice, then `turn` |
| `DSH_TUI_COUNTS_HIDE` | `tools`, `thinking`, `all`, `none` | saved flags, then all off |
| `DSH_TUI_COUNTS_ASCII` | `1` to replace `·` with ` | ` | off |
| `DSH_TUI_COUNTS_NO_PATCH` | `1` to never touch the host | off |

The clicked scope is persisted to `~/.dsh-tui/counts.json`. A variable always wins over the saved value.

## Design notes

- The footer seat is `ctx.tuiStatus.setField('counts', …)` — a text field inside the existing status row, capped at 32 cells, **not** an extra row and not a React view. `maxCells` bounds it so the host never truncates a count into a different number.
- Counting is read-only: the plugin appends nothing to the session log, so prompts, compaction, forks and resume are untouched.
- Every host seam (`setField`, `snapshotEvents`, `fs.watch`, event handlers) is wrapped: a missing or failing seam degrades the counter, never the TUI.
- Renders are coalesced (120 ms) and forced immediately on `tool/call` and `turn/end`, so the number tracks work in flight without repainting on every streamed frame.

## Development

```bash
npm test                          # 23 cases: folding, formatting, the patch script
node scripts/patch-message-list.mjs            # apply the row filter by hand
node scripts/patch-message-list.mjs --revert   # restore the host file
```

`counts.mjs` is the whole model (fold an event, format a line). `index.mjs` only wires it to the Cordis bus, the footer field and `~/.dsh-tui/resume.txt` (which the TUI rewrites on every foreground switch — the reliable signal for "which session is on screen", since `tui/session-switched` is a DecisionEvent a plain `ctx.on` never sees).

## License

MIT
