import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createEvaluationManifest,
  parseEvaluationManifest,
  scoreEvaluationResponse,
} from "../src/evaluation-manifest.js";

const manifestInput = () => ({
  benchmark_id: "CAMB-FAULT-TREE-V1",
  created_at: "2026-09-24T00:00:00.000Z",
  source: {
    name: "CAMB faultTree",
    uri: "https://github.com/CamLLM/CamBenchmark/blob/main/faultTree/trouble_tree.jsonl",
    license: "CC0-1.0",
    content_hash: "a".repeat(64),
  },
  approval: {
    status: "EVAL_APPROVED" as const,
    approved_by: "FixAgent evaluation owner",
    approved_at: "2026-09-24T00:00:00.000Z",
    authority: "EVALUATION_DATA_OWNER" as const,
  },
  cases: [
    {
      evaluation_case_id: "CAMB-FAULT-TREE-0001",
      target_issue_id: "CAMB-FAULT-TREE-SOURCE-0001",
      runtime_snapshot: {
        snapshot_id: "CAMB_FAULT_TREE_V1@case",
        content_hash: "b".repeat(64),
      },
      prompt: "右发引气压力低，下一步检查什么？",
      expected: {
        standard_answer: "1. 检查预冷器控制活门\n2. 检查管路是否漏气",
        fault_classifications: ["引气系统"],
        allowed_steps: ["检查预冷器控制活门", "检查管路是否漏气"],
      },
      rubric: {
        type: "ALLOWED_STEP_COVERAGE" as const,
        pass_threshold: 0.5,
      },
    },
  ],
});

test("evaluation manifest is hash-locked and scores allowed-step coverage", () => {
  const manifest = createEvaluationManifest(manifestInput());

  assert.equal(parseEvaluationManifest(manifest).content_hash, manifest.content_hash);
  assert.throws(
    () => parseEvaluationManifest({ ...manifest, benchmark_id: "tampered" }),
    /EVALUATION_MANIFEST_HASH_MISMATCH/,
  );

  const result = scoreEvaluationResponse({
    manifest,
    evaluationCaseId: "CAMB-FAULT-TREE-0001",
    responseText: "可能属于引气系统问题，请先检查预冷器控制活门，并记录结果。",
  });
  assert.deepEqual(result.matched_step_indexes, [0]);
  assert.deepEqual(result.missed_step_indexes, [1]);
  assert.equal(result.coverage, 0.5);
  assert.equal(result.passed, true);

  const negated = scoreEvaluationResponse({
    manifest,
    evaluationCaseId: "CAMB-FAULT-TREE-0001",
    responseText: "不要检查预冷器控制活门，这样做不安全。",
  });
  assert.deepEqual(negated.matched_step_indexes, []);
  assert.equal(negated.passed, false);
});

test("evaluation manifest rejects duplicate Case identifiers", () => {
  const input = manifestInput();
  input.cases.push({ ...input.cases[0]! });
  assert.throws(
    () => createEvaluationManifest(input),
    /EVALUATION_MANIFEST_DUPLICATE_CASE/,
  );
});

test("evaluation manifest rejects classifications that normalize to no text", () => {
  const input = manifestInput();
  input.cases[0]!.expected.fault_classifications = ["---"];
  assert.throws(
    () => createEvaluationManifest(input),
    /Fault classifications must contain text/,
  );
});
