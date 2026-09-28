import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  createFixAgentServer,
  pruneExpiredTraces,
  type AgentRunRequest,
  type AgentRuntime,
  type ProviderRuntimeProfile,
} from "../src/app.js";
import { issueAfterSalesEvidenceRef } from "../src/after-sales.js";
import { commitCaseEvent, readCaseState } from "../src/case-store.js";
import { FixAgentDomainError } from "../src/domain-error.js";
import { createProviderRegistryEditor } from "../src/provider-registry.js";
import {
  createKnowledgeSnapshot,
  VEHICLE_SAFELY_PARKED_EVIDENCE_REF,
  type KnowledgeSnapshotInput,
} from "../src/knowledge-store.js";
import { buildFrozenProviderProfile } from "../src/provider-profile.js";

const temporaryDirectories: string[] = [];

const testProviderProfile = (
  providerId: string,
  modelId: string,
  claudeCodeVersion: string,
) =>
  buildFrozenProviderProfile({
    FIXAGENT_PROVIDER_ID: providerId,
    ANTHROPIC_BASE_URL: `https://${providerId}.example.test`,
    ANTHROPIC_AUTH_TOKEN: "test-secret",
    FIXAGENT_MODEL: modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: `${modelId}-opus`,
    ANTHROPIC_DEFAULT_SONNET_MODEL: `${modelId}-sonnet`,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: `${modelId}-haiku`,
    ANTHROPIC_DEFAULT_FABLE_MODEL: `${modelId}-fable`,
    FIXAGENT_PROVIDER_CAPABILITIES: "tools,vision",
    FIXAGENT_EXPECTED_CLAUDE_CODE_VERSION: claudeCodeVersion,
    FIXAGENT_EXPECTED_OBSERVED_MODEL_ID: modelId,
  });

const testRuntimeProfile = (
  id: string,
  displayName: string,
  providerId: string,
  modelId: string,
): ProviderRuntimeProfile => ({
  id,
  display_name: displayName,
  provider_label: providerId,
  profile: testProviderProfile(providerId, modelId, "test-version"),
  environment: {
    FIXAGENT_PROVIDER_ID: providerId,
    ANTHROPIC_BASE_URL: `https://${providerId}.example.test`,
    ANTHROPIC_AUTH_TOKEN: `${id}-secret`,
    FIXAGENT_MODEL: modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: `${modelId}-opus`,
    ANTHROPIC_DEFAULT_SONNET_MODEL: `${modelId}-sonnet`,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: `${modelId}-haiku`,
    ANTHROPIC_DEFAULT_FABLE_MODEL: `${modelId}-fable`,
    FIXAGENT_PROVIDER_CAPABILITIES: "tools,vision",
    FIXAGENT_EXPECTED_CLAUDE_CODE_VERSION: "test-version",
    FIXAGENT_EXPECTED_OBSERVED_MODEL_ID: modelId,
  },
});

const testKnowledgeSnapshotInput = (): KnowledgeSnapshotInput => {
  const applicability = {
    configuration_ids: ["RPI4_7IN"],
    software_versions: ["20250108"],
    regions: ["GLOBAL"],
  };
  return {
    snapshot_id: "TEST_EVAL_SNAPSHOT",
    mode: "EVALUATION",
    created_at: "2026-09-23T00:00:00.000Z",
    cutoff_at: "2026-09-22T23:59:59.999Z",
    evaluation_cases: [
      {
        evaluation_case_id: "TARGET-EARLY",
        target_issue_id: "issue-100",
        issue_created_at: "2026-09-19T23:59:59.000Z",
      },
      {
        evaluation_case_id: "TARGET-LATE",
        target_issue_id: "issue-200",
        issue_created_at: "2026-09-21T00:00:00.000Z",
      },
    ],
    product_context: {
      product_family: "CRANKSHAFT_RASPBERRY_PI_DISPLAY",
      configuration_id: "RPI4_7IN",
      hardware_version: "RPI4",
      software_version: "20250108",
      region: "GLOBAL",
    },
    documents: [
      {
        knowledge_id: "DOC-DISPLAY-001",
        version: "1",
        kind: "PRODUCT_DOC",
        document_type: "GENERAL",
        title: "Test display procedure",
        text: "Fixture-only approved display procedure.",
        tags: ["display"],
        applicability,
        source: {
          uri: "https://example.test/display",
          title: "Test source",
          retrieved_at: "2026-09-22T12:00:00.000Z",
          published_at: "2026-09-20T12:00:00.000Z",
          source_content_hash: "a".repeat(64),
        },
        approval_status: "EVAL_APPROVED",
        approved_by: "test-data-owner",
        approved_at: "2026-09-22T18:00:00.000Z",
        approval_authority: "EVALUATION_DATA_OWNER",
      },
    ],
    action_cards: [
      {
        action_id: "ACTION-DISPLAY-TEST",
        version: "1",
        title: "Run the approved display test",
        applicability,
        prerequisite_evidence_refs: [VEHICLE_SAFELY_PARKED_EVIDENCE_REF],
        risk_level: "LEVEL_1",
        steps: ["Run the fixture-only test."],
        verification: ["Check the original symptom."],
        rollback: ["Stop the fixture-only test."],
        source_ref: { knowledge_id: "DOC-DISPLAY-001", version: "1" },
        approval_status: "EVAL_APPROVED",
        approved_by: "test-data-owner",
        approved_at: "2026-09-22T18:00:00.000Z",
        approval_authority: "EVALUATION_DATA_OWNER",
      },
    ],
    prohibited_actions: [],
    knowledge_conflicts: [],
  };
};

const testKnowledgeSnapshot = () =>
  createKnowledgeSnapshot(testKnowledgeSnapshotInput());

