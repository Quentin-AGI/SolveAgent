import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { createClaudeAgentRuntime } from "../src/claude-agent-runtime.js";
import { EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT } from "../src/knowledge-store.js";

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
    "mcp__fixagent__get_product_context",
    "mcp__fixagent__search_product_docs",
    "mcp__fixagent__search_historical_cases",
    "mcp__fixagent__get_action_policy",
    "mcp__fixagent__get_case_state",
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
  let savedSessionId: string | undefined;

  const runtime = createClaudeAgentRuntime({
    knowledgeSnapshot: EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT,
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
    async saveSession(sessionId) {
      savedSessionId = sessionId;
    },
  });

  assert.ok(captured);
  assert.equal(captured.prompt, "屏幕右边有黑边");
  assert.equal(captured.options?.cwd, "/isolated/cases/case-123");
  assert.deepEqual(captured.options?.settingSources, ["project"]);
  assert.deepEqual(captured.options?.skills, ["hardware-troubleshooting"]);
  assert.equal(captured.options?.persistSession, true);
  assert.equal(captured.options?.tools, undefined);
  assert.deepEqual(captured.options?.disallowedTools, ["Agent"]);
  assert.deepEqual(captured.options?.allowedTools, [
    "Bash",
    "Read(scratch/**)",
    "Edit(scratch/**)",
    "mcp__fixagent__*",
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
  assert.equal(captured.options?.env?.CLAUDE_CODE_SKIP_PROMPT_HISTORY, undefined);
  assert.equal(captured.options?.env?.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS, "1");
  assert.equal(captured.options?.env?.npm_config_registry, undefined);
  assert.equal(captured.options?.env?.FIXAGENT_HOST_HOME, undefined);
  assert.equal(captured.options?.env?.FIXAGENT_CASES_ROOT, undefined);
  assert.equal(savedSessionId, "00000000-0000-4000-8000-000000000002");

  const stopHook = captured.options?.hooks?.Stop?.[0]?.hooks[0];
  assert.ok(stopHook);
  const stopOutput = await stopHook(
    {
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "普通文本回答",
    } as never,
    undefined,
    { signal: new AbortController().signal },
  );
  assert.equal("decision" in stopOutput ? stopOutput.decision : undefined, "block");
});

test("general questions fall back to a host-published response when a provider skips the publish tool", async () => {
  let published: unknown;
  const runtime = createClaudeAgentRuntime({
    knowledgeSnapshot: EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT,
    environment: {},
    queryAgent() {
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield validInitMessage;
        yield {
          type: "result",
          subtype: "success",
          result: "我可以协助分析问题和附件。",
        } as SDKMessage;
      })();
    },
  });

  await runtime.run({
    caseId: "case-123",
    cwd: "/isolated/cases/case-123",
    userMessage: "目前这个模型具备什么能力？",
    async publish(candidate) {
      published = candidate;
    },
    async trace() {},
    async saveSession() {},
  });

  assert.deepEqual(published, {
    message_markdown: "我可以协助分析问题和附件。",
    claim_refs: [],
    action_card_refs: [],
    response_type: "GENERAL",
  });
});

test("diagnostic questions never use the plain-text fallback", async () => {
  let published: unknown;
  const runtime = createClaudeAgentRuntime({
    knowledgeSnapshot: EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT,
    environment: {},
    queryAgent() {
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield validInitMessage;
        yield {
          type: "result",
          subtype: "success",
          result: "请拆开设备检查线路。",
        } as SDKMessage;
      })();
    },
  });

  await runtime.run({
    caseId: "case-123",
    cwd: "/isolated/cases/case-123",
    userMessage: "帮助我修复车辆屏幕",
    async publish(candidate) {
      published = candidate;
    },
    async trace() {},
    async saveSession() {},
  });

  assert.equal(published, undefined);
});

test("Case is rejected when SDK init cannot prove the core Skill is available", async () => {
  const runtime = createClaudeAgentRuntime({
    knowledgeSnapshot: EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT,
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
      async saveSession() {},
    }),
    /ARCHITECTURE_GATE_FAILED.*hardware-troubleshooting/,
  );
});

test("a returning Case resumes its own Claude Agent SDK Session", async () => {
  let captured: Parameters<typeof query>[0] | undefined;
  const runtime = createClaudeAgentRuntime({
    knowledgeSnapshot: EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT,
    environment: {},
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
    userMessage: "继续",
    sessionId: "00000000-0000-4000-8000-000000000099",
    async publish() {},
    async trace() {},
    async saveSession() {},
  });

  assert.equal(
    captured?.options?.resume,
    "00000000-0000-4000-8000-000000000099",
  );
  assert.equal(captured?.options?.forkSession, true);
});

test("a Case starts a fresh persisted Session when its saved Session is missing", async () => {
  const captured: Parameters<typeof query>[0][] = [];
  let savedSessionId: string | undefined;
  const runtime = createClaudeAgentRuntime({
    knowledgeSnapshot: EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT,
    environment: {},
    queryAgent(parameters) {
      captured.push(parameters);
      return (async function* (): AsyncGenerator<SDKMessage> {
        if (parameters.options?.resume) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            errors: [
              `No conversation found with session ID: ${parameters.options.resume}`,
            ],
          } as SDKMessage;
          throw new Error("SDK process exited after the missing Session result");
        }
        yield {
          ...validInitMessage,
          session_id: "00000000-0000-4000-8000-000000000099",
        } as SDKMessage;
      })();
    },
  });

  await runtime.run({
    caseId: "case-123",
    cwd: "/isolated/cases/case-123",
    userMessage: "请读取附件",
    sessionId: "00000000-0000-4000-8000-000000000002",
    async publish() {},
    async trace() {},
    async saveSession(sessionId) {
      savedSessionId = sessionId;
    },
  });

  assert.equal(captured.length, 2);
  assert.equal(
    captured[0]?.options?.resume,
    "00000000-0000-4000-8000-000000000002",
  );
  assert.equal(captured[1]?.options?.resume, undefined);
  assert.equal(savedSessionId, "00000000-0000-4000-8000-000000000099");
});

test("Case is rejected when observed model differs from the Frozen Provider Profile", async () => {
  const runtime = createClaudeAgentRuntime({
    knowledgeSnapshot: EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT,
    environment: {
      FIXAGENT_EXPECTED_OBSERVED_MODEL_ID: "expected-model",
    },
    queryAgent() {
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield validInitMessage;
      })();
    },
  });

  await assert.rejects(
    runtime.run({
      caseId: "case-123",
      cwd: "/isolated/cases/case-123",
      userMessage: "继续",
      async publish() {},
      async trace() {},
      async saveSession() {},
    }),
    /ARCHITECTURE_GATE_FAILED.*frozen observed model/,
  );
});
