# Bunny Twitter Agent Design

Date: 2026-06-23

2026-06-24 update: the Lark entry-point details are superseded by
`2026-06-24-bunny-codex-lark-bridge-design.md`. `/bunny` now exists only as a
thin Lark command/menu entry that opens Bunny and queues explicit skill events
into a Codex-backed Bunny scope; the old local control server and user-facing
CLI command group remain out of scope.

## Summary

Bunny is an AI tools media agent for X/Twitter. It runs as a first-class agent
with its own system prompt, explicit business skills, hooks, and Feishu/Lark
menu/card surfaces. `lark-channel-bridge` only provides message transport,
card delivery, callback routing, local execution, and repo-managed runtime
state.

The first version focuses on fully automated content operations: discover AI
tool and workflow topics, generate bilingual research notes and English-first
posts, schedule and publish through the X API, collect performance data, and
send daily Feishu/Lark reports. It does not automate direct messages, bulk
comments, bulk follows, or other high-risk interaction loops.

## Decisions

- Product shape: Bunny is an Andy-like first-class agent, not a bridge slash
  command and not a user-facing CLI command group.
- Control model: low-risk analysis can be conversational; business actions are
  triggered by explicit Bunny skills, menu items, cards, or signed card
  callbacks.
- Topic positioning: AI tools, with AI workflow tutorials as the primary
  content line and tool reviews plus monetization ideas as secondary lines.
- Language strategy: bilingual research and internal notes, English-first X
  publishing.
- Automation boundary: fully automated publishing for the owner's own account;
  no automated spam-like engagement in V1.
- Publishing API: X API v2 `POST /2/tweets`, using a user-authorized developer
  app and budget-aware rate handling.
- First rollout mode: dry-run for three days, then explicit approval before one
  post per day for the first seven live days. Normal V1 cadence requires a
  manual menu/card approval.

## Non-Goals

- No Web3 or trading narrative coverage in V1.
- No generic social media platform abstraction in V1.
- No direct integration of Twitter-specific business logic into bridge core.
- No `/bunny` slash command in Feishu/Lark.
- No user-facing `lark-channel-bridge bunny ...` CLI command group.
- No automated private messages, mass replies, mass follows, or engagement
  farming.
- No promise of follower, revenue, or virality outcomes.
- No storage of API secrets in the repository.

## Architecture

```text
Feishu/Lark user
  |
  | Bunny chat, menu actions, cards, signed callbacks
  v
lark-channel-bridge agent transport
  |
  | route message or callback into Bunny runtime
  v
Bunny Agent Runtime
  |-- System Prompt
  |-- Business Skill Commands
  |-- Hook Dispatcher
  |-- Feishu/Lark Cards
  |-- Bunny Engine
  |-- Source Ingestion
  |-- Topic Scoring
  |-- Content Generation
  |-- Quality and Safety Checks
  |-- Scheduler
  |-- X API Adapter
  |-- Metrics Collector
  |-- Daily Reporter
  v
Bunny Database
```

The bridge integration is intentionally thin. It does not own source
collection, topic scoring, content generation, publishing, or analytics. It
routes natural-language messages, menu actions, and signed card callbacks to
Bunny, then sends Bunny responses and cards back to Feishu/Lark.

## Components

### Bunny Engine

The engine owns the daily operating loop. It can run as a long-lived service or
as scheduled jobs launched by cron/systemd timers. Its modules are designed so
each can be tested without calling real X or Lark APIs.

### Bunny Agent Runtime

The agent runtime owns Bunny's identity and operator experience:

- a Bunny-specific system prompt
- a registry of explicit business skills
- a dispatcher for menu/card callback payloads
- hook execution for scheduled and state-transition events
- repo-managed prompt, skill, and hook artifacts

The runtime is the only layer that interprets operator intent. It may answer
natural-language questions, but state-changing business operations must enter
through explicit skill commands or signed card callbacks.

### System Prompt

Bunny's system prompt frames it as an AI tools media operator. It should keep
the agent focused on:

- AI tools and AI workflow tutorials
- English-first X/Twitter publishing
- Chinese research notes for the owner
- cautious claims, source attribution, and conservative cadence
- explicit approval before live publishing

The prompt must forbid engagement farming, unsupported income promises, and
publishing actions triggered only by vague natural language.

