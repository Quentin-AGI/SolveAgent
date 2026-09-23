import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  acquireCaseWorkerLease,
  commitCaseEvent,
  createInitialCaseState,
  hashCaseRequest,
  readCaseEventByIdempotencyKey,
  readCaseState,
  releaseCaseWorkerLease,
  type CaseState,
} from "./case-store.js";
import {
  domainErrorCode,
  FixAgentDomainError,
} from "./domain-error.js";
import {
  EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT,
  loadCaseKnowledgeSnapshot,
  materializeCaseKnowledgeSnapshot,
  parseKnowledgeSnapshot,
  validatePublishedCaseResponse,
  type KnowledgeSnapshot,
} from "./knowledge-store.js";
import type { PublishedCaseResponse } from "./published-case-response.js";
import {
  buildFrozenProviderProfile,
  CLAUDE_CODE_VERSION,
  hashProviderProfile,
  isSecureProviderBaseUrl,
  type FrozenProviderProfile,
} from "./provider-profile.js";
import {
  findKnownProvider,
  knownProviderCatalog,
  type KnownProviderId,
} from "./provider-catalog.js";
import {
  createSafetyHandoff,
  detectSafetyRedline,
  SAFETY_FALLBACK_MESSAGE,
  SAFETY_FALLBACK_MESSAGE_HASH,
  SAFETY_FALLBACK_TEMPLATE_ID,
} from "./safety-gate.js";

export type { PublishedCaseResponse } from "./published-case-response.js";

export interface AgentRunRequest {
  caseId: string;
  cwd: string;
  userMessage: string;
  providerEnvironment?: NodeJS.ProcessEnv;
  sessionId?: string;
  publish(response: unknown): Promise<void>;
  saveSession(sessionId: string): Promise<void>;
  trace(event: unknown): Promise<void>;
}

export interface AgentRuntime {
  run(request: AgentRunRequest): Promise<void>;
}

export interface FixAgentServer {
  readonly url: URL;
  listen(port?: number, host?: string): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderRuntimeProfile {
  id: string;
  display_name: string;
  provider_label: string;
  profile: FrozenProviderProfile;
  environment: NodeJS.ProcessEnv;
}

export interface ModelConfigurationInput {
  id: KnownProviderId;
  anthropic_base_url: string;
  model_id: string;
  credential_type: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
  credential?: string;
  expected_claude_code_version: string;
  capabilities: string[];
  make_default: boolean;
}

export interface ProviderRegistrySnapshot {
  providerProfiles: readonly ProviderRuntimeProfile[];
  historicalProviderProfiles?: readonly ProviderRuntimeProfile[];
  defaultProviderProfileId?: string;
}

export interface ProviderRegistryEditor {
  upsert(input: ModelConfigurationInput): Promise<ProviderRegistrySnapshot>;
  remove(id: KnownProviderId): Promise<ProviderRegistrySnapshot>;
}

interface CreateFixAgentServerOptions {
  runtime: AgentRuntime;
  workspaceRoot: string;
  publicRoot?: string;
  skillFile?: string;
  safetyHandoffWriter?: typeof createSafetyHandoff;
  providerProfile?: FrozenProviderProfile;
  providerProfiles?: readonly ProviderRuntimeProfile[];
  historicalProviderProfiles?: readonly ProviderRuntimeProfile[];
  defaultProviderProfileId?: string;
  providerRegistryEditor?: ProviderRegistryEditor;
  knowledgeSnapshot?: KnowledgeSnapshot;
}

class AgentResponseRejectedError extends FixAgentDomainError {
  constructor() {
    super("AGENT_RESPONSE_REJECTED");
  }
}

class AgentResponseNotPublishedError extends FixAgentDomainError {
  constructor() {
    super("AGENT_RESPONSE_NOT_PUBLISHED");
  }
}

const parseResponsePlan = (
  candidate: unknown,
): { status: number; body: unknown } => {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("status" in candidate) ||
    typeof candidate.status !== "number" ||
    !("body" in candidate)
  ) {
    throw new FixAgentDomainError("CASE_CACHED_RESPONSE_INVALID");
  }
  return { status: candidate.status, body: candidate.body };
};

const defaultPublicRoot = fileURLToPath(new URL("../public", import.meta.url));
const defaultSkillFile = fileURLToPath(
  new URL("../skills/hardware-troubleshooting/SKILL.md", import.meta.url),
);

const publicFiles = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { name: "styles.css", type: "text/css; charset=utf-8" }],
]);

const rawTraceRetentionMs = 7 * 24 * 60 * 60 * 1_000;
const tracePruneIntervalMs = 60 * 60 * 1_000;