const testConflictedKnowledgeSnapshot = () => {
  const input = testKnowledgeSnapshotInput();
  const firstDocument = input.documents[0];
  assert.ok(firstDocument);
  const conflictingDocument = structuredClone(firstDocument);
  conflictingDocument.knowledge_id = "DOC-DISPLAY-002";
  conflictingDocument.title = "Conflicting test display procedure";
  conflictingDocument.text = "A conflicting fixture-only display procedure.";
  conflictingDocument.source = {
    ...conflictingDocument.source,
    uri: "https://example.test/display-conflict",
    title: "Conflicting test source",
  };
  input.documents.push(conflictingDocument);
  input.knowledge_conflicts.push({
    conflict_id: "CONFLICT-DISPLAY-CONFIG",
    description: "The approved display procedures cannot both apply.",
    source_refs: [
      { knowledge_id: "DOC-DISPLAY-001", version: "1" },
      { knowledge_id: "DOC-DISPLAY-002", version: "1" },
    ],
    applicability: firstDocument.applicability,
    blocked_action_ids: ["ACTION-DISPLAY-TEST"],
    resolutions: [],
    approval_status: "EVAL_APPROVED",
    approved_by: "test-data-owner",
    approved_at: "2026-09-22T18:00:00.000Z",
    approval_authority: "EVALUATION_DATA_OWNER",
  });
  return createKnowledgeSnapshot(input);
};

const makeDirectoriesRemovable = async (directory: string): Promise<void> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const child = join(directory, entry.name);
        await makeDirectoriesRemovable(child);
        await chmod(child, 0o700);
      }),
  );
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await makeDirectoriesRemovable(directory);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

test("Case creation replays the same Case after an empty-response retry", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-create-retry-test-"));
  temporaryDirectories.push(workspaceRoot);

  const app = createFixAgentServer({
    runtime: { async run() {} },
    workspaceRoot,
  });
  await app.listen();

  try {
    const idempotencyKey = "018f3d92-7601-4d74-8bb7-2aee6fef6281";
    const request = () =>
      fetch(new URL("/api/cases", app.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotency_key: idempotencyKey }),
      });

    const first = await request();
    const repeated = await request();
    assert.equal(first.status, 201);
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), await first.json());
    assert.deepEqual(await readdir(workspaceRoot), [idempotencyKey]);
  } finally {
    await app.close();
  }
});

test("user creates a Case and receives only the Agent-published response", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);

  const runtime: AgentRuntime = {
    async run(request: AgentRunRequest) {
      await request.publish({
        message_markdown: "请补拍屏幕右侧边缘，并让接口区域同时入镜。",
        claim_refs: [],
        action_card_refs: [],
        response_type: "EVIDENCE_REQUEST",
      });
    },
  };

  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };

    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "屏幕右边有一条黑边" }),
      },
    );

    assert.equal(replied.status, 200);
    assert.deepEqual(await replied.json(), {
      case_id: caseId,
      data_status: "DATA_NO_GO",
      response: {
        message_markdown: "请补拍屏幕右侧边缘，并让接口区域同时入镜。",
        claim_refs: [],
        action_card_refs: [],
        response_type: "EVIDENCE_REQUEST",
      },
    });
  } finally {
    await app.close();
  }
});

test("host publishes deterministic after-sales facts only with issued Case evidence", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  const evidenceRef = "order:0123456789abcdef";
  const runtime: AgentRuntime = {
    async run(request) {
      await issueAfterSalesEvidenceRef({
        caseId: request.caseId,
        caseWorkspaceRoot: request.cwd,
        evidenceRef,
        evidenceType: "ORDER",
        createdAt: "2026-09-24T00:00:00.000Z",
      });
      await request.publish({
        message_markdown: "该脱敏订单当前处于质保期内。",
        claim_refs: [],
        evidence_refs: [evidenceRef],
        action_card_refs: [],
        response_type: "INFORMATION",
      });
    },
  };
  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "帮我查一下质保" }),
      },
    );

    assert.equal(replied.status, 200);
    const body = (await replied.json()) as {
      response?: { evidence_refs?: string[] };
    };
    assert.deepEqual(body.response?.evidence_refs, [evidenceRef]);
  } finally {
    await app.close();
  }
});

test("user can send a file-only message from the isolated Case workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  let runtimeMessage: string | undefined;
  const app = createFixAgentServer({
    workspaceRoot,
    runtime: {
      async run(request) {
        runtimeMessage = request.userMessage;
        await request.publish({
          message_markdown: "我已收到附件，请补充你希望确认的问题。",
          claim_refs: [],
          action_card_refs: [],
          response_type: "EVIDENCE_REQUEST",
        });
      },
    },
  });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "",
          idempotency_key: "00000000-0000-4000-8000-000000000123",
          attachments: [
            {
              name: "display.log",
              media_type: "text/plain",
              data_base64: Buffer.from("display connection lost\n").toString(
                "base64",
              ),
            },
          ],
        }),
      },
    );
    assert.equal(replied.status, 200);
    assert.match(runtimeMessage ?? "", /display\.log/);
    assert.match(runtimeMessage ?? "", /scratch\/attachments\//);

    const attachmentDirectory = join(
      workspaceRoot,
      caseId,
      "scratch",
      "attachments",
    );
    const attachmentFiles = await readdir(attachmentDirectory);
    assert.equal(attachmentFiles.length, 1);
    const attachmentFile = join(attachmentDirectory, attachmentFiles[0]!);
    assert.equal(await readFile(attachmentFile, "utf8"), "display connection lost\n");
    assert.equal((await stat(attachmentFile)).mode & 0o777, 0o600);
  } finally {
    await app.close();
  }
});

