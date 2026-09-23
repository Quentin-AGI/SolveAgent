# FixAgent V0 Runtime

This workspace is the first runnable tracer bullet for the frozen FixAgent V0.2 specification. It is intentionally separate from the existing SolveAgent brand site.

The current slice provides:

- a TypeScript `@anthropic-ai/claude-agent-sdk` Runtime;
- one isolated Case Workspace Root used as Agent `cwd`, with a read-only native project Skill, Scratch-only writes, a per-Case home, and a private host-side Trace;
- one short-lived OS Worker process dedicated to each Case run, with an allowlisted provider environment and an exclusive Case Worker Lease;
- a revision-checked, append-only Case event store with atomic state projections, per-write idempotency keys, restart recovery, and same-Case Claude Agent SDK Session resume;
- exact completed-turn and crash-window replay for duplicate request keys, Worker fencing on every state write, a frozen non-secret provider profile fingerprint (including credential type, model tiers, capabilities, SDK and expected Claude Code identity), and one automatic same-profile recovery after a recorded `SYSTEM_ERROR`;
- a hash-verified, per-Case frozen Knowledge Snapshot with approval-mode, source-cutoff, version, configuration, and applicability checks;
- in-process MCP tools for product context, approved product-document and historical-Case search, applicable Action Card policy, and current Case State;
- `publish_case_response` as the only user-visible response path, with exact structured Knowledge and Action Card references validated again by the host process;
- a minimal Case conversation UI carrying the mandatory `NON-SCORED · DATA_NO_GO` status;
- startup checks for native Bash, Read, Edit, Write, the core Skill, and the SDK MCP server;
- a deterministic pre-Agent text Safety Gate that emits only the frozen fallback sentence and atomically creates a clearly labelled simulated `SAFETY_HANDOFF`.
- seven-day raw Trace expiry with an operational alert if deletion fails; report-freeze deletion will be added with the reporting subsystem.

The built-in snapshot is deliberately empty, so the default runtime can still publish only non-operational evidence requests. A reviewed, hash-valid snapshot must be supplied through `FIXAGENT_KNOWLEDGE_SNAPSHOT_FILE` before knowledge-backed information can be published. Action Cards additionally remain unavailable until all Case evidence prerequisites are present, including the universal safely-parked evidence reference. No network source is promoted to `EVAL_APPROVED` automatically.

It does not yet implement the approved knowledge corpus, image ingestion, vision and in-session Safety signals, Case State write tools, action-result recording, ordinary Handoff, Evidence Broker, or provider certification. It is an architecture-validation slice and must not be used for live device troubleshooting.

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

An approved snapshot file is optional. When omitted, each new Case is pinned to `EMPTY_EVAL_V0`. Existing Cases always resume from their own read-only snapshot copy and never switch silently when the configured snapshot changes.

```bash
pnpm dev
```

The application defaults to <http://127.0.0.1:4174>. SDK events are written to the Case's private Trace; the HTTP response is created only after the Agent calls `mcp__fixagent__publish_case_response` and the deterministic publication boundary accepts it.
