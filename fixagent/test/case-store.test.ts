import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  acquireCaseWorkerLease,
  commitCaseEvent,
  createInitialCaseState,
  hashCaseRequest,
  readCaseState,
  releaseCaseWorkerLease,
  type CaseWorkerLease,
} from "../src/case-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("Case event writes are revision-checked, idempotent, and rebuildable", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-store-test-"));
  temporaryDirectories.push(workspaceRoot);
  const caseId = "00000000-0000-4000-8000-000000000123";
  const caseWorkspaceRoot = join(workspaceRoot, caseId);
  await mkdir(caseWorkspaceRoot, { recursive: true });

  const initial = await createInitialCaseState({
    caseId,
    caseWorkspaceRoot,
    providerId: "qwen",
    modelId: "qwen-model",
    providerProfileHash: hashCaseRequest({ provider: "qwen" }),
    knowledgeSnapshotId: "EMPTY_EUFY_EVAL_V0",
    knowledgeSnapshotHash: "b".repeat(64),
  });
  assert.equal(initial.state_revision, 0);
  assert.match(initial.content_hash, /^[a-f0-9]{64}$/);

  const first = await commitCaseEvent({
    caseId,
    caseWorkspaceRoot,
    expectedRevision: 0,
    idempotencyKey: "message-1",
    eventType: "CUSTOMER_MESSAGE_RECEIVED",
    patch: { customer_round_count: 1 },
    requestHash: hashCaseRequest({ message: "screen issue" }),
  });
  const repeated = await commitCaseEvent({
    caseId,
    caseWorkspaceRoot,
    expectedRevision: 0,
    idempotencyKey: "message-1",
    eventType: "CUSTOMER_MESSAGE_RECEIVED",
    patch: { customer_round_count: 1 },
    requestHash: hashCaseRequest({ message: "screen issue" }),
  });

  assert.equal(first.state.state_revision, 1);
  assert.equal(repeated.event.event_id, first.event.event_id);
  assert.equal((await readCaseState(caseWorkspaceRoot)).state_revision, 1);
  assert.equal(
    (await readFile(join(caseWorkspaceRoot, "events.jsonl"), "utf8"))
      .trim()
      .split("\n").length,
    2,
  );

  await unlink(join(caseWorkspaceRoot, "state.json"));
  assert.equal((await readCaseState(caseWorkspaceRoot)).state_revision, 1);
  assert.equal(
    JSON.parse(
      await readFile(join(caseWorkspaceRoot, "state.json"), "utf8"),
    ).state_revision,
    1,
  );

  const tamperedState = JSON.parse(
    await readFile(join(caseWorkspaceRoot, "state.json"), "utf8"),
  ) as Record<string, unknown>;
  tamperedState.knowledge_snapshot_hash = "f".repeat(64);
  delete tamperedState.content_hash;
  tamperedState.content_hash = hashCaseRequest(tamperedState);
  await writeFile(
    join(caseWorkspaceRoot, "state.json"),
    `${JSON.stringify(tamperedState, null, 2)}\n`,
  );
  assert.equal(
    (await readCaseState(caseWorkspaceRoot)).knowledge_snapshot_hash,
    "b".repeat(64),
  );

  await assert.rejects(
    commitCaseEvent({
      caseId,
      caseWorkspaceRoot,
      expectedRevision: 1,
      idempotencyKey: "message-1",
      eventType: "CUSTOMER_MESSAGE_RECEIVED",
      patch: { customer_round_count: 1 },
      requestHash: hashCaseRequest({ message: "different message" }),
    }),
    /CASE_IDEMPOTENCY_CONFLICT/,
  );

  await assert.rejects(
    commitCaseEvent({
      caseId,
      caseWorkspaceRoot,
      expectedRevision: 0,
      idempotencyKey: "message-2",
      eventType: "CUSTOMER_MESSAGE_RECEIVED",
      patch: { customer_round_count: 2 },
    }),
    /CASE_REVISION_CONFLICT/,
  );
});

test("only one Worker Lease can own a Case", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-store-test-"));
  temporaryDirectories.push(workspaceRoot);
  const caseWorkspaceRoot = join(workspaceRoot, "case-123");
  await mkdir(caseWorkspaceRoot, { recursive: true });

  const first = await acquireCaseWorkerLease(caseWorkspaceRoot, "case-123");
  await assert.rejects(
    acquireCaseWorkerLease(caseWorkspaceRoot, "case-123"),
    /CASE_WORKER_LEASE_CONFLICT/,
  );
  await releaseCaseWorkerLease(caseWorkspaceRoot, first.lease_id);
  const second = await acquireCaseWorkerLease(caseWorkspaceRoot, "case-123");
  assert.notEqual(second.lease_id, first.lease_id);
  await releaseCaseWorkerLease(caseWorkspaceRoot, second.lease_id);
});

