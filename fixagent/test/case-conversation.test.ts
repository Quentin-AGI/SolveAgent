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

const temporaryDirectories: string[] = [];

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
      assert.equal((await stat(request.cwd)).mode & 0o777, 0o555);
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