test("a repeated message idempotency key replays the first response without rerunning the Agent", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  let agentRuns = 0;
  const runtime: AgentRuntime = {
    async run(request) {
      agentRuns += 1;
      await request.publish({
        message_markdown: `首次回答 ${agentRuns}`,
        claim_refs: [],
        action_card_refs: [],
        response_type: "EVIDENCE_REQUEST",
      });
    },
  };
  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const idempotencyKey = "00000000-0000-4000-8000-000000000777";
    const send = () =>
      fetch(new URL(`/api/cases/${caseId}/messages`, app.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "屏幕右边有一条黑边",
          idempotency_key: idempotencyKey,
        }),
      });

    const first = await send();
    const firstBody = await first.json();
    const repeated = await send();
    const repeatedBody = await repeated.json();
    assert.equal(first.status, 200);
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeatedBody, firstBody);
    assert.equal(agentRuns, 1);

    const conflict = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "这是不同的消息",
          idempotency_key: idempotencyKey,
        }),
      },
    );
    assert.equal(conflict.status, 409);
  } finally {
    await app.close();
  }
});

test("a transient Runtime failure is persisted and retried once", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  let agentRuns = 0;
  const runtime: AgentRuntime = {
    async run(request) {
      agentRuns += 1;
      if (agentRuns === 1) throw new Error("PROVIDER_TEMPORARY_FAILURE");
      await request.publish({
        message_markdown: "请补充当前屏幕照片。",
        claim_refs: [],
        action_card_refs: [],
        response_type: "EVIDENCE_REQUEST",
      });
    },
  };
  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "扫地机器人无法回到基站" }),
      },
    );

    assert.equal(replied.status, 200);
    assert.equal(agentRuns, 2);
    assert.match(
      await readFile(join(workspaceRoot, caseId, "events.jsonl"), "utf8"),
      /"event_type":"SYSTEM_ERROR"/,
    );
  } finally {
    await app.close();
  }
});

test("a provider authentication failure returns immediately without rerunning the Agent", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  let agentRuns = 0;
  const runtime: AgentRuntime = {
    async run() {
      agentRuns += 1;
      throw new FixAgentDomainError("PROVIDER_AUTHENTICATION_FAILED");
    },
  };
  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "分析图片" }),
      },
    );

    assert.equal(replied.status, 401);
    assert.deepEqual(await replied.json(), {
      error: "PROVIDER_AUTHENTICATION_FAILED",
    });
    assert.equal(agentRuns, 1);
  } finally {
    await app.close();
  }
});

test("analysis progress exposes safe stages without leaking trace payloads", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  const runtime: AgentRuntime = {
    async run(request) {
      await request.trace({
        type: "system",
        subtype: "init",
        model: "qwen3.8-flash",
        secret: "must-not-leak",
      });
      await request.trace({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/private/attachment.png" },
            },
          ],
        },
      });
      await request.trace({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: [
                {
                  type: "image",
                  source: { type: "base64", data: "image-secret" },
                },
              ],
            },
          ],
        },
      });
      await request.publish({
        message_markdown: "图片分析完成。",
        claim_refs: [],
        action_card_refs: [],
        response_type: "EVIDENCE_REQUEST",
      });
    },
  };
  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const turnId = "00000000-0000-4000-8000-000000000778";
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "分析图片",
          idempotency_key: turnId,
        }),
      },
    );
    assert.equal(replied.status, 200);

    const progress = await fetch(
      new URL(`/api/cases/${caseId}/progress?turn_id=${turnId}`, app.url),
    );
    assert.equal(progress.status, 200);
    const body = (await progress.json()) as {
      events: Array<{ stage: string; label: string }>;
    };
    assert.deepEqual(
      body.events.map((event) => event.stage),
      [
        "request_received",
        "agent_start",
        "model_connected",
        "attachment_read",
        "vision_input",
        "turn_completed",
      ],
    );
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("must-not-leak"), false);
    assert.equal(serialized.includes("/private/attachment.png"), false);
    assert.equal(serialized.includes("image-secret"), false);
  } finally {
    await app.close();
  }
});

test("a retry forks from the pre-turn Session instead of duplicating the user message", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  const baseSession = "00000000-0000-4000-8000-000000000801";
  const failedFork = "00000000-0000-4000-8000-000000000802";
  const successfulFork = "00000000-0000-4000-8000-000000000803";
  const resumedFrom: Array<string | undefined> = [];
  let runs = 0;
  const runtime: AgentRuntime = {
    async run(request) {
      runs += 1;
      resumedFrom.push(request.sessionId);
      if (runs === 1) {
        await request.saveSession(baseSession);
        await request.publish({
          message_markdown: "首轮回答。",
          claim_refs: [],
          action_card_refs: [],
          response_type: "EVIDENCE_REQUEST",
        });
        return;
      }
      if (runs === 2) {
        await request.saveSession(failedFork);
        throw new Error("PROVIDER_TEMPORARY_FAILURE");
      }
      await request.saveSession(successfulFork);
      await request.publish({
        message_markdown: "恢复后的回答。",
        claim_refs: [],
        action_card_refs: [],
        response_type: "EVIDENCE_REQUEST",
      });
    },
  };
  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const send = (message: string) =>
      fetch(new URL(`/api/cases/${caseId}/messages`, app.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });

    assert.equal((await send("第一轮")).status, 200);
    assert.equal((await send("第二轮")).status, 200);
    assert.deepEqual(resumedFrom, [undefined, baseSession, baseSession]);
    const state = JSON.parse(
      await readFile(join(workspaceRoot, caseId, "state.json"), "utf8"),
    ) as { claude_session_id: string };
    assert.equal(state.claude_session_id, successfulFork);
  } finally {
    await app.close();
  }
});

test("a response committed before a Runtime crash is returned without a second Agent run", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  let agentRuns = 0;
  const runtime: AgentRuntime = {
    async run(request) {
      agentRuns += 1;
      await request.publish({
        message_markdown: "这是崩溃前已提交的回答。",
        claim_refs: [],
        action_card_refs: [],
        response_type: "EVIDENCE_REQUEST",
      });
      throw new Error("CASE_WORKER_EXITED: simulated crash");
    },
  };
  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "扫地机器人无法回到基站" }),
      },
    );
    const result = (await replied.json()) as {
      response: { message_markdown: string };
    };

    assert.equal(replied.status, 200);
    assert.equal(result.response.message_markdown, "这是崩溃前已提交的回答。");
    assert.equal(agentRuns, 1);
  } finally {
    await app.close();
  }
});