test("a stale Worker cannot write after its Lease fencing token changes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-store-test-"));
  temporaryDirectories.push(workspaceRoot);
  const caseId = "00000000-0000-4000-8000-000000000456";
  const caseWorkspaceRoot = join(workspaceRoot, caseId);
  await mkdir(caseWorkspaceRoot, { recursive: true });
  const initial = await createInitialCaseState({
    caseId,
    caseWorkspaceRoot,
    providerId: "qwen",
    modelId: "qwen-model",
    providerProfileHash: hashCaseRequest({ provider: "qwen" }),
    knowledgeSnapshotId: "EMPTY_EUFY_EVAL_V0",
    knowledgeSnapshotHash: "b".repeat(64),
  });
  const lease = await acquireCaseWorkerLease(caseWorkspaceRoot, caseId);
  const acquired = await commitCaseEvent({
    caseId,
    caseWorkspaceRoot,
    expectedRevision: initial.state_revision,
    idempotencyKey: `lease:acquire:${lease.lease_id}`,
    eventType: "WORKER_LEASE_ACQUIRED",
    patch: { worker_lease_id: lease.lease_id },
  });

  await assert.rejects(
    commitCaseEvent({
      caseId,
      caseWorkspaceRoot,
      expectedRevision: acquired.state.state_revision,
      idempotencyKey: "stale-write",
      eventType: "CUSTOMER_MESSAGE_RECEIVED",
      patch: {},
      workerLeaseId: "00000000-0000-4000-8000-000000000999",
    }),
    /CASE_WORKER_LEASE_LOST/,
  );
  await releaseCaseWorkerLease(caseWorkspaceRoot, lease.lease_id);
});

test("dead Worker Lease artifacts cannot block a single atomic winner", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-store-test-"));
  temporaryDirectories.push(workspaceRoot);
  const caseId = "00000000-0000-4000-8000-000000000789";
  const caseWorkspaceRoot = join(workspaceRoot, caseId);
  await mkdir(caseWorkspaceRoot, { recursive: true });
  const moduleUrl = new URL("../src/case-store.ts", import.meta.url).href;
  const childScript = `
    import { acquireCaseWorkerLease } from ${JSON.stringify(moduleUrl)};
    await acquireCaseWorkerLease(${JSON.stringify(caseWorkspaceRoot)}, ${JSON.stringify(caseId)});
  `;
  for (let index = 0; index < 2; index += 1) {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
      );
    });
  }

  const contenders = await Promise.allSettled([
    acquireCaseWorkerLease(caseWorkspaceRoot, caseId),
    acquireCaseWorkerLease(caseWorkspaceRoot, caseId),
  ]);
  const winners = contenders.filter(
    (result): result is PromiseFulfilledResult<CaseWorkerLease> =>
      result.status === "fulfilled",
  );
  const losers = contenders.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  await releaseCaseWorkerLease(caseWorkspaceRoot, winners[0]!.value.lease_id);
});

test("a reused PID cannot revive a dead Worker Lease candidate", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-store-test-"));
  temporaryDirectories.push(workspaceRoot);
  const caseId = "00000000-0000-4000-8000-000000000987";
  const caseWorkspaceRoot = join(workspaceRoot, caseId);
  const leaseDirectory = join(caseWorkspaceRoot, "worker-leases");
  await mkdir(leaseDirectory, { recursive: true });

  const withoutHash = {
    schema_version: "fixagent.worker-lease.v0",
    case_id: caseId,
    lease_id: randomUUID(),
    owner_pid: process.pid,
    owner_instance_id: randomUUID(),
    acquired_at: new Date(0).toISOString(),
  };
  const staleLease = {
    ...withoutHash,
    content_hash: createHash("sha256")
      .update(JSON.stringify(withoutHash))
      .digest("hex"),
  };
  const stalePath = join(leaseDirectory, `${staleLease.lease_id}.lease`);
  const heartbeatWithoutHash = {
    schema_version: "fixagent.worker-lease-heartbeat.v0",
    lease_id: staleLease.lease_id,
    owner_instance_id: staleLease.owner_instance_id,
    renewed_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const heartbeat = {
    ...heartbeatWithoutHash,
    content_hash: createHash("sha256")
      .update(JSON.stringify(heartbeatWithoutHash))
      .digest("hex"),
  };
  await writeFile(`${stalePath}.heartbeat`, JSON.stringify(heartbeat), "utf8");
  await symlink(JSON.stringify(staleLease), stalePath, "file");

  const acquired = await acquireCaseWorkerLease(caseWorkspaceRoot, caseId);
  assert.notEqual(acquired.lease_id, staleLease.lease_id);
  await assert.rejects(lstat(stalePath), /ENOENT/);
  await releaseCaseWorkerLease(caseWorkspaceRoot, acquired.lease_id);
});