### Business Skills

Key business skills are explicit command-like operations owned by Bunny, not
bridge slash commands:

- `research_topics`: collect and score AI tool/workflow candidates.
- `generate_drafts`: produce Chinese notes and English posts from approved
  topics.
- `quality_check`: run duplicate, claim, source, length, and cadence checks.
- `review_queue`: show drafts awaiting approval.
- `schedule_posts`: schedule approved drafts.
- `pause_publishing`: pause future publishing.
- `resume_publishing`: resume future publishing.
- `daily_report`: summarize published posts, drafts, skipped candidates,
  metrics, and warnings.

These skills can be triggered by Feishu/Lark menu items, Bunny cards, or
unambiguous typed skill names inside Bunny's chat. The implementation must not
register `/bunny` commands in the bridge command handler.

### Hooks

Bunny hooks run around predictable business events:

- `scheduled_ingestion`: collect fresh candidates.
- `after_ingestion`: score and store new candidates.
- `before_draft_generation`: choose topics under the daily budget.
- `after_draft_generation`: run quality checks and update the review queue.
- `before_publish`: enforce pause state, live-mode gates, cadence, and
  approval status.
- `after_publish`: record X IDs/URLs and metrics collection intent.
- `daily_report`: send the daily Feishu/Lark summary.

Hooks must be repo-managed artifacts and must be testable without live X or
Lark API calls.

### Source Ingestion

Source ingestion collects candidate AI tool and workflow signals from:

- RSS feeds and official product blogs.
- Product launch and directory pages where access is stable and allowed.
- GitHub repositories and release feeds.
- Hacker News and similar public technical discussion sources.
- URLs manually submitted by the user through Feishu/Lark.

V1 prefers RSS, documented APIs, and public pages with stable terms over brittle
scraping.

### Topic Scoring

Topic scoring ranks candidates by:

- freshness
- practical usefulness
- whether the topic can become a workflow tutorial
- credibility of the source
- fit for English X distribution
- novelty compared with recent Bunny posts

The score is persisted so future performance data can adjust the ranking model.

### Content Generation

For each selected topic, Bunny creates:

- a short Chinese research note for the user
- an English single-post draft
- an English thread draft when the topic supports depth
- source links
- a concise rationale for why the topic was selected

Generated content must avoid unverifiable claims, fake scarcity, fake earnings
claims, and unsupported superlatives.

### Quality And Safety Checks

Quality checks run before scheduling:

- duplicate hash over title, body, links, and topic angle
- source link presence for tool reviews
- no prohibited spam phrases or fake urgency patterns
- no unsupported claims about income, performance, or endorsements
- post length validation
- cadence validation against the daily schedule

Failed candidates stay in the database with the failure reason instead of being
silently dropped.

### Scheduler

The scheduler decides when approved generated posts are published. V1 default
cadence is:

- one to two English posts per day
- one thread every two to three days
- no more than one post in a short burst window

The first live week overrides this to one post per day.

### X API Adapter

The X API adapter is the only component that calls X. It handles:

- OAuth/user-token based authentication
- `POST /2/tweets` publishing
- idempotency through Bunny's `post_key`
- rate limit and credit-budget tracking
- retryable versus terminal API errors
- metrics retrieval when available under the configured X API access level

It must never log raw access tokens or secrets.

### Feishu/Lark Agent Surface

Bunny exposes an agent surface instead of slash commands or CLI commands:

- a Bunny home card with status, queue, budget, and next actions
- a floating/menu entry that opens the Bunny home card when the platform
  supports it
- signed callback buttons for explicit business skills
- natural-language replies for low-risk advisory questions
- daily report cards

State-changing actions such as scheduling, pausing, resuming, and live
publishing must be triggered through explicit skill callbacks or typed skill
names. Live publishing requires a confirmation step.

### Daily Reporter

The reporter sends a daily Feishu/Lark summary:

- what was published
- source links
- basic performance signals
- failed or skipped candidates
- tomorrow's likely topics
- budget/rate warnings

## Data Model

Bunny persists data in SQLite for V1.

Core tables:

