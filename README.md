# token-meter

A per-session, per-model **token-usage counter** for pi ([ADR-0073](https://github.com/psmfd/pi-config/blob/main/adrs/0073-token-meter-extension.md)).
When enabled, it records the token usage of every assistant turn and lets you see
the total tokens (and cost) a session consumed, broken down by model — including
work done by subagents.

## Install

```sh
pi install git:github.com/psmfd/pi-token-meter
```

Try it first without installing: `pi -e git:github.com/psmfd/pi-token-meter`.

## What it does

When enabled, the `message_end` handler appends one JSONL record per **assistant**
turn to a per-session log at
`~/.pi/agent/extensions/token-meter/sessions/<session-id>.jsonl` (the `<session-id>`
is pi's own session id, so it lines up with the session transcript):

```jsonc
{ "ts":"2026-07-04T14:32:01Z","turn":5,"model":"claude-sonnet-5","provider":"anthropic",
  "input":812,"cacheRead":4200,"cacheWrite":0,"output":340,"totalTokens":5352,"costTotal":0.0193 }
```

`input` is **fresh** (uncached) input; `cacheRead`/`cacheWrite` are prompt-cache
tokens (priced far below fresh). The breakdown is always kept — a single "total"
would hide the cost-relevant split.

**Whole-tree accounting.** pi runs subagents as separate processes. When enabled,
the root session exports its session id into the environment, so every subagent
process records to the **same** session file — the session total includes subagent
usage (this repo's primary orchestration mechanism), not just top-level turns.

**Observational only.** The `message_end` handler returns `undefined` and never a
replacement message — rewriting the message would churn the provider's cached
prefix. It makes no network calls and logs only numeric usage + model/provider
strings, never message content.

## Retrieving usage

**In-session** — the `token_usage` tool (terse by default, `verbose:true` for the
per-model table):

```text
Session tokens: 61,660 (claude-sonnet-5) + 5,800 (claude-haiku-4) = 67,460 total · $0.33
```

**CLI** — `scripts/token-meter.sh` reads the same logs:

```sh
scripts/token-meter.sh                 # current session (most recent by mtime)
scripts/token-meter.sh --session <id>  # one named session
scripts/token-meter.sh --all-time      # aggregate across every session
scripts/token-meter.sh --list          # list sessions (id, started, turns)
```

```text
INFO  current session=b3f0a1
INFO  claude-sonnet-5: turns=9 input=7340 cacheRead=51200 output=3120 total=61660 cost=$0.31
INFO  claude-haiku-4: turns=3 input=1200 cacheRead=4000 output=600 total=5800 cost=$0.02
==================================
TOTAL — 12 turns, 67460 tokens, $0.33
```

## Enabling / disabling

**Inert by default** — zero overhead and nothing recorded unless you opt in.

- **Persistent (per user):** set `extensionSettings.tokenMeter.enabled: true` in
  `~/.pi/agent/settings.json`. Only the user-layer setting is honored — a project's
  `.pi/settings.json` cannot flip metering.
- **Per session:** launch with `--token-meter`, or toggle mid-session with
  `/token-meter on|off` (`/token-meter status` reports the running total).

When on, the status bar shows `📊 token-meter: on`.

## Files

| File | Role |
|---|---|
| `index.ts` | handlers (`session_start`, `message_end`), the `/token-meter` command + `--token-meter` flag, the `token_usage` tool, and the subagent env propagation |
| `record.ts` | pure record building + per-model aggregation + output formatting |
| `state.ts` | per-session append-only log + corruption-tolerant reader + session-id sanitization |
| `types.ts` | usage/record/totals shapes |

## Tests

```sh
./scripts/test-token-meter.sh       # extension unit tests
./scripts/token-meter.sh --self-test  # CLI aggregation self-test
```

Both are gated under `scripts/validate.sh`.
