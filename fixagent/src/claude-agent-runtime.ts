import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";

import type {
  AgentRunRequest,
  AgentRuntime,
} from "./app.js";
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
}

const systemPrompt = `You are FixAgent, a single hardware-support Agent for CarPlay and in-vehicle display terminals.
Use the hardware-troubleshooting Skill and only approved knowledge or current Case evidence.
Do not treat model memory as approved product knowledge.
Ordinary clarification and evidence requests are autonomous. Never invent a physical or state-changing device operation.
This tracer slice has no approved Knowledge or Action Card store. You may only ask for non-operational evidence, with empty claim_refs and action_card_refs and response_type EVIDENCE_REQUEST.
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
  const requiredTools = ["Bash", "Read", "Edit", "Write"];
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

const createPublishServer = (request: AgentRunRequest) => {
  const publishCaseResponse = tool(
    "publish_case_response",
    "Validate and publish the exact user-visible FixAgent response. This is the only publication path.",
    publishedCaseResponseShape,
    async (args) => {
      await request.publish(args);
      return {
        content: [{ type: "text" as const, text: "Case response published." }],
        structuredContent: { status: "PUBLISHED" },
      };
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
    tools: [publishCaseResponse],
    alwaysLoad: true,
  });
};

export const createClaudeAgentRuntime = ({
  queryAgent = query,
  environment = process.env,
}: CreateClaudeAgentRuntimeOptions = {}): AgentRuntime => ({
  async run(request) {
    const fixagent = createPublishServer(request);
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
        "mcp__fixagent__publish_case_response",
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
