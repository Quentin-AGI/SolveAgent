import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const stateSchema = z.object({
  schema_version: z.literal("fixagent.case-state.v0"),
  case_id: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  state_revision: z.number().int().nonnegative(),
  claude_session_id: z.string().nullable(),
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
  provider_profile_hash: z.string().regex(/^[a-f0-9]{64}$/),
  knowledge_snapshot_id: z.string().min(1),
  knowledge_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
  worker_lease_id: z.string().nullable(),
  route: z.enum([
    "EVIDENCE_COLLECTION",
    "AWAITING_USER_ACTION",
    "SAFETY_HANDOFF",
    "HANDOFF",
    "RESOLVED",
  ]),
  safety_status: z.enum(["CLEAR", "TRIGGERED"]),
  safety_gate_rule_version: z.string().nullable(),
  safety_trigger_evidence_refs: z.array(z.string()),
  safety_message_template_id: z.string().nullable(),
  facts: z.array(z.unknown()),
  hypotheses: z.array(z.unknown()),
  unknowns: z.array(z.unknown()),
  evidence_refs: z.array(z.string()),
  actions_and_results: z.array(z.unknown()),
  awaiting_action_id: z.string().nullable(),
  no_progress_count: z.number().int().nonnegative(),
  customer_round_count: z.number().int().nonnegative(),
  do_not_ask_again: z.array(z.unknown()),
  last_response_type: z.string().nullable(),
  handoff_reason: z.string().nullable(),
  outcome: z.string().nullable(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type CaseState = z.infer<typeof stateSchema>;
export type CaseStatePatch = Partial<
  Omit<
    CaseState,
    | "schema_version"
    | "case_id"
    | "created_at"
    | "updated_at"
    | "state_revision"
    | "content_hash"
  >
>;

const eventSchema = z.object({
  schema_version: z.literal("fixagent.case-event.v0"),
  event_id: z.string().uuid(),
  case_id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  occurred_at: z.string().datetime(),
  idempotency_key: z.string().min(1),
  event_type: z.string().min(1),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  result: z.unknown().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  state_after: stateSchema,
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type CaseEvent = z.infer<typeof eventSchema>;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const hashCaseRequest = (value: unknown): string =>
  sha256(JSON.stringify(value));

const withContentHash = <T extends object>(value: T): T & { content_hash: string } => ({
  ...value,
  content_hash: sha256(JSON.stringify(value)),
});

const verifyHash = <T extends { content_hash: string }>(value: T): void => {
  const { content_hash: contentHash, ...withoutHash } = value;
  if (sha256(JSON.stringify(withoutHash)) !== contentHash) {
    throw new Error("CASE_STORE_HASH_MISMATCH");
  }
};

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
};

const withOneStorageRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    const isDomainFailure =
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      (error instanceof Error && error.message.startsWith("CASE_"));
    if (isDomainFailure) throw error;
    return operation();
  }
};

const readCaseEvents = async (caseWorkspaceRoot: string): Promise<CaseEvent[]> => {
  const content = await readFile(join(caseWorkspaceRoot, "events.jsonl"), "utf8");
  if (!content.trim()) return [];
  const events = content
    .trim()
    .split("\n")
    .map((line) => {
      const event = eventSchema.parse(JSON.parse(line));
      verifyHash(event);
      verifyHash(event.state_after);
      return event;
    });
  events.forEach((event, index) => {
    if (
      event.revision !== index ||
      event.state_after.state_revision !== event.revision ||
      event.state_after.case_id !== event.case_id
    ) {
      throw new Error("CASE_EVENT_LOG_INVALID_SEQUENCE");
    }
  });
  return events;
};

const readCaseStateOnce = async (
  caseWorkspaceRoot: string,
): Promise<CaseState> => {
  const events = await readCaseEvents(caseWorkspaceRoot);
  const latestEvent = events.at(-1);
  if (!latestEvent) throw new Error("CASE_EVENT_LOG_EMPTY");

  try {
    const state = stateSchema.parse(
      JSON.parse(await readFile(join(caseWorkspaceRoot, "state.json"), "utf8")),
    );
    verifyHash(state);
    if (state.case_id !== latestEvent.case_id) {
      throw new Error("CASE_ID_MISMATCH");
    }
    if (state.state_revision > latestEvent.revision) {
      throw new Error("CASE_STATE_AHEAD_OF_EVENT_LOG");
    }
    if (state.state_revision === latestEvent.revision) {
      if (state.content_hash !== latestEvent.state_after.content_hash) {
        throw new Error("CASE_STATE_EVENT_MISMATCH");
      }
      return state;
    }
    await writeJsonAtomic(
      join(caseWorkspaceRoot, "state.json"),
      latestEvent.state_after,
    );
    return latestEvent.state_after;
  } catch (error) {
    const projectionCanBeRebuilt =
      (error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT") ||
      error instanceof SyntaxError ||
      error instanceof z.ZodError ||
      (error instanceof Error &&
        ["CASE_STORE_HASH_MISMATCH", "CASE_STATE_EVENT_MISMATCH"].includes(
          error.message,
        ));
    if (projectionCanBeRebuilt) {
      await writeJsonAtomic(
        join(caseWorkspaceRoot, "state.json"),
        latestEvent.state_after,
      );
      return latestEvent.state_after;
    }
    throw error;
  }
};

export const readCaseState = (
  caseWorkspaceRoot: string,
): Promise<CaseState> =>
  withOneStorageRetry(() => readCaseStateOnce(caseWorkspaceRoot));

interface CreateInitialCaseStateInput {
  caseId: string;
  caseWorkspaceRoot: string;
  providerId: string;
  modelId: string;
  providerProfileHash: string;
  knowledgeSnapshotId: string;
  knowledgeSnapshotHash: string;
}

const createInitialCaseStateOnce = async ({
  caseId,
  caseWorkspaceRoot,
  providerId,
  modelId,
  providerProfileHash,
  knowledgeSnapshotId,
  knowledgeSnapshotHash,
}: CreateInitialCaseStateInput): Promise<CaseState> => {
  try {
    const existing = await readCaseState(caseWorkspaceRoot);
    if (existing.case_id !== caseId) throw new Error("CASE_ID_MISMATCH");
    return existing;
  } catch (error) {
    const absent =
      (error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT") ||
      (error instanceof Error && error.message === "CASE_EVENT_LOG_EMPTY");
    if (!absent) throw error;
  }

  const now = new Date().toISOString();
  const state = withContentHash({
    schema_version: "fixagent.case-state.v0" as const,
    case_id: caseId,
    created_at: now,
    updated_at: now,
    state_revision: 0,
    claude_session_id: null,
    provider_id: providerId,
    model_id: modelId,
    provider_profile_hash: providerProfileHash,
    knowledge_snapshot_id: knowledgeSnapshotId,
    knowledge_snapshot_hash: knowledgeSnapshotHash,
    worker_lease_id: null,
    route: "EVIDENCE_COLLECTION" as const,
    safety_status: "CLEAR" as const,
    safety_gate_rule_version: null,
    safety_trigger_evidence_refs: [],
    safety_message_template_id: null,
    facts: [],
    hypotheses: [],
    unknowns: [],
    evidence_refs: [],
    actions_and_results: [],
    awaiting_action_id: null,
    no_progress_count: 0,
    customer_round_count: 0,
    do_not_ask_again: [],
    last_response_type: null,
    handoff_reason: null,
    outcome: null,
  });
  const event = withContentHash({
    schema_version: "fixagent.case-event.v0" as const,
    event_id: randomUUID(),
    case_id: caseId,
    revision: 0,
    occurred_at: now,
    idempotency_key: `case:create:${caseId}`,
    event_type: "CASE_CREATED",
    request_hash: null,
    result: null,
    metadata: {},
    state_after: state,
  });

  await appendFile(
    join(caseWorkspaceRoot, "events.jsonl"),
    `${JSON.stringify(event)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await writeJsonAtomic(join(caseWorkspaceRoot, "state.json"), state);
  return state;
};

export const createInitialCaseState = (
  input: CreateInitialCaseStateInput,
): Promise<CaseState> =>
  withOneStorageRetry(() => createInitialCaseStateOnce(input));

interface CommitCaseEventInput {
  caseId: string;
  caseWorkspaceRoot: string;
  expectedRevision: number;
  idempotencyKey: string;
  eventType: string;
  patch: CaseStatePatch;
  requestHash?: string;
  result?: unknown;
  metadata?: Record<string, unknown>;
  workerLeaseId?: string;
}

const commitCaseEventOnce = async ({
  caseId,
  caseWorkspaceRoot,
  expectedRevision,
  idempotencyKey,
  eventType,
  patch,
  requestHash,
  result,
  metadata = {},
  workerLeaseId,
}: CommitCaseEventInput): Promise<{ state: CaseState; event: CaseEvent }> => {
  const current = await readCaseState(caseWorkspaceRoot);
  if (current.case_id !== caseId) throw new Error("CASE_ID_MISMATCH");
  if (workerLeaseId && current.worker_lease_id !== workerLeaseId) {
    throw new Error("CASE_WORKER_LEASE_LOST");
  }

  const events = await readCaseEvents(caseWorkspaceRoot);
  const repeated = events.find(
    (event) => event.idempotency_key === idempotencyKey,
  );
  if (repeated) {
    const repeatedResultMatches =
      result === undefined ||
      hashCaseRequest(repeated.result) === hashCaseRequest(result);
    if (
      repeated.event_type !== eventType ||
      repeated.case_id !== caseId ||
      (requestHash !== undefined && repeated.request_hash !== requestHash) ||
      !repeatedResultMatches
    ) {
      throw new Error("CASE_IDEMPOTENCY_CONFLICT");
    }
    return { state: repeated.state_after, event: repeated };
  }

  if (current.state_revision !== expectedRevision) {
    throw new Error(
      `CASE_REVISION_CONFLICT: expected ${expectedRevision}, actual ${current.state_revision}`,
    );
  }

  const occurredAt = new Date().toISOString();
  const { content_hash: _contentHash, ...currentWithoutHash } = current;
  const state = withContentHash({
    ...currentWithoutHash,
    ...patch,
    updated_at: occurredAt,
    state_revision: current.state_revision + 1,
  });
  const event = withContentHash({
    schema_version: "fixagent.case-event.v0" as const,
    event_id: randomUUID(),
    case_id: caseId,
    revision: state.state_revision,
    occurred_at: occurredAt,
    idempotency_key: idempotencyKey,
    event_type: eventType,
    request_hash: requestHash ?? null,
    result: result ?? null,
    metadata,
    state_after: state,
  });
  const statePath = join(caseWorkspaceRoot, "state.json");
  const temporaryStatePath = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryStatePath,
    `${JSON.stringify(state, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await appendFile(
    join(caseWorkspaceRoot, "events.jsonl"),
    `${JSON.stringify(event)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporaryStatePath, statePath);
  return { state, event };
};

export const commitCaseEvent = (
  input: CommitCaseEventInput,
): Promise<{ state: CaseState; event: CaseEvent }> =>
  withOneStorageRetry(() => commitCaseEventOnce(input));

const readCaseEventByIdempotencyKeyOnce = async ({
  caseId,
  caseWorkspaceRoot,
  idempotencyKey,
  requestHash,
}: {
  caseId: string;
  caseWorkspaceRoot: string;
  idempotencyKey: string;
  requestHash: string;
}): Promise<CaseEvent | undefined> => {
  const event = (await readCaseEvents(caseWorkspaceRoot)).find(
    (candidate) => candidate.idempotency_key === idempotencyKey,
  );
  if (!event) return undefined;
  if (event.case_id !== caseId || event.request_hash !== requestHash) {
    throw new Error("CASE_IDEMPOTENCY_CONFLICT");
  }
  return event;
};

export const readCaseEventByIdempotencyKey = (input: {
  caseId: string;
  caseWorkspaceRoot: string;
  idempotencyKey: string;
  requestHash: string;
}): Promise<CaseEvent | undefined> =>
  withOneStorageRetry(() => readCaseEventByIdempotencyKeyOnce(input));

const leaseSchema = z.object({
  schema_version: z.literal("fixagent.worker-lease.v0"),
  case_id: z.string().min(1),
  lease_id: z.string().uuid(),
  owner_pid: z.number().int().positive(),
  owner_instance_id: z.string().uuid(),
  acquired_at: z.string().datetime(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type CaseWorkerLease = z.infer<typeof leaseSchema>;

const leaseHeartbeatSchema = z.object({
  schema_version: z.literal("fixagent.worker-lease-heartbeat.v0"),
  lease_id: z.string().uuid(),
  owner_instance_id: z.string().uuid(),
  renewed_at: z.string().datetime(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
});

const workerProcessInstanceId = randomUUID();
const leaseHeartbeatIntervalMs = 1_000;
const leaseHeartbeatStaleAfterMs = 30_000;
const activeLeaseHeartbeatTimers = new Map<string, NodeJS.Timeout>();

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error && "code" in error && error.code === "ESRCH"
    );
  }
};

const heartbeatPathFor = (leasePath: string): string =>
  `${leasePath}.heartbeat`;

const writeLeaseHeartbeat = async (leasePath: string, lease: CaseWorkerLease) => {
  const heartbeat = withContentHash({
    schema_version: "fixagent.worker-lease-heartbeat.v0" as const,
    lease_id: lease.lease_id,
    owner_instance_id: lease.owner_instance_id,
    renewed_at: new Date().toISOString(),
  });
  await writeJsonAtomic(heartbeatPathFor(leasePath), heartbeat);
};

const removeLeaseCandidate = async (leasePath: string): Promise<void> => {
  await unlink(leasePath).catch((error) => {
    if (!isMissingPathError(error)) throw error;
  });
  await unlink(heartbeatPathFor(leasePath)).catch((error) => {
    if (!isMissingPathError(error)) throw error;
  });
};

const leaseHeartbeatIsCurrent = async (
  leasePath: string,
  lease: CaseWorkerLease,
): Promise<boolean> => {
  if (!processExists(lease.owner_pid)) return false;
  try {
    const heartbeat = leaseHeartbeatSchema.parse(
      JSON.parse(await readFile(heartbeatPathFor(leasePath), "utf8")),
    );
    verifyHash(heartbeat);
    return (
      heartbeat.lease_id === lease.lease_id &&
      heartbeat.owner_instance_id === lease.owner_instance_id &&
      Date.now() - Date.parse(heartbeat.renewed_at) <=
        leaseHeartbeatStaleAfterMs
    );
  } catch (error) {
    if (
      isMissingPathError(error) ||
      error instanceof SyntaxError ||
      error instanceof z.ZodError ||
      (error instanceof Error && error.message === "CASE_STORE_HASH_MISMATCH")
    ) {
      return false;
    }
    throw error;
  }
};

interface LiveLeaseCandidate {
  lease: CaseWorkerLease;
  path: string;
  birthtimeNs: bigint;
}

const readLiveLeaseCandidates = async (
  leaseDirectory: string,
  caseId: string,
): Promise<LiveLeaseCandidate[]> => {
  const entries = await readdir(leaseDirectory, { withFileTypes: true });
  const candidates: LiveLeaseCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isSymbolicLink() || !entry.name.endsWith(".lease")) continue;
    const path = join(leaseDirectory, entry.name);
    try {
      const lease = leaseSchema.parse(JSON.parse(await readlink(path)));
      verifyHash(lease);
      if (lease.case_id !== caseId) throw new Error("CASE_ID_MISMATCH");
      if (!(await leaseHeartbeatIsCurrent(path, lease))) {
        await removeLeaseCandidate(path);
        continue;
      }
      const stats = await lstat(path, { bigint: true });
      candidates.push({ lease, path, birthtimeNs: stats.birthtimeNs });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
  }

  return candidates.sort((left, right) => {
    if (left.birthtimeNs < right.birthtimeNs) return -1;
    if (left.birthtimeNs > right.birthtimeNs) return 1;
    return left.lease.lease_id.localeCompare(right.lease.lease_id);
  });
};

const acquireLeaseFile = async (
  caseWorkspaceRoot: string,
  caseId: string,
): Promise<CaseWorkerLease> => {
  const leaseDirectory = join(caseWorkspaceRoot, "worker-leases");
  await mkdir(leaseDirectory, { recursive: true, mode: 0o700 });
  const acquiredAt = new Date();
  const lease = withContentHash({
    schema_version: "fixagent.worker-lease.v0" as const,
    case_id: caseId,
    lease_id: randomUUID(),
    owner_pid: process.pid,
    owner_instance_id: workerProcessInstanceId,
    acquired_at: acquiredAt.toISOString(),
  });
  const leasePath = join(leaseDirectory, `${lease.lease_id}.lease`);

  try {
    // The complete immutable lease is the symlink target, so a contender can
    // never observe a partially written candidate. The oldest live candidate
    // wins; dead candidates remain harmless and cannot block future owners.
    await writeLeaseHeartbeat(leasePath, lease);
    await symlink(JSON.stringify(lease), leasePath, "file");
    const liveCandidates = await readLiveLeaseCandidates(leaseDirectory, caseId);
    const winner = liveCandidates[0];
    const oldestTimestampIsTied =
      winner !== undefined &&
      liveCandidates.some(
        (candidate) =>
          candidate.lease.lease_id !== winner.lease.lease_id &&
          candidate.birthtimeNs === winner.birthtimeNs,
      );
    if (
      !winner ||
      oldestTimestampIsTied ||
      winner.lease.lease_id !== lease.lease_id
    ) {
      throw new Error("CASE_WORKER_LEASE_CONFLICT");
    }
    const heartbeatTimer = setInterval(() => {
      void writeLeaseHeartbeat(leasePath, lease).catch(() => undefined);
    }, leaseHeartbeatIntervalMs);
    heartbeatTimer.unref();
    activeLeaseHeartbeatTimers.set(lease.lease_id, heartbeatTimer);
    return lease;
  } catch (error) {
    await removeLeaseCandidate(leasePath);
    throw error;
  }
};

export const acquireCaseWorkerLease = (
  caseWorkspaceRoot: string,
  caseId: string,
): Promise<CaseWorkerLease> =>
  withOneStorageRetry(() => acquireLeaseFile(caseWorkspaceRoot, caseId));

const releaseLeaseFile = async (
  caseWorkspaceRoot: string,
  leaseId: string,
): Promise<void> => {
  const heartbeatTimer = activeLeaseHeartbeatTimers.get(leaseId);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  activeLeaseHeartbeatTimers.delete(leaseId);
  const leasePath = join(
    caseWorkspaceRoot,
    "worker-leases",
    `${leaseId}.lease`,
  );
  let existing: CaseWorkerLease;
  try {
    existing = leaseSchema.parse(JSON.parse(await readlink(leasePath)));
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  verifyHash(existing);
  if (existing.lease_id !== leaseId) {
    throw new Error("CASE_WORKER_LEASE_OWNERSHIP_MISMATCH");
  }
  await removeLeaseCandidate(leasePath);
};

export const releaseCaseWorkerLease = (
  caseWorkspaceRoot: string,
  leaseId: string,
): Promise<void> =>
  withOneStorageRetry(() => releaseLeaseFile(caseWorkspaceRoot, leaseId));
