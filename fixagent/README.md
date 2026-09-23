# FixAgent V0 Runtime

This workspace is the first runnable tracer bullet for the frozen FixAgent V0.2 specification. It is intentionally separate from the existing SolveAgent brand site.

The current slice provides:

- a TypeScript `@anthropic-ai/claude-agent-sdk` Runtime;
- one isolated Case Workspace Root used as Agent `cwd`, with a read-only native project Skill, Scratch-only writes, a per-Case home, and a private host-side Trace;
- one short-lived OS Worker process dedicated to each Case run, with an allowlisted provider environment and an exclusive Case Worker Lease;
- a revision-checked, append-only Case event store with atomic state projections, per-write idempotency keys, restart recovery, and same-Case Claude Agent SDK Session resume;
- exact completed-turn and crash-window replay for duplicate request keys, Worker fencing on every state write, a frozen non-secret provider profile fingerprint (including credential type, model tiers, capabilities, SDK and expected Claude Code identity), and one automatic same-profile recovery after a recorded `SYSTEM_ERROR`;
- an in-process `publish_case_response` MCP tool as the only user-visible response path;
- a minimal Case conversation UI carrying the mandatory `NON-SCORED · DATA_NO_GO` status;
- startup checks for native Bash, Read, Edit, Write, the core Skill, and the SDK MCP server;
- a deliberately narrow publication contract that permits evidence requests only until Knowledge and Action Card reference validation exists.
- a deterministic pre-Agent text Safety Gate that emits only the frozen fallback sentence and atomically creates a clearly labelled simulated `SAFETY_HANDOFF`.
- seven-day raw Trace expiry with an operational alert if deletion fails; report-freeze deletion will be added with the reporting subsystem.

It does not yet implement Knowledge retrieval, image ingestion, Action Cards, vision and in-session Safety signals, ordinary Handoff, Evidence Broker, or provider certification. It is an architecture-validation slice and must not be used for live device troubleshooting.

## Install and verify

Use pnpm and Node.js 22 or newer.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm architecture:check
pnpm build
```

## Run

Copy `.env.example` into your secret-management workflow and supply an Anthropic-compatible provider profile. Do not commit the resulting credentials.

```bash
pnpm dev
```

The application defaults to <http://127.0.0.1:4174>. SDK events are written to the Case's private Trace; the HTTP response is created only after the Agent calls `mcp__fixagent__publish_case_response` and the deterministic publication boundary accepts it.
