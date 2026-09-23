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
} from "../src/app.js";
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
        body: JSON.stringify({ message: "屏幕异常" }),
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
        body: JSON.stringify({ message: "屏幕异常" }),
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
          message: "屏幕异常",
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
        body: JSON.stringify({ message: "屏幕异常" }),
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
  const app = createFixAgentServer({ runtime, workspaceRoot });
  await app.listen();

  try {
    const page = await fetch(app.url);
    const html = await page.text();

    assert.equal(page.status, 200);
    assert.match(html, /NON-SCORED · DATA_NO_GO/);
    assert.match(html, /<form[^>]+id="case-form"/);
  } finally {
    await app.close();
  }
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
        body: JSON.stringify({ message: "屏幕异常" }),
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
