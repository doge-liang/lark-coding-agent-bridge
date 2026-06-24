# Bunny Codex Lark Bridge Design

## Goal

Create Bunny as a Codex-backed Lark operator surface. Bunny is not a separate local server, slash-command control plane, or alternate agent binary. The bridge starts from Lark menu/cards, then routes explicit Bunny actions into a dedicated Codex session scope.

## Entry Points

- `/bunny` opens the Bunny home card.
- The floating menu label `Bunny` maps to `/bunny`.
- Bunny home card buttons use built-in command payloads such as `cmd: "bunny.research"`.
- Static Bunny cards do not forge `__bridge_cb` or `bridge_token`; signed agent callbacks remain reserved for cards produced during a live agent run.

## Session Model

- A normal chat scope such as `oc_xxx` maps to Bunny scope `oc_xxx:bunny`.
- A topic scope such as `oc_xxx:omt_xxx` maps to `oc_xxx:omt_xxx:bunny`.
- Bunny inherits the current workspace cwd when the Bunny scope has no cwd yet.
- Bunny scope has its own Codex thread/session history, separate from the normal Cody/Codex chat session.

## Prompt Model

When a run is launched for a Bunny scope, the bridge injects an `<agent_profile>` section containing:

- `id: "bunny"`
- `baseAgent: "codex"`
- the Bunny system prompt
- the Bunny manifest, skills, hooks, and callback contract

Normal bridge sessions do not receive this section.

## Action Contract

Explicit Bunny actions are queued to the Bunny scope as:

```text
[bunny-skill] {"domain":"bunny","action":"research","skill":"research_topics","source":"lark-card","confirmed":false}
```

State-changing actions remain explicit skill events. Actions that require confirmation still arrive with `confirmed:false`; Bunny/Codex must ask for confirmation before scheduling, live publishing, or resume-like actions.

## Non-goals

- No `/bunny` local CLI group.
- No Bunny HTTP server.
- No unsigned agent callback token generation.
- No automatic scheduler or publishing worker in this bridge entry-point change.
