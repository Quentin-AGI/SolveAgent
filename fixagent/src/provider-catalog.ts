export const knownProviderCatalog = [
  {
    id: "qwen",
    display_name: "通义千问",
    provider_label: "阿里云百炼",
    provider_id: "qwen",
    runtime_model_id: "qwen3.8-flash",
    credential_type: "ANTHROPIC_AUTH_TOKEN",
    capabilities: ["tools", "vision"],
  },
  {
    id: "kimi",
    display_name: "Kimi",
    provider_label: "Moonshot AI",
    provider_id: "kimi",
    runtime_model_id: "kimi-k3[1m]",
    credential_type: "ANTHROPIC_AUTH_TOKEN",
    capabilities: ["tools"],
  },
  {
    id: "zhipu",
    display_name: "智谱 GLM",
    provider_label: "智谱开放平台",
    provider_id: "zhipu",
    runtime_model_id: "glm-4.7",
    credential_type: "ANTHROPIC_AUTH_TOKEN",
    capabilities: ["tools"],
  },
  {
    id: "deepseek",
    display_name: "DeepSeek",
    provider_label: "DeepSeek",
    provider_id: "deepseek",
    runtime_model_id: "deepseek-flash[1m]",
    credential_type: "ANTHROPIC_AUTH_TOKEN",
    capabilities: ["tools"],
  },
] as const;

export type KnownProviderId = (typeof knownProviderCatalog)[number]["id"];

export const findKnownProvider = (id: string) =>
  knownProviderCatalog.find((provider) => provider.id === id);
