import assert from "node:assert/strict";
import { test } from "node:test";

import { convertCambFaultTreeJsonl } from "../src/camb-converter.js";
import { parseEvaluationManifest } from "../src/evaluation-manifest.js";
import { parseKnowledgeSnapshot } from "../src/knowledge-store.js";

const source = [
  JSON.stringify({
    prompt: "历史路径一",
    gold_list: ["检查控制活门", "检查管路"],
  }),
  JSON.stringify({
    prompt: "历史路径二",
    gold_list: ["测量供电电压"],
  }),
].join("\n");

test("CAMB conversion separates Agent-visible catalog from evaluation answers", () => {
  const converted = convertCambFaultTreeJsonl(source, {
    snapshotId: "CAMB_FAULT_TREE_V1",
    benchmarkId: "CAMB-FAULT-TREE-V1",
    importedAt: "2026-09-24T00:00:00.000Z",
    approvedBy: "FixAgent evaluation owner",
    sourceUri:
      "https://github.com/CamLLM/CamBenchmark/blob/main/faultTree/trouble_tree.jsonl",
    productContext: {
      product_family: "CAMB_CIVIL_AVIATION",
      configuration_id: "BENCHMARK",
      hardware_version: "UNSPECIFIED",
      software_version: "UNSPECIFIED",
      region: "CN",
    },
  });

  const snapshot = parseKnowledgeSnapshot(converted.knowledgeSnapshot);
  const manifest = parseEvaluationManifest(converted.evaluationManifest);

  assert.equal(snapshot.evaluation_cases.length, 2);
  assert.equal(snapshot.documents.length, 0);
  assert.equal(manifest.cases.length, 2);
  assert.deepEqual(manifest.cases[0]?.expected.allowed_steps, [
    "检查控制活门",
    "检查管路",
  ]);
  assert.equal(
    manifest.cases[0]?.expected.standard_answer,
    "1. 检查控制活门\n2. 检查管路",
  );
  assert.deepEqual(manifest.cases[0]?.expected.fault_classifications, []);
  assert.equal(manifest.cases[0]?.prompt, "历史路径一");
  assert.match(
    manifest.cases[0]?.runtime_snapshot.snapshot_id ?? "",
    /^CAMB_FAULT_TREE_V1@[a-f0-9]{12}$/,
  );
  assert.match(
    manifest.cases[0]?.runtime_snapshot.content_hash ?? "",
    /^[a-f0-9]{64}$/,
  );

  const agentVisibleSnapshot = JSON.stringify(snapshot);
  assert.equal(agentVisibleSnapshot.includes("历史路径一"), false);
  assert.equal(agentVisibleSnapshot.includes("检查控制活门"), false);
});

test("CAMB conversion rejects malformed and duplicate records", () => {
  assert.throws(
    () =>
      convertCambFaultTreeJsonl('{"prompt":"","gold_list":[]}', {
        snapshotId: "S",
        benchmarkId: "B",
        importedAt: "2026-09-24T00:00:00.000Z",
        approvedBy: "owner",
        sourceUri: "https://example.com/camb.jsonl",
        productContext: {
          product_family: "P",
          configuration_id: "C",
          hardware_version: "H",
          software_version: "S",
          region: "R",
        },
      }),
    /CAMB_RECORD_INVALID/,
  );
});
