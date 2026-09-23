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
- a Codex-style model picker backed by a server-side provider registry, with the selected non-secret profile frozen into each Case;
- startup checks for native Bash, Read, Edit, Write, the core Skill, and the SDK MCP server;
- a deterministic pre-Agent text Safety Gate that emits only the frozen fallback sentence and atomically creates a clearly labelled simulated `SAFETY_HANDOFF`.
- seven-day raw Trace expiry with an operational alert if deletion fails; report-freeze deletion will be added with the reporting subsystem.

The built-in snapshot is deliberately empty, so the default runtime can still publish only non-operational evidence requests. A reviewed, hash-valid snapshot must be supplied through `FIXAGENT_KNOWLEDGE_SNAPSHOT_FILE` before knowledge-backed information can be published. Its sources carry separate publication and retrieval timestamps, and every entry records the approving person, time, and authority. Evaluation snapshots also carry a hash-locked Case catalog: the request selects an `evaluation_case_id`, while the server derives the Case cutoff from that entry's Issue creation time. Historical Case knowledge is stored as attributable, timestamped content items, allowing the materializer to remove the target Issue, its comments and solution, transitively linked duplicates, generated FAQs, and all content published after the cutoff. Approved Knowledge conflicts name both sources, their blocked actions, and any evidence-based resolution; unresolved conflicts require both citations and remain recorded in Case State, while blocked actions stay unavailable. Action Cards additionally remain unavailable until all Case evidence prerequisites are present, including the universal safely-parked evidence reference; Level 2 cards require an exact product/version `ACTION_SOP`, and applicable prohibitions veto matching cards. No network source is promoted to `EVAL_APPROVED` automatically.

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

An approved snapshot file is optional. When omitted, each new Case is pinned by both ID and content hash to `EMPTY_EVAL_V0`. Existing Cases always resume from their own read-only snapshot copy and never switch silently when the configured snapshot changes. A non-empty Evaluation snapshot requires `evaluation_case_id` in the Case creation request. The server resolves that identifier against the approved catalog, derives the exact Issue-creation cutoff, excludes target-related and later content, and freezes the resulting Case-specific snapshot.

```bash
pnpm dev
```

The application defaults to <http://127.0.0.1:4174>. SDK events are written to the Case's private Trace; the HTTP response is created only after the Agent calls `mcp__fixagent__publish_case_response` and the deterministic publication boundary accepts it.

## Model registry

Use the model-settings button in the lower-left corner to configure Qwen, Kimi, Zhipu GLM, or DeepSeek with only an HTTPS API address and API Key. FixAgent applies the provider's managed runtime model automatically. The API Key is required on every save. The local UI supports creating, updating, removing, and selecting profiles for new Cases without a server restart. It writes active and frozen historical profiles to the private registry at `.runtime/provider-profiles.json` with mode `0600`; historical profiles reuse the latest saved Key, while removing a provider revokes its stored profiles. `FIXAGENT_PROVIDER_PROFILES_FILE` can override that location.

The browser receives only sanitized display metadata from `/api/models`. Credentials are never returned and are copied only into the selected Case Worker. A model can be changed before a Case is created and remains locked for that Case afterward.

```json
{
  "default_profile_id": "qwen",
  "profiles": [
    {
      "id": "qwen",
      "display_name": "通义千问",
      "provider_label": "阿里云百炼",
      "environment": {
        "FIXAGENT_PROVIDER_ID": "qwen",
        "ANTHROPIC_BASE_URL": "https://your-anthropic-compatible-endpoint.example",
        "ANTHROPIC_AUTH_TOKEN": "replace-with-secret",
        "FIXAGENT_MODEL": "replace-with-model-id",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "replace-with-model-id",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "replace-with-model-id",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "replace-with-model-id",
        "ANTHROPIC_DEFAULT_FABLE_MODEL": "replace-with-model-id",
        "FIXAGENT_PROVIDER_CAPABILITIES": "tools,vision",
        "FIXAGENT_EXPECTED_CLAUDE_CODE_VERSION": "replace-with-certified-version"
      }
    }
  ]
}
```

The JSON shape remains available for secret-management or deployment automation. Use the same object shape for `kimi`, `zhipu`, and `deepseek`, with endpoints and model IDs certified for the corresponding account. Profiles omitted from the private registry remain visible as `待配置` and cannot be selected. Do not commit the registry file.