export const pruneExpiredTraces = async (
  workspaceRoot: string,
  now = new Date(),
): Promise<void> => {
  let caseEntries;
  try {
    caseEntries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    console.error("CRITICAL_OPERATIONAL_ERROR: trace retention scan failed");
    return;
  }

  await Promise.all(
    caseEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const traceFile = join(
          workspaceRoot,
          entry.name,
          "trace",
          "events.jsonl",
        );
        try {
          const metadata = await stat(traceFile);
          if (now.getTime() - metadata.mtimeMs > rawTraceRetentionMs) {
            await unlink(traceFile);
          }
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return;
          }
          console.error(
            `CRITICAL_OPERATIONAL_ERROR: trace retention deletion failed for Case ${entry.name}`,
          );
        }
      }),
  );
};

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > 64 * 1024) {
      throw new FixAgentDomainError("REQUEST_TOO_LARGE");
    }
    chunks.push(buffer);
  }

  const content = Buffer.concat(chunks).toString("utf8");
  return content.trim() ? JSON.parse(content) : {};
};

const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

const isLoopbackAddress = (address: string | undefined): boolean =>
  Boolean(
    address &&
      (address === "::1" ||
        address.startsWith("127.") ||
        address.startsWith("::ffff:127.")),
  );

const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
};

const isTrustedConfigurationRequest = (request: IncomingMessage): boolean => {
  if (
    !isLoopbackAddress(request.socket.remoteAddress) ||
    !isLoopbackHost(request.headers.host)
  ) {
    return false;
  }
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsedOrigin = new URL(origin);
    return (
      ["http:", "https:"].includes(parsedOrigin.protocol) &&
      parsedOrigin.host === request.headers.host
    );
  } catch {
    return false;
  }
};

