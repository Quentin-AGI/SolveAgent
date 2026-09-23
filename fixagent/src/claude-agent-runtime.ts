import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";
import { z } from "zod";

import type {
  AgentRunRequest,
  AgentRuntime,
} from "./app.js";
import { readCaseState } from "./case-store.js";
import {
  getActionPolicy,
  loadCaseKnowledgeSnapshot,
  searchKnowledge,
  validatePublishedCaseResponse,
  type KnowledgeSnapshot,
} from "./knowledge-store.js";
import { publishedCaseResponseShape } from "./published-case-response.js";
import {
  normalizedProviderValue,
  providerRuntimeEnvironmentKeys,
  selectProviderCredentials,
} from "./provider-profile.js";

type QueryParameters = Parameters<typeof query>[0];
type QueryAgent = (parameters: QueryParameters) => AsyncIterable<SDKMessage>;

interface CreateClaudeAgentRuntimeOptions {
  queryAgent?: QueryAgent;
  environment?: NodeJS.ProcessEnv;
  knowledgeSnapshot?: KnowledgeSnapshot;
}

const systemPrompt = `You are FixAgent, a single hardware-support Agent for CarPlay and in-vehicle display terminals.
Use the hardware-troubleshooting Skill and only approved knowledge or current Case evidence.
Do not treat model memory as approved product knowledge.
Ordinary clarification and evidence requests are autonomous. Never invent a physical or state-changing device operation.
Do not request device observation or propose a device action until Case evidence confirms the vehicle is safely parked. You may first ask the user to confirm that fact.
Use get_product_context before making configuration-specific claims. Use search_product_docs and search_historical_cases for approved evidence.
Use get_action_policy before proposing any instruction that asks the user to touch the device or change device state. An empty policy result means no device action is allowed.
Use get_case_state to reuse confirmed evidence and avoid repeating stable questions.
Knowledge and Action Card references must contain the exact ID and version returned by these tools.
All user-visible diagnostic, explanatory, or operational content must be submitted through mcp__fixagent__publish_case_response.
Do not rely on ordinary assistant text being shown to the user.`;

const buildAgentEnvironment = (
  source: NodeJS.ProcessEnv,
): Record<string, string | undefined> => {
  const environment: Record<string, string | undefined> = {
    PATH: source.PATH,
    HOME: source.HOME,
    CLAUDE_CONFIG_DIR: source.CLAUDE_CONFIG_DIR,
    TMPDIR: source.TMPDIR,
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    CLAUDE_AGENT_SDK_CLIENT_APP: "fixagent-v0/0.1.0",
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
  };

  for (const key of providerRuntimeEnvironmentKeys) {
    environment[key] = source[key];
  }
  Object.assign(environment, selectProviderCredentials(source));

  return environment;
};

const assertArchitectureInit = (
  message: Extract<SDKMessage, { type: "system"; subtype: "init" }>,
  environment: NodeJS.ProcessEnv,
): void => {
  const requiredTools = [
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
  ];
  const missingTools = requiredTools.filter(
    (requiredTool) => !message.tools.includes(requiredTool),
  );
  const missingSkill = !message.skills.includes("hardware-troubleshooting");
  const fixAgentMcpConnected = message.mcp_servers.some(
    (server) =>
      server.name === "fixagent" &&
      server.status === "connected" &&
      server.source === "sdk",
  );
  const expectedClaudeCodeVersion =
    normalizedProviderValue(environment.FIXAGENT_EXPECTED_CLAUDE_CODE_VERSION);
  const expectedObservedModelId =
    normalizedProviderValue(environment.FIXAGENT_EXPECTED_OBSERVED_MODEL_ID) ??
    normalizedProviderValue(environment.FIXAGENT_MODEL) ??
    normalizedProviderValue(environment.ANTHROPIC_MODEL);
  const failures = [
    ...missingTools,
    ...(missingSkill ? ["hardware-troubleshooting"] : []),
    ...(fixAgentMcpConnected ? [] : ["fixagent MCP"]),
    ...(expectedClaudeCodeVersion &&
    expectedClaudeCodeVersion !== message.claude_code_version
      ? ["frozen Claude Code version"]
      : []),
    ...(expectedObservedModelId && expectedObservedModelId !== message.model
      ? ["frozen observed model"]
      : []),
  ];

  if (failures.length > 0) {
    throw new Error(`ARCHITECTURE_GATE_FAILED: missing ${failures.join(", ")}`);
  }
};