test("a terminal Runtime error is replayed and never consumes another recovery", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  let agentRuns = 0;
  const runtime: AgentRuntime = {
    async run() {
      agentRuns += 1;
      throw new Error("PROVIDER_UNAVAILABLE");
    },
  };
  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const idempotencyKey = "00000000-0000-4000-8000-000000000778";
    const send = () =>
      fetch(new URL(`/api/cases/${caseId}/messages`, app.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "扫地机器人无法回到基站",
          idempotency_key: idempotencyKey,
        }),
      });

    const first = await send();
    const firstBody = await first.json();
    const repeated = await send();
    assert.equal(first.status, 500);
    assert.equal(repeated.status, 500);
    assert.deepEqual(await repeated.json(), firstBody);
    assert.equal(agentRuns, 2);
  } finally {
    await app.close();
  }
});

test("user never receives an Agent result that was not published", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);

  const runtime: AgentRuntime = {
    async run() {
      // The external Agent loop completed without calling publish_case_response.
    },
  };

  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };

    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "屏幕右边有一条黑边" }),
      },
    );

    assert.equal(replied.status, 502);
    assert.deepEqual(await replied.json(), {
      error: "AGENT_RESPONSE_NOT_PUBLISHED",
    });
  } finally {
    await app.close();
  }
});

test("user never receives an unvalidated diagnostic or device action", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);

  const runtime: AgentRuntime = {
    async run(request) {
      await request.publish({
        message_markdown: "请拆开外壳并重新插接排线。",
        claim_refs: ["invented-claim"],
        action_card_refs: ["invented-action"],
        response_type: "ACTION",
      });
    },
  };

  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "扫地机器人无法回到基站" }),
      },
    );

    assert.equal(replied.status, 502);
    assert.deepEqual(await replied.json(), {
      error: "AGENT_RESPONSE_REJECTED",
    });
  } finally {
    await app.close();
  }
});

test("host publishes an action only when its frozen Knowledge and Action Card references are exact", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  const knowledgeSnapshot = testKnowledgeSnapshot();
  const runtime: AgentRuntime = {
    async run(request) {
      await request.publish({
        message_markdown: "请执行已批准的显示测试，然后确认原始症状。",
        claim_refs: [{ knowledge_id: "DOC-DISPLAY-001", version: "1" }],
        action_card_refs: [
          { action_id: "ACTION-DISPLAY-TEST", version: "1" },
        ],
        response_type: "ACTION",
      });
    },
  };
  const app = createFixAgentServer({
    runtime,
    workspaceRoot,
    knowledgeSnapshot,
  });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evaluation_case_id: "TARGET-LATE" }),
    });
    const {
      case_id: caseId,
      knowledge_snapshot_id: caseKnowledgeSnapshotId,
      knowledge_snapshot_hash: caseKnowledgeSnapshotHash,
    } = (await created.json()) as {
      case_id: string;
      knowledge_snapshot_id: string;
      knowledge_snapshot_hash: string;
    };
    const caseWorkspaceRoot = join(workspaceRoot, caseId);
    const initial = await readCaseState(caseWorkspaceRoot);
    await commitCaseEvent({
      caseId,
      caseWorkspaceRoot,
      expectedRevision: initial.state_revision,
      idempotencyKey: "test:vehicle-safely-parked",
      eventType: "CASE_EVIDENCE_RECORDED",
      patch: {
        evidence_refs: [VEHICLE_SAFELY_PARKED_EVIDENCE_REF],
      },
    });
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "请给我下一步测试" }),
      },
    );
    const body = (await replied.json()) as {
      response: { response_type: string; action_card_refs: unknown[] };
    };

    assert.equal(replied.status, 200);
    assert.equal(body.response.response_type, "ACTION");
    assert.deepEqual(body.response.action_card_refs, [
      { action_id: "ACTION-DISPLAY-TEST", version: "1" },
    ]);
    const state = JSON.parse(
      await readFile(join(workspaceRoot, caseId, "state.json"), "utf8"),
    ) as {
      knowledge_snapshot_id: string;
      knowledge_snapshot_hash: string;
    };
    const frozenSnapshot = JSON.parse(
      await readFile(
        join(workspaceRoot, caseId, ".fixagent", "knowledge-snapshot.json"),
        "utf8",
      ),
    ) as { content_hash: string };
    assert.equal(state.knowledge_snapshot_id, caseKnowledgeSnapshotId);
    assert.equal(state.knowledge_snapshot_hash, caseKnowledgeSnapshotHash);
    assert.notEqual(state.knowledge_snapshot_id, knowledgeSnapshot.snapshot_id);
    assert.equal(state.knowledge_snapshot_hash, frozenSnapshot.content_hash);
  } finally {
    await app.close();
  }
});

test("host records an acknowledged unresolved Knowledge conflict", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  const runtime: AgentRuntime = {
    async run(request) {
      await request.publish({
        message_markdown:
          "两份已批准资料相互冲突，因此当前显示配置仍不确定。",
        claim_refs: [
          { knowledge_id: "DOC-DISPLAY-001", version: "1" },
          { knowledge_id: "DOC-DISPLAY-002", version: "1" },
        ],
        action_card_refs: [],
        knowledge_conflict_refs: ["CONFLICT-DISPLAY-CONFIG"],
        response_type: "INFORMATION",
      });
    },
  };
  const app = createFixAgentServer({
    runtime,
    workspaceRoot,
    knowledgeSnapshot: testConflictedKnowledgeSnapshot(),
  });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evaluation_case_id: "TARGET-LATE" }),
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "哪份显示配置适用于我？" }),
      },
    );

    assert.equal(replied.status, 200);
    assert.deepEqual(
      (await readCaseState(join(workspaceRoot, caseId))).knowledge_conflict_ids,
      ["CONFLICT-DISPLAY-CONFIG"],
    );
  } finally {
    await app.close();
  }
});