- `sources`: configured feeds, API endpoints, and manual source labels.
- `candidates`: raw discovered items with source metadata.
- `topics`: normalized topics derived from candidates.
- `drafts`: generated Chinese notes, English posts, and thread drafts.
- `scheduled_posts`: queue entries with publish time, status, and `post_key`.
- `published_posts`: X post IDs, URLs, timestamps, and linked draft IDs.
- `metrics`: periodic performance snapshots.
- `events`: audit log for skill calls, hook runs, scheduler decisions, publish attempts,
  failures, pauses, and resumes.
- `settings`: cadence, budgets, pause state, and rollout mode.

All records that can trigger external actions have explicit status transitions
so jobs can resume safely after process restarts.

## Data Flow

1. Ingestion collects raw candidate items.
2. Normalization groups related items into topics.
3. Scoring ranks topics for usefulness, novelty, and audience fit.
4. Content generation creates bilingual notes and English publishing drafts.
5. Quality checks accept, reject, or quarantine drafts with reasons.
6. Scheduling assigns publish times under cadence and rollout constraints.
7. Publishing sends posts through the X API adapter.
8. Metrics collection records performance snapshots.
9. Reporting summarizes activity and updates the operator through Feishu/Lark.

## Error Handling

- X publish failure: mark the attempt, preserve the draft, and retry only when
  the error is retryable.
- Network timeout after publish request: use `post_key` and local publish state
  to avoid duplicate posts before retrying.
- Rate limit or credit threshold reached: pause publishing automatically and
  notify Feishu/Lark.
- Content quality failure: keep the draft with a failure reason; do not publish.
- Scheduler crash: resume from persisted statuses; do not infer publication from
  memory.
- Agent callback failure: report the failed Bunny skill or hook and leave
  existing publishing state unchanged.
- Missing X credentials: run ingestion, generation, and reports in dry-run mode
  only.

## Safety Boundaries

- Bunny posts only to the owner's configured account.
- V1 does not automate DMs, bulk comments, bulk follows, or engagement farming.
- Every tool review post keeps source attribution.
- Claims about money, growth, model capability, or product performance require a
  source or must be rewritten as opinion.
- The operator can pause publishing from Feishu/Lark at any time.
- State-changing actions use explicit skill commands, menu items, or signed card
  callbacks; vague natural language cannot publish, schedule, pause, or resume.
- Default cadence is intentionally conservative.

## Testing

Unit tests cover:

- source parsing
- topic scoring
- duplicate detection
- content quality checks
- scheduler cadence rules
- status transitions
- X API adapter error classification

Integration tests cover:

- publish success with a mocked X API
- publish retry without duplicate posting
- rate/credit pause behavior
- Bunny agent callbacks, menu actions, and explicit skill dispatch
- daily report generation

End-to-end validation:

1. Run three days in dry-run mode with no X posting.
2. Review generated topics and English posts through Feishu/Lark reports.
3. Enable live posting at one post per day for seven days.
4. Increase to V1 cadence only if no quality, budget, or platform issues appear.

## Rollout Plan

1. Create the independent Bunny service skeleton.
2. Add SQLite persistence and status transitions.
3. Implement dry-run ingestion, scoring, generation, and reporting.
4. Add Bunny agent surface cards, menu/callback handling, and explicit skill
   dispatch.
5. Add X API adapter behind a disabled-by-default live publishing flag.
6. Run three-day dry-run.
7. Enable first-week low-frequency live posting.
8. Move to normal V1 cadence after review.

## External Dependencies

- X developer app with the required access level for post creation.
- User authorization token for the target X account.
- An LLM provider for content generation.
- Stable source feeds or APIs for AI tool discovery.
- Existing lark-channel-bridge runtime for Feishu/Lark messages, cards,
  callback routing, and reports.

## References

- X API create post documentation:
  <https://docs.x.com/x-api/posts/create-post>
- X API pricing and credit model:
  <https://docs.x.com/x-api/getting-started/pricing>
- X authenticity and platform manipulation policy:
  <https://help.x.com/en/rules-and-policies/authenticity>

## Open Configuration Values

These are configuration values, not unresolved design questions:

- X API credentials and access level.
- LLM provider and model.
- Initial source feed list.
- Daily credit/budget threshold.
- Exact Feishu/Lark menu mechanism available for Bunny home entry. If a
  persistent floating menu is not available in the current app setup, use a
  pinned/home card plus signed callback buttons.

The implementation plan should pick conservative defaults and keep secrets out
of committed files.