const toolResult = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

const publicationErrorCode = (error: unknown): string =>
  error instanceof Error
    ? (error.message.split(":", 1)[0] ?? "PUBLICATION_REJECTED")
    : "PUBLICATION_REJECTED";

const createFixAgentMcpServer = (
  request: AgentRunRequest,
  snapshot: KnowledgeSnapshot,
) => {
  const getProductContext = tool(
    "get_product_context",
    "Return the frozen product family, configuration, hardware, software, and region for this Case.",
    {},
    async () =>
      toolResult({
        knowledge_snapshot_id: snapshot.snapshot_id,
        product_context: snapshot.product_context,
      }),
    { annotations: { idempotentHint: true, openWorldHint: false }, alwaysLoad: true },
  );

  const searchInput = {
    query: z.string().trim().min(1).max(500),
    max_results: z.number().int().min(1).max(10).optional(),
  };
  const searchProductDocs = tool(
    "search_product_docs",
    "Search applicable approved product documentation in the frozen Knowledge Snapshot.",
    searchInput,
    async ({ query, max_results: maxResults }) =>
      toolResult({
        knowledge_snapshot_id: snapshot.snapshot_id,
        results: searchKnowledge(snapshot, "PRODUCT_DOC", query, maxResults),
      }),
    { annotations: { idempotentHint: true, openWorldHint: false }, alwaysLoad: true },
  );
  const searchHistoricalCases = tool(
    "search_historical_cases",
    "Search applicable approved historical Cases. Results are prior evidence, not proof of the current Case.",
    searchInput,
    async ({ query, max_results: maxResults }) =>
      toolResult({
        knowledge_snapshot_id: snapshot.snapshot_id,
        results: searchKnowledge(
          snapshot,
          "HISTORICAL_CASE",
          query,
          maxResults,
        ),
      }),
    { annotations: { idempotentHint: true, openWorldHint: false }, alwaysLoad: true },
  );
  const getCaseState = tool(
    "get_case_state",
    "Return the current structured Case facts, hypotheses, unknowns, evidence, actions, and do-not-ask-again records.",
    {},
    async () => {
      const state = await readCaseState(request.cwd);
      return toolResult({
        case_id: state.case_id,
        state_revision: state.state_revision,
        knowledge_snapshot_id: state.knowledge_snapshot_id,
        route: state.route,
        safety_status: state.safety_status,
        facts: state.facts,
        hypotheses: state.hypotheses,
        unknowns: state.unknowns,
        evidence_refs: state.evidence_refs,
        actions_and_results: state.actions_and_results,
        do_not_ask_again: state.do_not_ask_again,
      });
    },
    { annotations: { idempotentHint: true, openWorldHint: false }, alwaysLoad: true },
  );
  const getApprovedActionPolicy = tool(
    "get_action_policy",
    "Return approved Action Cards whose configuration and evidence prerequisites match the current Case, plus applicable prohibited actions. This does not choose the next action.",
    {},
    async () => {
      const state = await readCaseState(request.cwd);
      return toolResult({
        knowledge_snapshot_id: snapshot.snapshot_id,
        ...getActionPolicy(snapshot, state.evidence_refs),
      });
    },
    { annotations: { idempotentHint: true, openWorldHint: false }, alwaysLoad: true },
  );

  const publishCaseResponse = tool(
    "publish_case_response",
    "Validate and publish the exact user-visible FixAgent response. This is the only publication path.",
    publishedCaseResponseShape,
    async (args) => {
      try {
        const state = await readCaseState(request.cwd);
        const response = validatePublishedCaseResponse({
          candidate: args,
          snapshot,
          caseKnowledgeSnapshotId: state.knowledge_snapshot_id,
          evidenceRefs: state.evidence_refs,
        });
        await request.publish(response);
        return toolResult({ status: "PUBLISHED" });
      } catch (error) {
        return {
          ...toolResult({
            status: "REJECTED",
            code: publicationErrorCode(error),
          }),
          isError: true,
        };
      }
    },
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  return createSdkMcpServer({
    name: "fixagent",
    version: "0.1.0",
    tools: [
      getProductContext,
      searchProductDocs,
      searchHistoricalCases,
      getApprovedActionPolicy,
      getCaseState,
      publishCaseResponse,
    ],
    alwaysLoad: true,
  });
};

export const createClaudeAgentRuntime = ({
  queryAgent = query,
  environment = process.env,
  knowledgeSnapshot,
}: CreateClaudeAgentRuntimeOptions = {}): AgentRuntime => ({
  async run(request) {
    const snapshot =
      knowledgeSnapshot ?? (await loadCaseKnowledgeSnapshot(request.cwd));
    const fixagent = createFixAgentMcpServer(request, snapshot);
    const model =
      normalizedProviderValue(environment.FIXAGENT_MODEL) ??
      normalizedProviderValue(environment.ANTHROPIC_MODEL);
    const caseWorkspaceRoot = request.cwd;
    const deniedReadRoots = [
      environment.FIXAGENT_HOST_HOME,
      environment.FIXAGENT_CASES_ROOT,
    ]
      .filter((path): path is string => Boolean(path))
      .map((path) => resolve(path));

    const options: NonNullable<QueryParameters["options"]> = {
      cwd: request.cwd,
      settingSources: ["project"],
      skills: ["hardware-troubleshooting"],
      mcpServers: { fixagent },
      strictMcpConfig: true,
      allowedTools: [
        "Bash",
        "Read(scratch/**)",
        // Claude Code applies Edit path rules to both native Edit and Write.
        "Edit(scratch/**)",
        "mcp__fixagent__*",
      ],
      disallowedTools: ["Agent"],
      permissionMode: "dontAsk",
      permissionPrompts: "none",
      env: buildAgentEnvironment(environment),
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: {
          allowedDomains: [],
          strictAllowlist: true,
          allowLocalBinding: false,
        },
        filesystem: {
          allowWrite: [resolve(caseWorkspaceRoot, "scratch")],
          denyWrite: [resolve(caseWorkspaceRoot)],
          denyRead: deniedReadRoots,
          allowRead: [
            resolve(caseWorkspaceRoot),
            resolve(caseWorkspaceRoot, ".claude", "skills"),
            resolve(caseWorkspaceRoot, ".home"),
          ],
        },
        credentials: {
          envVars: [
            { name: "ANTHROPIC_API_KEY", mode: "deny" },
            { name: "ANTHROPIC_AUTH_TOKEN", mode: "deny" },
          ],
        },
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: systemPrompt,
        snapshot: true,
      },
      maxTurns: 8,
      maxBudgetUsd: 0.5,
      ...(request.sessionId
        ? { resume: request.sessionId, forkSession: true }
        : {}),
      ...(model ? { model } : {}),
    };

    let architectureInitSeen = false;

    for await (const message of queryAgent({
      prompt: request.userMessage,
      options,
    })) {
      await request.trace(message);
      if (message.type === "system" && message.subtype === "init") {
        assertArchitectureInit(message, environment);
        await request.saveSession(message.session_id);
        architectureInitSeen = true;
      }
      // SDK output remains internal. Only publish_case_response reaches the UI.
    }

    if (!architectureInitSeen) {
      throw new Error("ARCHITECTURE_GATE_FAILED: SDK init not observed");
    }
  },
});