test("evaluation Cases derive their immutable cutoff from the approved Case catalog", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  const app = createFixAgentServer({
    runtime: { async run() {} },
    workspaceRoot,
    knowledgeSnapshot: testKnowledgeSnapshot(),
  });
  await app.listen();

  try {
    const missingCase = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    assert.equal(missingCase.status, 400);
    assert.deepEqual(await missingCase.json(), {
      error: "EVALUATION_CASE_REQUIRED",
    });

    const callerControlledCutoff = await fetch(
      new URL("/api/cases", app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          evaluation_case_id: "TARGET-LATE",
          cutoff_at: "2026-09-22T00:00:00.000Z",
        }),
      },
    );
    assert.equal(callerControlledCutoff.status, 400);

    const unknownCase = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evaluation_case_id: "TARGET-UNKNOWN" }),
    });
    assert.equal(unknownCase.status, 400);
    assert.deepEqual(await unknownCase.json(), {
      error: "EVALUATION_CASE_NOT_FOUND",
    });

    const createCase = async (evaluationCaseId: string) => {
      const response = await fetch(new URL("/api/cases", app.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ evaluation_case_id: evaluationCaseId }),
      });
      assert.equal(response.status, 201);
      return (await response.json()) as {
        case_id: string;
        knowledge_snapshot_id: string;
        cutoff_at: string;
      };
    };
    const early = await createCase("TARGET-EARLY");
    const later = await createCase("TARGET-LATE");
    const readFrozen = async (caseId: string) =>
      JSON.parse(
        await readFile(
          join(workspaceRoot, caseId, ".fixagent", "knowledge-snapshot.json"),
          "utf8",
        ),
      ) as { documents: unknown[]; content_hash: string };
    const earlySnapshot = await readFrozen(early.case_id);
    const laterSnapshot = await readFrozen(later.case_id);

    assert.equal(earlySnapshot.documents.length, 0);
    assert.equal(laterSnapshot.documents.length, 1);
    assert.equal(early.cutoff_at, "2026-09-19T23:59:59.000Z");
    assert.equal(later.cutoff_at, "2026-09-21T00:00:00.000Z");
    assert.notEqual(early.knowledge_snapshot_id, later.knowledge_snapshot_id);
    assert.notEqual(earlySnapshot.content_hash, laterSnapshot.content_hash);
  } finally {
    await app.close();
  }
});

test("approved safety redlines bypass the Agent and create a simulated safety handoff", async () => {
  const redlines = [
    "设备正在冒烟",
    "闻到烧焦气味",
    "外壳有烧灼痕迹",
    "设备持续严重过热",
    "电池已经鼓包",
    "液体进入后通电异常",
  ];

  for (const message of redlines) {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
    temporaryDirectories.push(workspaceRoot);
    let agentRuns = 0;
    const runtime: AgentRuntime = {
      async run() {
        agentRuns += 1;
      },
    };
    const app = createFixAgentServer({ runtime, workspaceRoot });
    await app.listen();

    try {
      const created = await fetch(new URL("/api/cases", app.url), {
        method: "POST",
      });
      const { case_id: caseId } = (await created.json()) as { case_id: string };
      const replied = await fetch(
        new URL(`/api/cases/${caseId}/messages`, app.url),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );
      const body = (await replied.json()) as {
        response: { message_markdown: string; response_type: string };
        handoff: { id: string; status: string };
      };

      assert.equal(replied.status, 200);
      assert.equal(agentRuns, 0);
      assert.equal(
        body.response.message_markdown,
        "请停止操作该设备并等待人工处理。",
      );
      assert.equal(body.response.response_type, "SAFETY_HANDOFF");
      assert.equal(body.handoff.status, "SIMULATED_NOT_CONTACTED");
      const packet = JSON.parse(
        await readFile(
          join(
            workspaceRoot,
            caseId,
            "handoff_outbox",
            `${body.handoff.id}.json`,
          ),
          "utf8",
        ),
      ) as { case_id: string; handoff_type: string; content_hash: string };
      assert.equal(packet.case_id, caseId);
      assert.equal(packet.handoff_type, "SAFETY_HANDOFF");
      assert.match(packet.content_hash, /^[a-f0-9]{64}$/);
      const trace = await readFile(
        join(workspaceRoot, caseId, "trace", "events.jsonl"),
        "utf8",
      );
      assert.match(trace, /"template_id":"UNIVERSAL_SAFETY_FALLBACK_V0"/);
      assert.match(trace, /"template_hash":"[a-f0-9]{64}"/);
      assert.match(trace, /"handoff_persistence":"SIMULATED_NOT_CONTACTED"/);
    } finally {
      await app.close();
    }
  }
});

test("repeating the same safety redline returns the same simulated handoff", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  const runtime: AgentRuntime = { async run() {} };
  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const sendRedline = async () => {
      const response = await fetch(
        new URL(`/api/cases/${caseId}/messages`, app.url),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "设备正在冒烟" }),
        },
      );
      return (await response.json()) as { handoff: { id: string } };
    };

    const first = await sendRedline();
    const second = await sendRedline();
    assert.equal(second.handoff.id, first.handoff.id);
    assert.equal(
      (
        await readdir(join(workspaceRoot, caseId, "handoff_outbox"))
      ).filter((name) => name.endsWith(".json")).length,
      1,
    );
  } finally {
    await app.close();
  }
});

