import assert from "node:assert/strict";
import { test } from "node:test";

import { createEvaluationManifest } from "../src/evaluation-manifest.js";
import { runEvaluation } from "../src/evaluation-runner.js";

test("evaluation runner sends only prompts to Cases and scores published responses", async () => {
  const manifest = createEvaluationManifest({
    benchmark_id: "BENCHMARK",
    created_at: "2026-09-24T00:00:00.000Z",
    source: {
      name: "fixture",
      uri: "https://example.com/fixture",
      license: "CC0-1.0",
      content_hash: "a".repeat(64),
    },
    approval: {
      status: "EVAL_APPROVED",
      approved_by: "owner",
      approved_at: "2026-09-24T00:00:00.000Z",
      authority: "EVALUATION_DATA_OWNER",
    },
    cases: [
      {
        evaluation_case_id: "EVAL-1",
        target_issue_id: "ISSUE-1",
        runtime_snapshot: {
          snapshot_id: "SNAPSHOT-1",
          content_hash: "b".repeat(64),
        },
        prompt: "显示器没有画面",
        expected: {
          standard_answer: "检查供电",
          fault_classifications: ["供电故障"],
          allowed_steps: ["检查供电"],
        },
        rubric: { type: "ALLOWED_STEP_COVERAGE", pass_threshold: 1 },
      },
    ],
  });
  const requests: Array<{ path: string; body: unknown }> = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ path: url.pathname, body });
    if (url.pathname === "/api/cases") {
      return Response.json(
        {
          case_id: "case-1",
          knowledge_snapshot_id: "SNAPSHOT-1",
          knowledge_snapshot_hash: "b".repeat(64),
        },
        { status: 201 },
      );
    }
    return Response.json({
      case_id: "case-1",
      data_status: "DATA_NO_GO",
      response: {
        message_markdown: "可能是供电故障，请先检查供电。",
        response_type: "EVIDENCE_REQUEST",
        claim_refs: [],
        action_card_refs: [],
      },
    });
  };

  const report = await runEvaluation({
    baseUrl: "http://127.0.0.1:4174",
    manifest,
    providerProfileId: "qwen",
    fetchImpl,
  });

  assert.equal(report.total_cases, 1);
  assert.equal(report.passed_cases, 1);
  assert.equal(report.pass_rate, 1);
  assert.equal(report.results[0]?.score.coverage, 1);
  assert.deepEqual(requests[0],
    {
      path: "/api/cases",
      body: {
        evaluation_case_id: "EVAL-1",
        provider_profile_id: "qwen",
      },
    });
  assert.equal(requests[1]?.path, "/api/cases/case-1/messages");
  assert.equal(
    (requests[1]?.body as { message?: string }).message,
    "显示器没有画面",
  );
  assert.match(
    (requests[1]?.body as { idempotency_key?: string }).idempotency_key ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(JSON.stringify(requests).includes("检查供电"), false);
});

test("evaluation runner can select a bounded subset", async () => {
  const manifest = createEvaluationManifest({
    benchmark_id: "BENCHMARK",
    created_at: "2026-09-24T00:00:00.000Z",
    source: {
      name: "fixture",
      uri: "https://example.com/fixture",
      license: "CC0-1.0",
      content_hash: "a".repeat(64),
    },
    approval: {
      status: "EVAL_APPROVED",
      approved_by: "owner",
      approved_at: "2026-09-24T00:00:00.000Z",
      authority: "EVALUATION_DATA_OWNER",
    },
    cases: [
      {
        evaluation_case_id: "EVAL-1",
        target_issue_id: "ISSUE-1",
        runtime_snapshot: {
          snapshot_id: "SNAPSHOT-1",
          content_hash: "b".repeat(64),
        },
        prompt: "one",
        expected: {
          standard_answer: "one",
          fault_classifications: [],
          allowed_steps: ["one"],
        },
        rubric: { type: "ALLOWED_STEP_COVERAGE", pass_threshold: 1 },
      },
      {
        evaluation_case_id: "EVAL-2",
        target_issue_id: "ISSUE-2",
        runtime_snapshot: {
          snapshot_id: "SNAPSHOT-2",
          content_hash: "c".repeat(64),
        },
        prompt: "two",
        expected: {
          standard_answer: "two",
          fault_classifications: [],
          allowed_steps: ["two"],
        },
        rubric: { type: "ALLOWED_STEP_COVERAGE", pass_threshold: 1 },
      },
    ],
  });
  let created = 0;
  const report = await runEvaluation({
    baseUrl: "http://127.0.0.1:4174",
    manifest,
    evaluationCaseIds: ["EVAL-2"],
    async fetchImpl(input) {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (url.pathname === "/api/cases") {
        created += 1;
        return Response.json(
          {
            case_id: `case-${created}`,
            knowledge_snapshot_id: "SNAPSHOT-2",
            knowledge_snapshot_hash: "c".repeat(64),
          },
          { status: 201 },
        );
      }
      return Response.json({
        response: { message_markdown: "two" },
      });
    },
  });
  assert.deepEqual(
    report.results.map((result) => result.evaluation_case_id),
    ["EVAL-2"],
  );
});
