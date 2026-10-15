import assert from "node:assert/strict";
import { test } from "node:test";

import { importRaftTrajectoryJsonl } from "../src/historical-case-import.js";
import {
  createKnowledgeSnapshot,
  materializeCaseKnowledgeSnapshot,
} from "../src/knowledge-store.js";

const trajectory = JSON.stringify({
  case_id: "CASE-279",
  title: "显示器黑屏历史案例",
  summary: "设备启动后显示器无画面。",
  timeline: [
    { sequence: 1, phase: "SYMPTOM", text: "显示器无画面" },
    { sequence: 2, phase: "FINDING", text: "供电正常" },
    { sequence: 3, phase: "RESOLUTION", text: "重启显示服务后恢复" },
  ],
  root_cause: "显示服务未启动",
  resolution: "重启显示服务",
  tags: ["display", "black-screen"],
  related_case_ids: [],
  source: {
    uri: "https://example.com/cases/279",
    title: "Case 279",
    published_at: "2026-09-20T00:00:00.000Z",
  },
});

test("RAFT trajectory import creates attributable historical Case knowledge", () => {
  const documents = importRaftTrajectoryJsonl(trajectory, {
    version: "1",
    retrievedAt: "2026-09-21T00:00:00.000Z",
    approvedBy: "evaluation owner",
    approvedAt: "2026-09-21T00:00:00.000Z",
    approvalStatus: "EVAL_APPROVED",
    approvalAuthority: "EVALUATION_DATA_OWNER",
    applicability: {
      configuration_ids: ["CONFIG"],
      software_versions: ["1.0"],
      regions: ["CN"],
    },
  });

  assert.equal(documents.length, 1);
  assert.equal(documents[0]?.kind, "HISTORICAL_CASE");
  assert.equal(documents[0]?.case_content?.issue_id, "CASE-279");
  assert.match(documents[0]?.text ?? "", /## Timeline/);
  assert.match(documents[0]?.text ?? "", /显示服务未启动/);
  assert.equal(documents[0]?.source.source_content_hash.length, 64);

  const snapshot = createKnowledgeSnapshot({
    snapshot_id: "RAFT_IMPORT_TEST",
    mode: "EVALUATION",
    created_at: "2026-09-24T00:00:00.000Z",
    cutoff_at: "2026-09-24T00:00:00.000Z",
    evaluation_cases: [
      {
        evaluation_case_id: "TARGET",
        target_issue_id: "CASE-279",
        issue_created_at: "2026-09-24T00:00:00.000Z",
      },
    ],
    product_context: {
      product_family: "PRODUCT",
      configuration_id: "CONFIG",
      hardware_version: "HW",
      software_version: "1.0",
      region: "CN",
    },
    documents,
    action_cards: [],
    prohibited_actions: [],
    knowledge_conflicts: [],
  });

  assert.equal(
    materializeCaseKnowledgeSnapshot(snapshot, "TARGET").documents.length,
    0,
  );
});

test("RAFT trajectory import rejects unordered timeline entries", () => {
  const invalid = trajectory.replace('"sequence":2', '"sequence":1');
  assert.throws(
    () =>
      importRaftTrajectoryJsonl(invalid, {
        version: "1",
        retrievedAt: "2026-09-21T00:00:00.000Z",
        approvedBy: "owner",
        approvedAt: "2026-09-21T00:00:00.000Z",
        approvalStatus: "EVAL_APPROVED",
        approvalAuthority: "EVALUATION_DATA_OWNER",
        applicability: {
          configuration_ids: ["CONFIG"],
          software_versions: ["1.0"],
          regions: ["CN"],
        },
      }),
    /RAFT_TIMELINE_SEQUENCE_INVALID/,
  );
});