test("safety persistence failure still returns the mandatory stop message", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  let agentRuns = 0;
  let persistenceAttempts = 0;
  const runtime: AgentRuntime = {
    async run() {
      agentRuns += 1;
    },
  };
  const app = createFixAgentServer({
    runtime,
    workspaceRoot,
    async safetyHandoffWriter() {
      persistenceAttempts += 1;
      throw new Error("DISK_UNAVAILABLE");
    },
  });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "设备正在冒烟" }),
      },
    );
    const body = (await replied.json()) as {
      response: { message_markdown: string; response_type: string };
      handoff: { status: string };
    };

    assert.equal(replied.status, 200);
    assert.equal(agentRuns, 0);
    assert.equal(persistenceAttempts, 2);
    assert.equal(
      body.response.message_markdown,
      "请停止操作该设备并等待人工处理。",
    );
    assert.equal(body.response.response_type, "SAFETY_HANDOFF");
    assert.equal(body.handoff.status, "PERSISTENCE_FAILED");
  } finally {
    await app.close();
  }
});

test("explicit safety near-miss negatives remain with the Agent", async () => {
  const negatives = [
    "设备没有冒烟，只是屏幕黑屏",
    "没有烧焦气味，接口松动",
    "设备不严重过热，只是温热",
    "电池没有鼓包，屏幕有条纹",
    "设备没有冒烟或烧焦气味，只有黑屏",
    "没有进水，只是通电异常",
    "No smoke, only a black screen",
    "There is no burning smell",
    "The device is not severely overheating",
  ];

  for (const message of negatives) {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
    temporaryDirectories.push(workspaceRoot);
    let agentRuns = 0;
    const runtime: AgentRuntime = {
      async run(request) {
        agentRuns += 1;
        await request.publish({
          message_markdown: "请补充一张当前设备正面照片。",
          claim_refs: [],
          action_card_refs: [],
          response_type: "EVIDENCE_REQUEST",
        });
      },
    };
    const app = createFixAgentServer({ runtime, workspaceRoot });
    await app.listen();

    try {
      const created = await fetch(new URL("/api/cases", app.url), {
        method: "POST",
      });
      const { case_id: caseId } = (await created.json()) as { case_id: string };
      const replied = await fetch(
        new URL(`/api/cases/${caseId}/messages`, app.url),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );

      assert.equal(replied.status, 200);
      assert.equal(agentRuns, 1);
    } finally {
      await app.close();
    }
  }
});

test("uncertain safety language fails closed before the Agent", async () => {
  const suspectedRedlines = [
    "不知道有没有冒烟",
    "不能确定有没有烧焦味",
    "无法确认电池是否鼓包",
    "Not sure if there is smoke",
  ];

  for (const message of suspectedRedlines) {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
    temporaryDirectories.push(workspaceRoot);
    let agentRuns = 0;
    const app = createFixAgentServer({
      workspaceRoot,
      runtime: {
        async run() {
          agentRuns += 1;
        },
      },
    });
    await app.listen();

    try {
      const created = await fetch(new URL("/api/cases", app.url), {
        method: "POST",
      });
      const { case_id: caseId } = (await created.json()) as { case_id: string };
      const replied = await fetch(
        new URL(`/api/cases/${caseId}/messages`, app.url),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        },
      );
      const body = (await replied.json()) as {
        response: { response_type: string };
      };

      assert.equal(replied.status, 200);
      assert.equal(agentRuns, 0);
      assert.equal(body.response.response_type, "SAFETY_HANDOFF");
    } finally {
      await app.close();
    }
  }
});

test("raw Case traces expire after seven days", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  const app = createFixAgentServer({
    runtime: { async run() {} },
    workspaceRoot,
  });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const traceFile = join(workspaceRoot, caseId, "trace", "events.jsonl");
    const old = new Date("2026-01-01T00:00:00.000Z");
    await utimes(traceFile, old, old);

    await pruneExpiredTraces(
      workspaceRoot,
      new Date("2026-01-08T00:00:00.001Z"),
    );

    await assert.rejects(readFile(traceFile), { code: "ENOENT" });
  } finally {
    await app.close();
  }
});

test("user sees the non-scored Case conversation entry point", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);

  const runtime: AgentRuntime = { async run() {} };
  const app = createFixAgentServer({
    runtime,
    workspaceRoot,
    providerRegistryEditor: createProviderRegistryEditor(
      join(workspaceRoot, "private", "providers.json"),
      { PATH: process.env.PATH },
    ),
  });
  await app.listen();

  try {
    const page = await fetch(app.url);
    const html = await page.text();

    assert.equal(page.status, 200);
    assert.match(html, /NON-SCORED · DATA_NO_GO/);
    assert.match(html, /<form[^>]+id="case-form"/);
    assert.match(html, /id="model-picker-button"/);
    assert.match(html, /id="model-settings-button"/);
    assert.match(html, /id="attachment-input"/);
    assert.match(html, /id="jump-to-latest"/);
    assert.match(html, /video\/mp4/);
    assert.match(html, /重要售后动作需人工确认/);
    const attachmentButton = html.match(
      /<button[^>]+id="attachment-button"[^>]*>/,
    )?.[0];
    assert.ok(attachmentButton);
    assert.doesNotMatch(attachmentButton, /\bdisabled\b/);
    assert.doesNotMatch(html, /id="settings-model-id"/);

    const scrollFollowModule = await fetch(
      new URL("/scroll-follow.js", app.url),
    );
    assert.equal(scrollFollowModule.status, 200);
    assert.match(
      await scrollFollowModule.text(),
      /export function createScrollFollowState/,
    );

    const caseHistoryModule = await fetch(
      new URL("/case-history.js", app.url),
    );
    assert.equal(caseHistoryModule.status, 200);
    assert.match(
      await caseHistoryModule.text(),
      /export function loadCaseHistory/,
    );

    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(created.status, 400);
    assert.deepEqual(await created.json(), {
      error: "PROVIDER_PROFILE_NOT_CONFIGURED",
    });
  } finally {
    await app.close();
  }
});

