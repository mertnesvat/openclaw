# OpenClaw Internals — A Hands-On Tutorial

Learn how OpenClaw works by studying 11 self-contained TypeScript examples.
Each isolates one architectural pattern from the real codebase, building
progressively toward the full message pipeline.

## How to Run

Each tutorial is a standalone file with zero external dependencies:

```bash
bun run tutorial/01-soul-context-loader/main.ts
```

Or with Node.js + tsx:
```bash
npx tsx tutorial/01-soul-context-loader/main.ts
```

## Learning Path

| # | Tutorial | What You'll Learn | Real Source |
|---|----------|-------------------|------------|
| 01 | Soul Context Loader | How agent personality is built from prioritized files | `src/agents/system-prompt.ts` |
| 02 | Env Substitution | How `${VAR}` references in config are resolved | `src/config/env-substitution.ts` |
| 03 | Heartbeat Scheduler | Phase-aligned timing so agents don't fire together | `src/infra/heartbeat-schedule.ts` |
| 04 | Wake Coalesce | Debouncing rapid wake requests into one run | `src/infra/heartbeat-wake.ts` |
| 05 | Internal Hooks | Event bus with hierarchical type:action matching | `src/hooks/internal-hooks.ts` |
| 06 | Plugin Manifest | Manifest-first discovery before loading code | `src/plugins/manifest.ts` |
| 07 | Plugin Registry | Runtime capability registration with collision detection | `src/plugins/registry.ts` |
| 08 | Route Resolution | Binding-priority cascade for message routing | `src/routing/resolve-route.ts` |
| 09 | Channel Abstraction | Normalizing Telegram/Discord/Slack behind one interface | `src/channels/plugins/types.plugin.ts` |
| 10 | Message Pipeline | Full lifecycle tying all patterns together | `src/gateway/server-chat.ts` |
| 11 | TUI + Gateway Streaming | Real-time streaming, mirroring, slow-consumer protection | `src/tui/tui-stream-assembler.ts` |

## Architecture Overview

```
  User sends "Hello" on Telegram
       |
       v
  [09: Channel Abstraction]  -- normalize to MsgContext
       |
       v
  [08: Route Resolution]     -- find the right agent via bindings
       |
       v
  [05: Internal Hooks]       -- fire "message:received" hooks
       |
       v
  [01: Soul Context Loader]  -- build system prompt from workspace files
       |
       v
  [Model API Call]           -- send to Claude/GPT with tools
       |
       v
  [05: Internal Hooks]       -- fire "message:sent" hooks
       |
       v
  [09: Channel Abstraction]  -- format reply for Telegram
       |
       v
  User receives response

  Meanwhile, in the background:
  [03: Heartbeat Scheduler]  -- fires every 30m (phase-staggered)
  [04: Wake Coalesce]        -- debounces rapid wake requests
  [06: Plugin Manifest]      -- discovered at startup
  [07: Plugin Registry]      -- capabilities registered at load
  [02: Env Substitution]     -- config resolved at boot

  And the response streams LIVE to all clients:
  [11: TUI Streaming]        -- 4-layer pipeline with throttling
       Model tokens
            |
       [Server Buffer]       -- accumulate raw tokens
            |
       [Delta Throttle]      -- max 1 broadcast per 150ms
            |
       [Broadcast]           -- to TUI, Web UI, channels
            |
       [StreamAssembler]     -- client merges deltas → display
```

## The `sample-workspace/` Folder

Contains example context files that mirror a real OpenClaw workspace:
- `SOUL.md` — Agent personality and tone
- `IDENTITY.md` — Agent metadata
- `USER.md` — User context
- `TOOLS.md` — Tool usage guidance
- `HEARTBEAT.md` — Periodic task definitions
