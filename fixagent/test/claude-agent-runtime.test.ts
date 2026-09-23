import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { createClaudeAgentRuntime } from "../src/claude-agent-runtime.js";

const validInitMessage = {
  type: "system",
  subtype: "init",
  apiKeySource: "none",
  claude_code_version: "test",
  cwd: "/isolated/cases/case-123",
  tools: [
    "Bash",
    "Read",
    "Edit",
    "Write",
    "mcp__fixagent__publish_case_response",
  ],
  mcp_servers: [{ name: "fixagent", status: "connected", source: "sdk" }],
  model: "test-model",
  permissionMode: "dontAsk",
  slash_commands: [],
  output_style: "default",
  skills: ["hardware-troubleshooting"],
  plugins: [],
  uuid: "00000000-0000-4000-8000-000000000001",
  session_id: "00000000-0000-4000-8000-000000000002",
} as SDKMessage;

test("Case runs through Claude Agent SDK with native tools, Skill, and FixAgent MCP", async () => {
  let captured: Parameters<typeof query>[0] | undefined;

  const runtime = createClaudeAgentRuntime({
    environment: {
      PATH: "/bin",
      HOME: "/isolated/cases/case-123/.home",
      CLAUDE_CONFIG_DIR: "/isolated/cases/case-123/.home/.claude",
      FIXAGENT_HOST_HOME: "/host-home",
      FIXAGENT_CASES_ROOT: "/isolated/cases",
      ANTHROPIC_AUTH_TOKEN: "secret",
    },
    queryAgent(parameters) {
      captured = parameters;
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield validInitMessage;
      })();
    },
  });

  await runtime.run({
    caseId: "case-123",
    cwd: "/isolated/cases/case-123",
    userMessage: "屏幕右边有黑边",
    async publish() {},
    async trace() {},
  });

  assert.ok(captured);
  assert.equal(captured.prompt, "屏幕右边有黑边");
  assert.equal(captured.options?.cwd, "/isolated/cases/case-123");
  assert.deepEqual(captured.options?.settingSources, ["project"]);
  assert.deepEqual(captured.options?.skills, ["hardware-troubleshooting"]);
  assert.equal(captured.options?.tools, undefined);
  assert.deepEqual(captured.options?.disallowedTools, ["Agent"]);
  assert.deepEqual(captured.options?.allowedTools, [
    "Bash",
    "Read(scratch/**)",
    "Edit(scratch/**)",
    "mcp__fixagent__publish_case_response",
  ]);
  assert.equal(captured.options?.mcpServers?.fixagent?.type, "sdk");
  assert.deepEqual(captured.options?.sandbox?.filesystem, {
    allowWrite: [resolve("/isolated/cases/case-123/scratch")],
    denyWrite: [resolve("/isolated/cases/case-123")],
    denyRead: [resolve("/host-home"), resolve("/isolated/cases")],
    allowRead: [
      resolve("/isolated/cases/case-123"),
      resolve("/isolated/cases/case-123/.claude/skills"),
      resolve("/isolated/cases/case-123/.home"),
    ],
  });
  assert.deepEqual(captured.options?.sandbox?.credentials?.envVars, [
    { name: "ANTHROPIC_API_KEY", mode: "deny" },
    { name: "ANTHROPIC_AUTH_TOKEN", mode: "deny" },
  ]);
  assert.equal(captured.options?.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  assert.equal(captured.options?.env?.CLAUDE_CODE_SKIP_PROMPT_HISTORY, "1");
  assert.equal(captured.options?.env?.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS, "1");
  assert.equal(captured.options?.env?.npm_config_registry, undefined);
  assert.equal(captured.options?.env?.FIXAGENT_HOST_HOME, undefined);
  assert.equal(captured.options?.env?.FIXAGENT_CASES_ROOT, undefined);
});

test("Case is rejected when SDK init cannot prove the core Skill is available", async () => {
  const runtime = createClaudeAgentRuntime({
    environment: {},
    queryAgent() {
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield {
          ...validInitMessage,
          skills: [],
        } as SDKMessage;
      })();
    },
  });

  await assert.rejects(
    runtime.run({
      caseId: "case-123",
      cwd: "/isolated/cases/case-123",
      userMessage: "屏幕右边有黑边",
      async publish() {},
      async trace() {},
    }),
    /ARCHITECTURE_GATE_FAILED.*hardware-troubleshooting/,
  );
});