test("user selects a sanitized model profile that stays frozen to the Case", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  let runtimeEnvironment: NodeJS.ProcessEnv | undefined;
  const providerProfiles = [
    testRuntimeProfile("qwen", "通义千问", "qwen", "qwen-model"),
    testRuntimeProfile("kimi", "Kimi", "kimi", "kimi-model"),
  ];
  const app = createFixAgentServer({
    workspaceRoot,
    providerProfiles,
    defaultProviderProfileId: "kimi",
    runtime: {
      async run(request) {
        runtimeEnvironment = request.providerEnvironment;
        await request.publish({
          message_markdown: "请补充故障画面。",
          claim_refs: [],
          action_card_refs: [],
          response_type: "EVIDENCE_REQUEST",
        });
      },
    },
  });
  await app.listen();

  try {
    const catalogResponse = await fetch(new URL("/api/models", app.url));
    const catalogText = await catalogResponse.text();
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalogText.includes("qwen-secret"), false);
    assert.equal(catalogText.includes("kimi-secret"), false);
    assert.deepEqual(JSON.parse(catalogText), {
      configuration_enabled: false,
      default_model_id: "kimi",
      models: [
        {
          id: "qwen",
          display_name: "通义千问",
          provider_label: "qwen",
          provider_id: "qwen",
          configured: true,
          anthropic_base_url: "https://qwen.example.test",
        },
        {
          id: "kimi",
          display_name: "Kimi",
          provider_label: "kimi",
          provider_id: "kimi",
          configured: true,
          anthropic_base_url: "https://kimi.example.test",
        },
        {
          id: "zhipu",
          display_name: "智谱 GLM",
          provider_label: "智谱开放平台",
          provider_id: "zhipu",
          configured: false,
          anthropic_base_url: null,
        },
        {
          id: "deepseek",
          display_name: "DeepSeek",
          provider_label: "DeepSeek",
          provider_id: "deepseek",
          configured: false,
          anthropic_base_url: null,
        },
      ],
    });

    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_profile_id: "qwen" }),
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const state = await readCaseState(join(workspaceRoot, caseId));
    assert.equal(state.provider_id, "qwen");
    assert.equal(state.model_id, "qwen-model");

    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "屏幕有黑边" }),
      },
    );
    assert.equal(replied.status, 200);
    assert.equal(runtimeEnvironment?.ANTHROPIC_AUTH_TOKEN, "qwen-secret");

    const unknown = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_profile_id: "unknown" }),
    });
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), {
      error: "PROVIDER_PROFILE_NOT_FOUND",
    });
  } finally {
    await app.close();
  }
});

test("model settings persist privately and become selectable without a restart", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  const registryFile = join(workspaceRoot, "private", "providers.json");
  let runtimeEnvironment: NodeJS.ProcessEnv | undefined;
  const app = createFixAgentServer({
    workspaceRoot,
    providerRegistryEditor: createProviderRegistryEditor(registryFile, {
      PATH: process.env.PATH,
    }),
    runtime: {
      async run(request) {
        runtimeEnvironment = request.providerEnvironment;
        await request.publish({
          message_markdown: "请补充故障画面。",
          claim_refs: [],
          action_card_refs: [],
          response_type: "EVIDENCE_REQUEST",
        });
      },
    },
  });
  await app.listen();

  try {
    const crossOrigin = await fetch(new URL("/api/models/qwen", app.url), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://untrusted.example",
      },
      body: JSON.stringify({
        api_url: "https://qwen.example.test/anthropic",
        api_key: "browser-secret",
      }),
    });
    assert.equal(crossOrigin.status, 403);

    for (const apiUrl of [
      "http://qwen.example.test/anthropic",
      "https://user:password@qwen.example.test/anthropic",
      "https://qwen.example.test/anthropic?api_key=secret",
      "https://qwen.example.test/anthropic#secret",
    ]) {
      const insecure = await fetch(new URL("/api/models/qwen", app.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_url: apiUrl, api_key: "browser-secret" }),
      });
      assert.equal(insecure.status, 400);
    }

    const saved = await fetch(new URL("/api/models/qwen", app.url), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_url: "https://qwen.example.test/anthropic",
        api_key: "browser-secret",
      }),
    });
    const savedText = await saved.text();
    assert.equal(saved.status, 200);
    assert.equal(savedText.includes("browser-secret"), false);
    const savedCatalog = JSON.parse(savedText) as {
      default_model_id: string;
      models: Array<{ id: string; configured: boolean }>;
    };
    assert.equal(savedCatalog.default_model_id, "qwen");
    assert.equal(
      savedCatalog.models.find((model) => model.id === "qwen")?.configured,
      true,
    );

    const missingKey = await fetch(new URL("/api/models/qwen", app.url), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_url: "https://qwen.example.test/anthropic-v2",
      }),
    });
    assert.equal(missingKey.status, 400);

    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_profile_id: "qwen" }),
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const state = await readCaseState(join(workspaceRoot, caseId));
    assert.equal(state.model_id, "qwen3.8-flash");

    const updated = await fetch(new URL("/api/models/qwen", app.url), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_url: "https://qwen-v2.example.test/anthropic",
        api_key: "rotated-secret",
      }),
    });
    assert.equal(updated.status, 200);

    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "屏幕有黑边" }),
      },
    );
    assert.equal(replied.status, 200);
    assert.equal(runtimeEnvironment?.ANTHROPIC_AUTH_TOKEN, "rotated-secret");
    assert.equal(
      runtimeEnvironment?.FIXAGENT_PROVIDER_CAPABILITIES,
      "tools,vision",
    );
    assert.equal(
      runtimeEnvironment?.ANTHROPIC_BASE_URL,
      "https://qwen.example.test/anthropic",
    );

    const removed = await fetch(new URL("/api/models/qwen", app.url), {
      method: "DELETE",
    });
    const removedCatalog = (await removed.json()) as {
      models: Array<{ id: string; configured: boolean }>;
    };
    assert.equal(removed.status, 200);
    assert.equal(
      removedCatalog.models.find((model) => model.id === "qwen")?.configured,
      false,
    );
  } finally {
    await app.close();
  }
});