const appendCaseTrace = async ({
  caseWorkspaceRoot,
  leaseId,
  event,
}: {
  caseWorkspaceRoot: string;
  leaseId: string;
  event: unknown;
}): Promise<void> => {
  const write = async (): Promise<void> => {
    const current = await readCaseState(caseWorkspaceRoot);
    if (current.worker_lease_id !== leaseId) {
      throw new FixAgentDomainError("CASE_WORKER_LEASE_LOST");
    }
    await appendFile(
      join(caseWorkspaceRoot, "trace", "events.jsonl"),
      `${JSON.stringify(event)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  };

  try {
    await write();
  } catch (error) {
    if (error instanceof FixAgentDomainError) {
      throw error;
    }
    await write();
  }
};

export const createFixAgentServer = ({
  runtime,
  workspaceRoot,
  publicRoot = defaultPublicRoot,
  skillFile = defaultSkillFile,
  safetyHandoffWriter = createSafetyHandoff,
  providerProfile,
  providerProfiles,
  historicalProviderProfiles,
  defaultProviderProfileId,
  providerRegistryEditor,
  knowledgeSnapshot = EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT,
}: CreateFixAgentServerOptions): FixAgentServer => {
  const legacyProviderProfile =
    providerProfile ?? buildFrozenProviderProfile(process.env);
  const legacyCatalogEntry = knownProviderCatalog.find(
    (entry) => entry.provider_id === legacyProviderProfile.provider_id,
  );
  const legacyRuntimeProfile: ProviderRuntimeProfile = {
    id: legacyCatalogEntry?.id ?? "default",
    display_name:
      legacyProviderProfile.requested_model_id === "UNCONFIGURED"
        ? "FixAgent V0"
        : legacyCatalogEntry?.display_name ??
          legacyProviderProfile.requested_model_id,
    provider_label:
      legacyProviderProfile.provider_id === "UNCONFIGURED"
        ? "未配置"
        : legacyCatalogEntry?.provider_label ?? legacyProviderProfile.provider_id,
    profile: legacyProviderProfile,
    environment: process.env,
  };
  let runtimeProfiles: readonly ProviderRuntimeProfile[] = [];
  let profilesById = new Map<string, ProviderRuntimeProfile>();
  let profilesByHash = new Map<string, ProviderRuntimeProfile>();
  let resolvedDefaultProviderProfileId = "";
  const installRuntimeProfiles = (
    nextProfiles: readonly ProviderRuntimeProfile[],
    nextDefaultProviderProfileId?: string,
    nextHistoricalProfiles: readonly ProviderRuntimeProfile[] = [],
  ): void => {
    const effectiveProfiles =
      nextProfiles.length > 0 ? nextProfiles : [legacyRuntimeProfile];
    const nextProfilesById = new Map<string, ProviderRuntimeProfile>();
    const nextProfilesByHash = new Map<string, ProviderRuntimeProfile>();
    for (const runtimeProfile of effectiveProfiles) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runtimeProfile.id)) {
        throw new Error(`PROVIDER_PROFILE_ID_INVALID: ${runtimeProfile.id}`);
      }
      if (nextProfilesById.has(runtimeProfile.id)) {
        throw new Error(`PROVIDER_PROFILE_ID_DUPLICATE: ${runtimeProfile.id}`);
      }
      const runtimeProfileHash = hashProviderProfile(runtimeProfile.profile);
      if (nextProfilesByHash.has(runtimeProfileHash)) {
        throw new Error(
          `PROVIDER_PROFILE_RUNTIME_IDENTITY_DUPLICATE: ${runtimeProfile.id}`,
        );
      }
      nextProfilesById.set(runtimeProfile.id, runtimeProfile);
      nextProfilesByHash.set(runtimeProfileHash, runtimeProfile);
    }
    for (const historicalProfile of nextHistoricalProfiles) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(historicalProfile.id)) {
        throw new Error(`PROVIDER_PROFILE_ID_INVALID: ${historicalProfile.id}`);
      }
      const historicalHash = hashProviderProfile(historicalProfile.profile);
      if (!nextProfilesByHash.has(historicalHash)) {
        nextProfilesByHash.set(historicalHash, historicalProfile);
      }
    }
    const nextDefault =
      nextDefaultProviderProfileId ?? effectiveProfiles[0]?.id;
    if (!nextDefault || !nextProfilesById.has(nextDefault)) {
      throw new Error("DEFAULT_PROVIDER_PROFILE_NOT_FOUND");
    }
    runtimeProfiles = effectiveProfiles;
    profilesById = nextProfilesById;
    profilesByHash = nextProfilesByHash;
    resolvedDefaultProviderProfileId = nextDefault;
  };
  installRuntimeProfiles(
    providerProfiles ?? [],
    defaultProviderProfileId,
    historicalProviderProfiles,
  );
  const activeKnowledgeSnapshot = parseKnowledgeSnapshot(knowledgeSnapshot);

  const isConfiguredRuntimeProfile = (
    runtimeProfile: ProviderRuntimeProfile,
  ): boolean =>
    runtimeProfile.profile.credential_type !== "UNCONFIGURED" &&
    runtimeProfile.profile.requested_model_id !== "UNCONFIGURED";

  const publicRuntimeProfile = (runtimeProfile: ProviderRuntimeProfile) => {
    const configured = isConfiguredRuntimeProfile(runtimeProfile);
    return {
      id: runtimeProfile.id,
      display_name: runtimeProfile.display_name,
      provider_label: runtimeProfile.provider_label,
      provider_id: runtimeProfile.profile.provider_id,
      configured,
      anthropic_base_url: runtimeProfile.profile.anthropic_base_url,
    };
  };
  const createPublicModelCatalog = () => {
    const knownIds = new Set<string>(
      knownProviderCatalog.map((item) => item.id),
    );
    const publicDefaultProfile = publicRuntimeProfile(
      profilesById.get(resolvedDefaultProviderProfileId)!,
    );
    return {
      configuration_enabled: Boolean(providerRegistryEditor),
      default_model_id: publicDefaultProfile.configured
        ? resolvedDefaultProviderProfileId
        : null,
      models: [
        ...runtimeProfiles
          .filter((runtimeProfile) => !knownIds.has(runtimeProfile.id))
          .map(publicRuntimeProfile)
          .filter(
            (runtimeProfile) =>
              runtimeProfile.configured || runtimeProfile.id !== "default",
          ),
        ...knownProviderCatalog.map((knownProvider) => {
          const runtimeProfile = profilesById.get(knownProvider.id);
          return runtimeProfile
            ? publicRuntimeProfile(runtimeProfile)
            : {
                id: knownProvider.id,
                display_name: knownProvider.display_name,
                provider_label: knownProvider.provider_label,
                provider_id: knownProvider.provider_id,
                configured: false,
                anthropic_base_url: null,
              };
        }),
      ],
    };
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      const publicFile = request.method === "GET" ? publicFiles.get(url.pathname) : undefined;
      if (publicFile) {
        const content = await readFile(join(publicRoot, publicFile.name));
        response.writeHead(200, { "content-type": publicFile.type });
        response.end(content);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/models") {
        sendJson(response, 200, createPublicModelCatalog());
        return;
      }

      const modelConfigurationRoute = url.pathname.match(
        /^\/api\/models\/([a-z0-9_-]+)$/i,
      );
      if (
        modelConfigurationRoute &&
        (request.method === "PUT" || request.method === "DELETE")
      ) {
        if (!isTrustedConfigurationRequest(request)) {
          sendJson(response, 403, {
            error: "PROVIDER_CONFIGURATION_FORBIDDEN",
          });
          return;
        }
        if (!providerRegistryEditor) {
          sendJson(response, 503, {
            error: "PROVIDER_CONFIGURATION_DISABLED",
          });
          return;
        }
        const requestedProviderId = modelConfigurationRoute[1] ?? "";
        const knownProvider = findKnownProvider(requestedProviderId);
        if (!knownProvider) {
          sendJson(response, 404, { error: "PROVIDER_PROFILE_NOT_FOUND" });
          return;
        }

        if (request.method === "DELETE") {
          const registry = await providerRegistryEditor.remove(knownProvider.id);
          installRuntimeProfiles(
            registry.providerProfiles,
            registry.defaultProviderProfileId,
            registry.historicalProviderProfiles,
          );
          sendJson(response, 200, createPublicModelCatalog());
          return;
        }

        const configurationBody = z
          .object({
            api_url: z
              .url()
              .refine(isSecureProviderBaseUrl),
            api_key: z.string().trim().min(1).max(2_000),
          })
          .strict()
          .parse(await readJson(request));
        const registry = await providerRegistryEditor.upsert({
          id: knownProvider.id,
          anthropic_base_url: configurationBody.api_url,
          model_id: knownProvider.runtime_model_id,
          credential_type: knownProvider.credential_type,
          credential: configurationBody.api_key,
          expected_claude_code_version: CLAUDE_CODE_VERSION,
          capabilities: [...knownProvider.capabilities],
          make_default: false,
        });
        installRuntimeProfiles(
          registry.providerProfiles,
          registry.defaultProviderProfileId,
          registry.historicalProviderProfiles,
        );
        sendJson(response, 200, createPublicModelCatalog());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/cases") {
        const createBody = z
          .object({
            evaluation_case_id: z.string().min(1).optional(),
            provider_profile_id: z.string().min(1).optional(),
          })
          .strict()
          .parse(await readJson(request));
        const selectedRuntimeProfile = profilesById.get(
          createBody.provider_profile_id ?? resolvedDefaultProviderProfileId,
        );
        if (!selectedRuntimeProfile) {
          sendJson(response, 400, { error: "PROVIDER_PROFILE_NOT_FOUND" });
          return;
        }
        if (
          providerRegistryEditor &&
          !isConfiguredRuntimeProfile(selectedRuntimeProfile)
        ) {
          sendJson(response, 400, {
            error: "PROVIDER_PROFILE_NOT_CONFIGURED",
          });
          return;
        }
        const selectedProviderProfile = selectedRuntimeProfile.profile;
        const selectedProviderProfileHash = hashProviderProfile(
          selectedProviderProfile,
        );
        if (
          activeKnowledgeSnapshot.mode === "EVALUATION" &&
          (activeKnowledgeSnapshot.documents.length > 0 ||
            activeKnowledgeSnapshot.evaluation_cases.length > 0) &&
          !createBody.evaluation_case_id
        ) {
          sendJson(response, 400, { error: "EVALUATION_CASE_REQUIRED" });
          return;
        }
        let initialKnowledgeSnapshot = activeKnowledgeSnapshot;
        if (createBody.evaluation_case_id) {
          try {
            initialKnowledgeSnapshot = materializeCaseKnowledgeSnapshot(
              activeKnowledgeSnapshot,
              createBody.evaluation_case_id,
            );
          } catch (error) {
            if (error instanceof FixAgentDomainError) {
              sendJson(response, 400, { error: error.code });
              return;
            }
            throw error;
          }
        }
        const initialKnowledgeSnapshotContent = `${JSON.stringify(
          initialKnowledgeSnapshot,
          null,
          2,
        )}\n`;
        const caseId = randomUUID();
        const caseWorkspaceRoot = join(workspaceRoot, caseId);
        const scratchDirectory = join(caseWorkspaceRoot, "scratch");
        const traceDirectory = join(caseWorkspaceRoot, "trace");
        const fixAgentDirectory = join(caseWorkspaceRoot, ".fixagent");
        const caseSkillDirectory = join(
          caseWorkspaceRoot,
          ".claude",
          "skills",
          "hardware-troubleshooting",
        );
        await mkdir(scratchDirectory, { recursive: true });
        await mkdir(traceDirectory, { recursive: true, mode: 0o700 });
        await mkdir(fixAgentDirectory, { recursive: true, mode: 0o700 });
        await mkdir(join(caseWorkspaceRoot, ".home", ".claude"), {
          recursive: true,
          mode: 0o700,
        });
        await mkdir(join(caseWorkspaceRoot, "handoff_outbox"), {
          recursive: true,
          mode: 0o700,
        });
        await mkdir(join(caseWorkspaceRoot, "evidence"), {
          recursive: true,
          mode: 0o555,
        });
        await mkdir(caseSkillDirectory, { recursive: true });
        const caseSkillFile = join(caseSkillDirectory, "SKILL.md");
        await copyFile(skillFile, caseSkillFile);
        await chmod(caseSkillFile, 0o444);
        await chmod(caseSkillDirectory, 0o555);
        await chmod(join(caseWorkspaceRoot, ".claude", "skills"), 0o555);
        await chmod(join(caseWorkspaceRoot, ".claude"), 0o555);
        const traceFile = join(traceDirectory, "events.jsonl");
        await writeFile(traceFile, "", { mode: 0o600 });
        await chmod(traceFile, 0o600);
        const knowledgeSnapshotFile = join(
          fixAgentDirectory,
          "knowledge-snapshot.json",
        );
        await writeFile(
          knowledgeSnapshotFile,
          initialKnowledgeSnapshotContent,
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        await chmod(knowledgeSnapshotFile, 0o444);
        await chmod(fixAgentDirectory, 0o555);
        await createInitialCaseState({
          caseId,
          caseWorkspaceRoot,
          providerId: selectedProviderProfile.provider_id,
          modelId: selectedProviderProfile.requested_model_id,
          providerProfileHash: selectedProviderProfileHash,
          knowledgeSnapshotId: initialKnowledgeSnapshot.snapshot_id,
          knowledgeSnapshotHash: initialKnowledgeSnapshot.content_hash,
        });
        sendJson(response, 201, {
          case_id: caseId,
          knowledge_snapshot_id: initialKnowledgeSnapshot.snapshot_id,
          cutoff_at: initialKnowledgeSnapshot.cutoff_at,
          evaluation_case_id:
            initialKnowledgeSnapshot.case_binding?.evaluation_case_id ?? null,
        });
        return;
      }

      const messageRoute = url.pathname.match(
        /^\/api\/cases\/([0-9a-f-]+)\/messages$/,
      );
      if (request.method === "POST" && messageRoute) {
        const caseId = messageRoute[1];
        if (!caseId) {
          sendJson(response, 404, { error: "CASE_NOT_FOUND" });
          return;
        }
        const caseWorkspaceRoot = join(workspaceRoot, caseId);
        let caseState: CaseState;
        try {
          caseState = await readCaseState(caseWorkspaceRoot);
          if (caseState.case_id !== caseId) {
            throw new FixAgentDomainError("CASE_ID_MISMATCH");
          }
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            sendJson(response, 404, { error: "CASE_NOT_FOUND" });
            return;
          }
          throw error;
        }
        const selectedRuntimeProfile = profilesByHash.get(
          caseState.provider_profile_hash,
        );
        const providerProfileMatches = Boolean(selectedRuntimeProfile);
        const caseKnowledgeSnapshot = await loadCaseKnowledgeSnapshot(
          caseWorkspaceRoot,
        );
        const knowledgeSnapshotMatches =
          caseState.knowledge_snapshot_id ===
            caseKnowledgeSnapshot.snapshot_id &&
          caseState.knowledge_snapshot_hash ===
            caseKnowledgeSnapshot.content_hash;
        const validateResponseForState = (
          candidate: unknown,
          state: CaseState,
        ): PublishedCaseResponse =>
          validatePublishedCaseResponse({
            candidate,
            snapshot: caseKnowledgeSnapshot,
            caseKnowledgeSnapshotId: state.knowledge_snapshot_id,
            caseKnowledgeSnapshotHash: state.knowledge_snapshot_hash,
            evidenceRefs: state.evidence_refs,
          });

        const body = z
          .object({
            message: z.string().trim().min(1).max(8_000),
            idempotency_key: z.string().uuid().optional(),
          })
          .parse(await readJson(request));

        const messageIdempotencyKey = body.idempotency_key ?? randomUUID();
        const requestHash = hashCaseRequest({ message: body.message });
        const completedTurn = await readCaseEventByIdempotencyKey({
          caseId,
          caseWorkspaceRoot,
          idempotencyKey: `turn:${messageIdempotencyKey}`,
          requestHash,
        });
        if (completedTurn) {
          const cached = parseResponsePlan(completedTurn.result);
          sendJson(response, cached.status, cached.body);
          return;
        }
        const publishedBeforeCompletion = await readCaseEventByIdempotencyKey({
          caseId,
          caseWorkspaceRoot,
          idempotencyKey: `response:${messageIdempotencyKey}`,
          requestHash,
        });

        const lease = await acquireCaseWorkerLease(
          caseWorkspaceRoot,
          caseId,
        );
        let responsePlan: { status: number; body: unknown };
        try {
          caseState = await readCaseState(caseWorkspaceRoot);
          responsePlan = await (async () => {
            ({ state: caseState } = await commitCaseEvent({
              caseId,
              caseWorkspaceRoot,
              expectedRevision: caseState.state_revision,
              idempotencyKey: `lease:acquire:${lease.lease_id}`,
              eventType: "WORKER_LEASE_ACQUIRED",
              patch: { worker_lease_id: lease.lease_id },
            }));
            if (!providerProfileMatches) {
              await commitCaseEvent({
                caseId,
                caseWorkspaceRoot,
                expectedRevision: caseState.state_revision,
                idempotencyKey: `system-error:${messageIdempotencyKey}:provider-profile`,
                eventType: "SYSTEM_ERROR",
                patch: {},
                requestHash,
                metadata: { code: "FROZEN_PROVIDER_PROFILE_MISMATCH" },
                workerLeaseId: lease.lease_id,
              });
              try {
                await appendCaseTrace({
                  caseWorkspaceRoot,
                  leaseId: lease.lease_id,
                  event: {
                  type: "system_error",
                  code: "FROZEN_PROVIDER_PROFILE_MISMATCH",
                  },
                });
              } catch {
                console.error(
                  "CRITICAL_OPERATIONAL_ERROR: provider mismatch trace unavailable",
                );
              }
              throw new FixAgentDomainError(
                "FROZEN_PROVIDER_PROFILE_MISMATCH",
              );
            }
            if (!knowledgeSnapshotMatches) {
              await commitCaseEvent({
                caseId,
                caseWorkspaceRoot,
                expectedRevision: caseState.state_revision,
                idempotencyKey: `system-error:${messageIdempotencyKey}:knowledge-snapshot`,
                eventType: "SYSTEM_ERROR",
                patch: {},
                requestHash,
                metadata: { code: "FROZEN_KNOWLEDGE_SNAPSHOT_MISMATCH" },
                workerLeaseId: lease.lease_id,
              });
              throw new FixAgentDomainError(
                "FROZEN_KNOWLEDGE_SNAPSHOT_MISMATCH",
              );
            }
            if (publishedBeforeCompletion) {
              const recoveredResponse = validateResponseForState(
                publishedBeforeCompletion.result,
                caseState,
              );
              return {
                status: 200,
                body: {
                  case_id: caseId,
                  data_status: "DATA_NO_GO",
                  response: recoveredResponse,
                },
              };
            }
            await commitCaseEvent({
              caseId,
              caseWorkspaceRoot,
              expectedRevision: caseState.state_revision,
              idempotencyKey: `message:${messageIdempotencyKey}`,
              eventType: "CUSTOMER_MESSAGE_RECEIVED",
              requestHash,
              workerLeaseId: lease.lease_id,
              patch: {
                customer_round_count: caseState.customer_round_count + 1,
              },
            });
            caseState = await readCaseState(caseWorkspaceRoot);

            const safetyTrigger = detectSafetyRedline(body.message);
            if (safetyTrigger) {
              let handoff:
                | Awaited<ReturnType<typeof createSafetyHandoff>>
                | { status: "PERSISTENCE_FAILED" };
              let persistenceError: string | undefined;
              try {
                handoff = await safetyHandoffWriter({
                  caseId,
                  caseWorkspaceRoot,
                  trigger: safetyTrigger,
                });
              } catch {
                try {
                  handoff = await safetyHandoffWriter({
                    caseId,
                    caseWorkspaceRoot,
                    trigger: safetyTrigger,
                  });
                } catch (error) {
                  persistenceError =
                    error instanceof Error
                      ? error.message
                      : "HANDOFF_PERSISTENCE_FAILED";
                  handoff = { status: "PERSISTENCE_FAILED" };
                }
              }

              ({ state: caseState } = await commitCaseEvent({
                caseId,
                caseWorkspaceRoot,
                expectedRevision: caseState.state_revision,
                idempotencyKey: `safety:${messageIdempotencyKey}`,
                eventType: persistenceError
                  ? "SAFETY_HANDOFF_PERSISTENCE_FAILED"
                  : "SAFETY_HANDOFF_CREATED",
                patch: {
                route: "SAFETY_HANDOFF",
                safety_status: "TRIGGERED",
                safety_gate_rule_version: "APPROVED_TEXT_RULE_V0",
                safety_message_template_id: SAFETY_FALLBACK_TEMPLATE_ID,
                handoff_reason: safetyTrigger.ruleIds.join(","),
                  last_response_type: "SAFETY_HANDOFF",
                },
                requestHash,
                workerLeaseId: lease.lease_id,
              }));

              try {
                await appendCaseTrace({
                  caseWorkspaceRoot,
                  leaseId: lease.lease_id,
                  event: {
                    type: persistenceError
                      ? "critical_operational_error"
                      : "safety_gate",
                    source: "APPROVED_TEXT_RULE",
                    rule_ids: safetyTrigger.ruleIds,
                    template_id: SAFETY_FALLBACK_TEMPLATE_ID,
                    template_hash: SAFETY_FALLBACK_MESSAGE_HASH,
                    handoff_persistence: handoff.status,
                    ...(handoff.status === "SIMULATED_NOT_CONTACTED"
                      ? { handoff_id: handoff.id }
                      : {}),
                    ...(persistenceError ? { error: persistenceError } : {}),
                  },
                });
              } catch {
                console.error(
                  "CRITICAL_OPERATIONAL_ERROR: safety trace unavailable",
                );
              }
              return {
                status: 200,
                body: {
                  case_id: caseId,
                  data_status: "DATA_NO_GO",
                  response: {
                    message_markdown: SAFETY_FALLBACK_MESSAGE,
                    claim_refs: [],
                    action_card_refs: [],
                    response_type: "SAFETY_HANDOFF",
                  },
                  handoff,
                },
              };
            }

            let publishedResponse: PublishedCaseResponse | undefined;
            let lastAttemptError: unknown;
            const turnBaseSessionId = caseState.claude_session_id;
            for (let attempt = 1; attempt <= 2; attempt += 1) {
              try {
                let attemptResponse: PublishedCaseResponse | undefined;
                await runtime.run({
                  caseId,
                  cwd: caseWorkspaceRoot,
                  userMessage: body.message,
                  providerEnvironment:
                    selectedRuntimeProfile?.environment ?? process.env,
                  ...(turnBaseSessionId
                    ? { sessionId: turnBaseSessionId }
                    : {}),
                  async publish(candidate) {
                    if (attemptResponse) {
                      throw new AgentResponseRejectedError();
                    }
                    const current = await readCaseState(caseWorkspaceRoot);
                    let parsed: PublishedCaseResponse;
                    try {
                      parsed = validateResponseForState(candidate, current);
                    } catch {
                      throw new AgentResponseRejectedError();
                    }
                    attemptResponse = parsed;
                    await commitCaseEvent({
                      caseId,
                      caseWorkspaceRoot,
                      expectedRevision: current.state_revision,
                      idempotencyKey: `response:${messageIdempotencyKey}`,
                      eventType: "RESPONSE_PUBLISHED",
                      patch: {
                        last_response_type: parsed.response_type,
                        knowledge_conflict_ids: [
                          ...new Set([
                            ...current.knowledge_conflict_ids,
                            ...(parsed.knowledge_conflict_refs ?? []),
                          ]),
                        ],
                      },
                      requestHash,
                      result: parsed,
                      workerLeaseId: lease.lease_id,
                    });
                    caseState = await readCaseState(caseWorkspaceRoot);
                  },
                  async saveSession(sessionId) {
                    const current = await readCaseState(caseWorkspaceRoot);
                    if (current.claude_session_id === sessionId) return;
                    await commitCaseEvent({
                      caseId,
                      caseWorkspaceRoot,
                      expectedRevision: current.state_revision,
                      idempotencyKey: `session:${sessionId}`,
                      eventType: "CLAUDE_SESSION_SAVED",
                      patch: { claude_session_id: sessionId },
                      requestHash,
                      workerLeaseId: lease.lease_id,
                    });
                    caseState = await readCaseState(caseWorkspaceRoot);
                  },
                  async trace(event) {
                    await appendCaseTrace({
                      caseWorkspaceRoot,
                      leaseId: lease.lease_id,
                      event,
                    });
                  },
                });
                if (!attemptResponse) {
                  throw new AgentResponseNotPublishedError();
                }
                publishedResponse = attemptResponse;
                break;
              } catch (error) {
                lastAttemptError = error;
                const code = domainErrorCode(error, "UNKNOWN_RUNTIME_ERROR");
                if (
                  [
                    "CASE_IDEMPOTENCY_CONFLICT",
                    "CASE_ID_MISMATCH",
                    "CASE_REVISION_CONFLICT",
                    "CASE_WORKER_LEASE_LOST",
                  ].includes(code)
                ) {
                  throw error;
                }
                try {
                  const current = await readCaseState(caseWorkspaceRoot);
                  await commitCaseEvent({
                    caseId,
                    caseWorkspaceRoot,
                    expectedRevision: current.state_revision,
                    idempotencyKey: `system-error:${messageIdempotencyKey}:${attempt}`,
                    eventType: "SYSTEM_ERROR",
                    patch: {},
                    requestHash,
                    metadata: { attempt, code },
                    workerLeaseId: lease.lease_id,
                  });
                  await appendCaseTrace({
                    caseWorkspaceRoot,
                    leaseId: lease.lease_id,
                    event: {
                      type: "system_error",
                      attempt,
                      code,
                    },
                  });
                } catch {
                  console.error(
                    "CRITICAL_OPERATIONAL_ERROR: SYSTEM_ERROR persistence failed",
                  );
                }
                const committedResponse =
                  await readCaseEventByIdempotencyKey({
                    caseId,
                    caseWorkspaceRoot,
                    idempotencyKey: `response:${messageIdempotencyKey}`,
                    requestHash,
                });
                if (committedResponse) {
                  const current = await readCaseState(caseWorkspaceRoot);
                  publishedResponse = validateResponseForState(
                    committedResponse.result,
                    current,
                  );
                  break;
                }
              }
            }

            if (!publishedResponse) {
              const failure =
                lastAttemptError ?? new Error("UNKNOWN_RUNTIME_ERROR");
              const isPublicationFailure =
                failure instanceof AgentResponseRejectedError ||
                failure instanceof AgentResponseNotPublishedError;
              return {
                status: isPublicationFailure ? 502 : 500,
                body: {
                  error: isPublicationFailure
                    ? failure.message
                    : "SYSTEM_ERROR",
                },
              };
            }

            return {
              status: 200,
              body: {
                case_id: caseId,
                data_status: "DATA_NO_GO",
                response: publishedResponse,
              },
            };
          })();
          const current = await readCaseState(caseWorkspaceRoot);
          await commitCaseEvent({
            caseId,
            caseWorkspaceRoot,
            expectedRevision: current.state_revision,
            idempotencyKey: `turn:${messageIdempotencyKey}`,
            eventType:
              responsePlan.status >= 500 ? "TURN_FAILED" : "TURN_COMPLETED",
            patch: {},
            requestHash,
            result: responsePlan,
            workerLeaseId: lease.lease_id,
          });
        } finally {
          try {
            const current = await readCaseState(caseWorkspaceRoot);
            if (current.worker_lease_id === lease.lease_id) {
              await commitCaseEvent({
                caseId,
                caseWorkspaceRoot,
                expectedRevision: current.state_revision,
                idempotencyKey: `lease:release:${lease.lease_id}`,
                eventType: "WORKER_LEASE_RELEASED",
                patch: { worker_lease_id: null },
                workerLeaseId: lease.lease_id,
              });
            }
          } finally {
            await releaseCaseWorkerLease(caseWorkspaceRoot, lease.lease_id);
          }
        }
        sendJson(response, responsePlan.status, responsePlan.body);
        return;
      }

      sendJson(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        sendJson(response, 400, { error: "INVALID_REQUEST" });
        return;
      }
      if (
        error instanceof FixAgentDomainError &&
        error.code === "REQUEST_TOO_LARGE"
      ) {
        sendJson(response, 413, { error: error.code });
        return;
      }
      if (
        error instanceof FixAgentDomainError &&
        ["PROVIDER_CREDENTIAL_REQUIRED", "PROVIDER_PROFILE_NOT_FOUND"].includes(
          error.code,
        )
      ) {
        sendJson(response, 400, { error: error.code });
        return;
      }
      if (error instanceof AgentResponseRejectedError) {
        sendJson(response, 502, { error: error.message });
        return;
      }
      if (error instanceof AgentResponseNotPublishedError) {
        sendJson(response, 502, { error: error.message });
        return;
      }
      if (
        error instanceof FixAgentDomainError &&
        error.code === "CASE_WORKER_LEASE_CONFLICT"
      ) {
        sendJson(response, 409, { error: "CASE_BUSY" });
        return;
      }
      if (
        error instanceof FixAgentDomainError &&
        error.code === "CASE_IDEMPOTENCY_CONFLICT"
      ) {
        sendJson(response, 409, { error: "CASE_IDEMPOTENCY_CONFLICT" });
        return;
      }
      if (
        error instanceof FixAgentDomainError &&
        error.code === "CASE_REVISION_CONFLICT"
      ) {
        sendJson(response, 409, { error: "CASE_REVISION_CONFLICT" });
        return;
      }
      sendJson(response, 500, { error: "SYSTEM_ERROR" });
    }
  });

  let address: URL | undefined;
  let tracePruneTimer: NodeJS.Timeout | undefined;

  return {
    get url() {
      if (!address) throw new Error("SERVER_NOT_LISTENING");
      return address;
    },
    async listen(port = 0, host = "127.0.0.1") {
      await pruneExpiredTraces(workspaceRoot);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const bound = server.address();
          if (!bound || typeof bound === "string") {
            reject(new Error("SERVER_ADDRESS_UNAVAILABLE"));
            return;
          }
          address = new URL(`http://${host}:${bound.port}`);
          resolve();
        });
      });
      tracePruneTimer = setInterval(() => {
        void pruneExpiredTraces(workspaceRoot);
      }, tracePruneIntervalMs);
      tracePruneTimer.unref();
    },
    async close() {
      if (tracePruneTimer) {
        clearInterval(tracePruneTimer);
        tracePruneTimer = undefined;
      }
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
};
