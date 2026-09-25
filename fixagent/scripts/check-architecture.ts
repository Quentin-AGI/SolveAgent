import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };
const dockerfile = await readFile(join(projectRoot, "Dockerfile"), "utf8");

const forbiddenDependencies = [
  "@anthropic-ai/sdk",
  "anthropic",
  "openai",
  "langchain",
  "@langchain/core",
  "@langchain/langgraph",
  "dify-client",
];

const directDependencies = Object.keys(packageJson.dependencies ?? {});
const forbiddenInstalled = forbiddenDependencies.filter((dependency) =>
  directDependencies.includes(dependency),
);

if (forbiddenInstalled.length > 0) {
  throw new Error(
    `Forbidden direct model or workflow dependencies: ${forbiddenInstalled.join(", ")}`,
  );
}

if (!directDependencies.includes("@anthropic-ai/claude-agent-sdk")) {
  throw new Error("Claude Agent SDK is not a direct production dependency.");
}

const requiredLinuxSandboxPackages = ["bubblewrap", "ripgrep", "socat"];
const missingLinuxSandboxPackages = requiredLinuxSandboxPackages.filter(
  (dependency) =>
    !new RegExp(`(?:^|\\s)${dependency}(?:\\s|\\\\|$)`, "mu").test(dockerfile),
);
if (missingLinuxSandboxPackages.length > 0) {
  throw new Error(
    `Docker runtime is missing Claude Agent SDK sandbox dependencies: ${missingLinuxSandboxPackages.join(", ")}`,
  );
}

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return nested.flat().filter((path) => extname(path) === ".ts");
};

const imports = await Promise.all(
  (await sourceFiles(join(projectRoot, "src"))).map(async (path) => ({
    path,
    source: await readFile(path, "utf8"),
  })),
);

const forbiddenImport =
  /(?:from\s+|import\s*\()["'](?:openai|anthropic|@anthropic-ai\/sdk|@langchain\/|langchain|dify-client)/;
const violatingFiles = imports
  .filter(({ source }) => forbiddenImport.test(source))
  .map(({ path }) => path.slice(projectRoot.length + 1));

if (violatingFiles.length > 0) {
  throw new Error(`Forbidden model or workflow imports: ${violatingFiles.join(", ")}`);
}

const sdkRuntime = imports.find(({ path }) =>
  path.endsWith("claude-agent-runtime.ts"),
);
if (!sdkRuntime?.source.includes('from "@anthropic-ai/claude-agent-sdk"')) {
  throw new Error("Production runtime does not import Claude Agent SDK.");
}

const server = imports.find(({ path }) => path.endsWith("server.ts"));
if (!server?.source.includes("createCaseWorkerRuntime")) {
  throw new Error("Production server does not use the isolated Case Worker runtime.");
}

const workerEntry = imports.find(({ path }) =>
  path.endsWith("case-worker-entry.ts"),
);
if (!workerEntry?.source.includes("createClaudeAgentRuntime")) {
  throw new Error("Case Worker does not delegate execution to Claude Agent SDK.");
}

const providerProfile = imports.find(({ path }) =>
  path.endsWith("provider-profile.ts"),
);
const declaredSdkVersion = providerProfile?.source.match(
  /CLAUDE_AGENT_SDK_PACKAGE_VERSION = "([^"]+)"/,
)?.[1];
if (declaredSdkVersion !== packageJson.dependencies?.["@anthropic-ai/claude-agent-sdk"]) {
  throw new Error(
    "Frozen Provider Profile SDK version does not match package.json.",
  );
}

console.log("Architecture check passed: Claude Agent SDK is the only model runtime.");
