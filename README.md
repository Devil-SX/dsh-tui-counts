# dsh-tui-counts

A `dsh-tui` plugin that turns the transcript into numbers: **tool calls, thinking segments and billed tokens** for the current turn or the whole session, in one footer cell.

```
工具12·思考8·34.2k        ← one cell in the prompt footer
```

Hover it to see the split (`read 5 · bash 4 · edit 3`, in/out tokens, cache), click it to switch between **this turn** and **the whole session**.

It never rewrites the transcript. The tool cards and thinking blocks are still there — pair it with the TUI's own folding (`Ctrl+O`, `/thinking`, `thinkingFold`) to read a session as counts only.

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

## Configuration

Small on purpose — three switches, all optional:

| Variable | Values | Default |
|---|---|---|
| `DSH_TUI_COUNTS_SCOPE` | `turn` / `session` | saved choice, then `turn` |
| `DSH_TUI_COUNTS_ASCII` | `1` to replace `·` with ` | ` | off |

The clicked scope is persisted to `~/.dsh-tui/counts.json`. A variable always wins over the saved value.

## Design notes

- The footer seat is `ctx.tuiStatus.setField('counts', …)` — a text field inside the existing status row, capped at 32 cells, **not** an extra row and not a React view. `maxCells` bounds it so the host never truncates a count into a different number.
- Counting is read-only: the plugin appends nothing to the session log, so prompts, compaction, forks and resume are untouched.
- Every host seam (`setField`, `snapshotEvents`, `fs.watch`, event handlers) is wrapped: a missing or failing seam degrades the counter, never the TUI.
- Renders are coalesced (120 ms) and forced immediately on `tool/call` and `turn/end`, so the number tracks work in flight without repainting on every streamed frame.

## Development

```bash
npm test        # node:test, no host required: the folder is pure
```

`counts.mjs` is the whole model (fold an event, format a line). `index.mjs` only wires it to the Cordis bus, the footer field and `~/.dsh-tui/resume.txt` (which the TUI rewrites on every foreground switch — the reliable signal for "which session is on screen", since `tui/session-switched` is a DecisionEvent a plain `ctx.on` never sees).

## License

MIT