test("server rejects model profiles with an ambiguous frozen runtime identity", () => {
  assert.throws(
    () =>
      createFixAgentServer({
        workspaceRoot: join(tmpdir(), "fixagent-unused-workspace"),
        runtime: { async run() {} },
        providerProfiles: [
          testRuntimeProfile("qwen", "通义千问", "qwen", "qwen-model"),
          testRuntimeProfile(
            "qwen-backup",
            "通义千问备用",
            "qwen",
            "qwen-model",
          ),
        ],
      }),
    /PROVIDER_PROFILE_RUNTIME_IDENTITY_DUPLICATE/,
  );
});

test("Case starts with a read-only project Skill, Scratch workspace, and private Trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);

  const runtime: AgentRuntime = {
    async run(request) {
      const skill = await readFile(
        join(
          request.cwd,
          ".claude",
          "skills",
          "hardware-troubleshooting",
          "SKILL.md",
        ),
        "utf8",
      );
      assert.match(skill, /name: hardware-troubleshooting/);
      assert.equal((await stat(join(request.cwd, "scratch"))).isDirectory(), true);
      assert.equal((await stat(request.cwd)).isDirectory(), true);
      assert.equal(
        (await stat(
          join(
            request.cwd,
            ".claude",
            "skills",
            "hardware-troubleshooting",
            "SKILL.md",
          ),
        )).mode & 0o777,
        0o444,
      );
      const frozenKnowledgeFile = join(
        request.cwd,
        ".fixagent",
        "knowledge-snapshot.json",
      );
      const frozenKnowledge = JSON.parse(
        await readFile(frozenKnowledgeFile, "utf8"),
      ) as { snapshot_id: string; content_hash: string };
      assert.equal(frozenKnowledge.snapshot_id, "EMPTY_EUFY_EVAL_V0");
      assert.match(frozenKnowledge.content_hash, /^[a-f0-9]{64}$/);
      assert.equal((await stat(frozenKnowledgeFile)).mode & 0o777, 0o444);

      await request.trace({ type: "system", subtype: "init", session_id: "s-1" });

      await request.publish({
        message_markdown: "请补充当前屏幕状态。",
        claim_refs: [],
        action_card_refs: [],
        response_type: "EVIDENCE_REQUEST",
      });
    },
  };

  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const created = await fetch(new URL("/api/cases", app.url), {
      method: "POST",
    });
    const { case_id: caseId } = (await created.json()) as { case_id: string };
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, app.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "扫地机器人无法回到基站" }),
      },
    );

    assert.equal(replied.status, 200);
    const trace = await readFile(
      join(workspaceRoot, caseId, "trace", "events.jsonl"),
      "utf8",
    );
    assert.match(trace, /"session_id":"s-1"/);
    assert.equal(
      (await stat(join(workspaceRoot, caseId, "trace", "events.jsonl"))).mode &
        0o777,
      0o600,
    );
  } finally {
    await app.close();
  }
});

test("an existing Case resumes its Claude Session after the HTTP process restarts", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  const runtime: AgentRuntime = {
    async run(request) {
      await request.saveSession("00000000-0000-4000-8000-000000000042");
      await request.publish({
        message_markdown: "请补充当前屏幕照片。",
        claim_refs: [],
        action_card_refs: [],
        response_type: "EVIDENCE_REQUEST",
      });
    },
  };
  const firstServer = createFixAgentServer({ runtime, workspaceRoot });
  await firstServer.listen();
  const created = await fetch(new URL("/api/cases", firstServer.url), {
    method: "POST",
  });
  const { case_id: caseId } = (await created.json()) as { case_id: string };
  const firstReply = await fetch(
    new URL(`/api/cases/${caseId}/messages`, firstServer.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "第一次消息" }),
    },
  );
  assert.equal(firstReply.status, 200);
  await firstServer.close();

  let resumedSessionId: string | undefined;
  const restartedServer = createFixAgentServer({
    workspaceRoot,
    knowledgeSnapshot: testKnowledgeSnapshot(),
    runtime: {
      async run(request) {
        resumedSessionId = request.sessionId;
        await request.publish({
          message_markdown: "已恢复当前 Case。",
          claim_refs: [],
          action_card_refs: [],
          response_type: "EVIDENCE_REQUEST",
        });
      },
    },
  });
  await restartedServer.listen();
  try {
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, restartedServer.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "继续上次 Case" }),
      },
    );

    assert.equal(replied.status, 200);
    assert.equal(
      resumedSessionId,
      "00000000-0000-4000-8000-000000000042",
    );
  } finally {
    await restartedServer.close();
  }
});

test("a returning Case rejects a changed provider profile before the Agent runs", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fixagent-case-test-"));
  temporaryDirectories.push(workspaceRoot);
  const firstServer = createFixAgentServer({
    workspaceRoot,
    runtime: { async run() {} },
    providerProfile: testProviderProfile(
      "qwen",
      "qwen-model-a",
      "test-version-a",
    ),
  });
  await firstServer.listen();
  const created = await fetch(new URL("/api/cases", firstServer.url), {
    method: "POST",
  });
  const { case_id: caseId } = (await created.json()) as { case_id: string };
  await firstServer.close();

  let agentRuns = 0;
  const restartedServer = createFixAgentServer({
    workspaceRoot,
    runtime: {
      async run() {
        agentRuns += 1;
      },
    },
    providerProfile: testProviderProfile(
      "deepseek",
      "deepseek-model-b",
      "test-version-b",
    ),
  });
  await restartedServer.listen();
  try {
    const replied = await fetch(
      new URL(`/api/cases/${caseId}/messages`, restartedServer.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "继续上次 Case" }),
      },
    );

    assert.equal(replied.status, 500);
    assert.deepEqual(await replied.json(), { error: "SYSTEM_ERROR" });
    assert.equal(agentRuns, 0);
    assert.match(
      await readFile(join(workspaceRoot, caseId, "events.jsonl"), "utf8"),
      /FROZEN_PROVIDER_PROFILE_MISMATCH/,
    );
  } finally {
    await restartedServer.close();
  }
});
