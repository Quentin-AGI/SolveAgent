import { createHash } from "node:crypto";

export const CLAUDE_AGENT_SDK_PACKAGE_VERSION = "0.3.280";

export const providerRuntimeEnvironmentKeys = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "FIXAGENT_MODEL",
  "FIXAGENT_PROVIDER_ID",
  "FIXAGENT_PROVIDER_CAPABILITIES",
  "FIXAGENT_TOOL_SEARCH_MODE",
  "FIXAGENT_CONTEXT_WINDOW",
  "FIXAGENT_EXPECTED_CLAUDE_CODE_VERSION",
  "FIXAGENT_EXPECTED_OBSERVED_MODEL_ID",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_EFFORT_LEVEL",
] as const;

export interface FrozenProviderProfile {
  provider_id: string;
  anthropic_base_url: string | null;
  credential_type: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY" | "UNCONFIGURED";
  requested_model_id: string;
  default_model_ids: {
    opus: string | null;
    sonnet: string | null;
    haiku: string | null;
    fable: string | null;
  };
  runtime_config: {
    subagent_model: string | null;
    max_context_tokens: string | null;
    auto_compact_window: string | null;
    effort_level: string | null;
    tool_search_mode: string | null;
    context_window: string | null;
    capabilities: string[];
  };
  sdk_package_version: string;
  expected_claude_code_version: string | null;
  expected_observed_model_id: string | null;
  certification_config: {
    billing_plan: string | null;
    region: string | null;
    endpoint_source: string | null;
    external_config_hash: string | null;
    fallback_detected: boolean;
  };
}

export const normalizedProviderValue = (
  value: string | undefined,
): string | null =>
  value?.trim() ? value.trim() : null;

export const buildFrozenProviderProfile = (
  environment: NodeJS.ProcessEnv,
): FrozenProviderProfile => {
  const hasAuthToken = Boolean(
    normalizedProviderValue(environment.ANTHROPIC_AUTH_TOKEN),
  );
  const hasApiKey = Boolean(
    normalizedProviderValue(environment.ANTHROPIC_API_KEY),
  );
  if (hasAuthToken && hasApiKey) {
    throw new Error("PROVIDER_CREDENTIAL_AMBIGUOUS");
  }
  if (environment.FIXAGENT_FALLBACK_DETECTED === "true") {
    throw new Error("PROVIDER_FALLBACK_DETECTED");
  }

  const requestedModel =
    normalizedProviderValue(environment.FIXAGENT_MODEL) ??
    normalizedProviderValue(environment.ANTHROPIC_MODEL) ??
    "UNCONFIGURED";
  const providerId =
    normalizedProviderValue(environment.FIXAGENT_PROVIDER_ID) ??
    "UNCONFIGURED";
  const expectedClaudeCodeVersion =
    normalizedProviderValue(environment.FIXAGENT_EXPECTED_CLAUDE_CODE_VERSION);
  const baseUrl = normalizedProviderValue(environment.ANTHROPIC_BASE_URL);
  const capabilities = (environment.FIXAGENT_PROVIDER_CAPABILITIES ?? "")
    .split(",")
    .map((capability) => capability.trim())
    .filter(Boolean)
    .sort();
  const defaultModelIds = {
    opus: normalizedProviderValue(environment.ANTHROPIC_DEFAULT_OPUS_MODEL),
    sonnet: normalizedProviderValue(environment.ANTHROPIC_DEFAULT_SONNET_MODEL),
    haiku: normalizedProviderValue(environment.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    fable: normalizedProviderValue(environment.ANTHROPIC_DEFAULT_FABLE_MODEL),
  };
  const credentialType = hasAuthToken
    ? "ANTHROPIC_AUTH_TOKEN"
    : hasApiKey
      ? "ANTHROPIC_API_KEY"
      : "UNCONFIGURED";
  const providerIsConfigured = Boolean(
    providerId !== "UNCONFIGURED" ||
      requestedModel !== "UNCONFIGURED" ||
      baseUrl ||
      credentialType !== "UNCONFIGURED" ||
      Object.values(defaultModelIds).some(Boolean),
  );
  if (providerIsConfigured) {
    const missing = [
      ...(providerId === "UNCONFIGURED" ? ["provider_id"] : []),
      ...(requestedModel === "UNCONFIGURED" ? ["requested_model_id"] : []),
      ...(baseUrl ? [] : ["ANTHROPIC_BASE_URL"]),
      ...(credentialType === "UNCONFIGURED" ? ["credential_type"] : []),
      ...Object.entries(defaultModelIds)
        .filter(([, value]) => !value)
        .map(([tier]) => `default_model_${tier}`),
      ...(capabilities.length > 0 ? [] : ["capabilities"]),
      ...(expectedClaudeCodeVersion
        ? []
        : ["expected_claude_code_version"]),
    ];
    if (missing.length > 0) {
      throw new Error(`PROVIDER_PROFILE_INCOMPLETE: ${missing.join(", ")}`);
    }
  }

  return {
    provider_id: providerId,
    anthropic_base_url: baseUrl,
    credential_type: credentialType,
    requested_model_id: requestedModel,
    default_model_ids: defaultModelIds,
    runtime_config: {
      subagent_model: normalizedProviderValue(environment.CLAUDE_CODE_SUBAGENT_MODEL),
      max_context_tokens: normalizedProviderValue(
        environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      ),
      auto_compact_window: normalizedProviderValue(
        environment.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      ),
      effort_level: normalizedProviderValue(environment.CLAUDE_CODE_EFFORT_LEVEL),
      tool_search_mode: normalizedProviderValue(environment.FIXAGENT_TOOL_SEARCH_MODE),
      context_window: normalizedProviderValue(environment.FIXAGENT_CONTEXT_WINDOW),
      capabilities,
    },
    sdk_package_version: CLAUDE_AGENT_SDK_PACKAGE_VERSION,
    expected_claude_code_version: expectedClaudeCodeVersion,
    expected_observed_model_id:
      normalizedProviderValue(environment.FIXAGENT_EXPECTED_OBSERVED_MODEL_ID) ??
      (requestedModel === "UNCONFIGURED" ? null : requestedModel),
    certification_config: {
      billing_plan: normalizedProviderValue(environment.FIXAGENT_BILLING_PLAN),
      region: normalizedProviderValue(environment.FIXAGENT_PROVIDER_REGION),
      endpoint_source: normalizedProviderValue(environment.FIXAGENT_ENDPOINT_SOURCE),
      external_config_hash: normalizedProviderValue(environment.FIXAGENT_PROFILE_CONFIG_HASH),
      fallback_detected: false,
    },
  };
};

export const hashProviderProfile = (
  profile: FrozenProviderProfile,
): string => createHash("sha256").update(JSON.stringify(profile)).digest("hex");

export const selectProviderCredentials = (
  environment: NodeJS.ProcessEnv,
): Pick<NodeJS.ProcessEnv, "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY"> => {
  const hasAuthToken = Boolean(
    normalizedProviderValue(environment.ANTHROPIC_AUTH_TOKEN),
  );
  const hasApiKey = Boolean(
    normalizedProviderValue(environment.ANTHROPIC_API_KEY),
  );
  if (hasAuthToken && hasApiKey) {
    throw new Error("PROVIDER_CREDENTIAL_AMBIGUOUS");
  }
  return {
    ANTHROPIC_AUTH_TOKEN: hasAuthToken
      ? environment.ANTHROPIC_AUTH_TOKEN
      : undefined,
    ANTHROPIC_API_KEY: hasApiKey ? environment.ANTHROPIC_API_KEY : undefined,
  };
};
