import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createKnowledgeSnapshot,
  getActionPolicy,
  parseKnowledgeSnapshot,
  searchKnowledge,
  validatePublishedCaseResponse,
  VEHICLE_SAFELY_PARKED_EVIDENCE_REF,
  type KnowledgeSnapshotInput,
} from "../src/knowledge-store.js";

const sha = "a".repeat(64);
const applicability = {
  configuration_ids: ["RPI4_7IN"],
  software_versions: ["20250108"],
  regions: ["GLOBAL"],
};

const fixtureInput = (): KnowledgeSnapshotInput => ({
  snapshot_id: "CRANKSHAFT_EVAL_2026_09_22",
  mode: "EVALUATION",
  created_at: "2026-09-23T00:00:00.000Z",
  cutoff_at: "2026-09-22T23:59:59.999Z",
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
      title: "Display settings",
      text: "Approved display configuration guidance.",
      tags: ["display", "configuration"],
      applicability,
      source: {
        uri: "https://example.test/docs/display",
        title: "Display documentation",
        retrieved_at: "2026-09-22T12:00:00.000Z",
        source_content_hash: sha,
      },
      approval_status: "EVAL_APPROVED",
    },
    {
      knowledge_id: "CASE-279",
      version: "1",
      kind: "HISTORICAL_CASE",
      title: "Display border case",
      text: "A historical display border report.",
      tags: ["display", "border"],
      applicability,
      source: {
        uri: "https://example.test/cases/279",
        title: "Historical case 279",
        retrieved_at: "2026-09-22T12:00:00.000Z",
        source_content_hash: sha,
      },
      approval_status: "EVAL_APPROVED",
    },
  ],
  action_cards: [
    {
      action_id: "ACTION-DISPLAY-RESTART",
      version: "1",
      title: "Restart the display software",
      applicability,
      prerequisite_evidence_refs: [VEHICLE_SAFELY_PARKED_EVIDENCE_REF],
      risk_level: "LEVEL_1",
      steps: ["Use the approved restart control."],
      verification: ["Confirm the original display symptom."],
      rollback: ["Stop and request expert help if restart fails."],
      source_ref: { knowledge_id: "DOC-DISPLAY-001", version: "1" },
      approval_status: "EVAL_APPROVED",
    },
  ],
  prohibited_actions: [
    {
      policy_id: "NO-VEHICLE-WIRING",
      description: "Do not alter vehicle wiring.",
      applicability,
      source_ref: { knowledge_id: "DOC-DISPLAY-001", version: "1" },
      approval_status: "EVAL_APPROVED",
    },
  ],
});

test("Knowledge Snapshot hashes entries and rejects tampering", () => {
  const snapshot = createKnowledgeSnapshot(fixtureInput());
  assert.match(snapshot.content_hash, /^[a-f0-9]{64}$/);
  assert.match(snapshot.documents[0]?.content_hash ?? "", /^[a-f0-9]{64}$/);

  const tampered = structuredClone(snapshot);
  const document = tampered.documents[0];
  assert.ok(document);
  document.text = "Unapproved replacement text.";
  assert.throws(
    () => parseKnowledgeSnapshot(tampered),
    /KNOWLEDGE_HASH_MISMATCH/,
  );
});

test("Knowledge Snapshot enforces approval mode and source cutoff", () => {
  const wrongApproval = fixtureInput();
  const document = wrongApproval.documents[0];
  assert.ok(document);
  document.approval_status = "PRODUCTION_APPROVED";
  assert.throws(
    () => createKnowledgeSnapshot(wrongApproval),
    /KNOWLEDGE_APPROVAL_MODE_MISMATCH/,
  );

  const afterCutoff = fixtureInput();
  const lateDocument = afterCutoff.documents[0];
  assert.ok(lateDocument);
  lateDocument.source.retrieved_at = "2026-09-23T01:00:00.000Z";
  assert.throws(
    () => createKnowledgeSnapshot(afterCutoff),
    /KNOWLEDGE_SOURCE_AFTER_CUTOFF/,
  );

  const unsafeAction = fixtureInput();
  const action = unsafeAction.action_cards[0];
  assert.ok(action);
  action.prerequisite_evidence_refs = [];
  assert.throws(() => createKnowledgeSnapshot(unsafeAction), /safely parked/);
});

test("Knowledge search separates product documents from historical cases", () => {
  const snapshot = createKnowledgeSnapshot(fixtureInput());

  assert.deepEqual(
    searchKnowledge(snapshot, "PRODUCT_DOC", "display").map(
      (document) => document.knowledge_id,
    ),
    ["DOC-DISPLAY-001"],
  );
  assert.deepEqual(
    searchKnowledge(snapshot, "HISTORICAL_CASE", "border").map(
      (document) => document.knowledge_id,
    ),
    ["CASE-279"],
  );
});

test("Action policy requires current Case evidence and keeps prohibitions visible", () => {
  const snapshot = createKnowledgeSnapshot(fixtureInput());
  const unavailable = getActionPolicy(snapshot, []);
  assert.equal(unavailable.action_cards.length, 0);
  assert.equal(unavailable.prohibited_actions[0]?.policy_id, "NO-VEHICLE-WIRING");

  const available = getActionPolicy(snapshot, [
    VEHICLE_SAFELY_PARKED_EVIDENCE_REF,
  ]);
  assert.equal(available.action_cards[0]?.action_id, "ACTION-DISPLAY-RESTART");
});

test("publication accepts exact applicable references and rejects stale or inapplicable ones", () => {
  const snapshot = createKnowledgeSnapshot(fixtureInput());
  const candidate = {
    message_markdown: "请使用已批准的重启入口，然后确认原问题是否恢复。",
    claim_refs: [{ knowledge_id: "DOC-DISPLAY-001", version: "1" }],
    action_card_refs: [
      { action_id: "ACTION-DISPLAY-RESTART", version: "1" },
    ],
    response_type: "ACTION",
  };

  assert.deepEqual(
    validatePublishedCaseResponse({
      candidate,
      snapshot,
      caseKnowledgeSnapshotId: snapshot.snapshot_id,
      evidenceRefs: [VEHICLE_SAFELY_PARKED_EVIDENCE_REF],
    }),
    candidate,
  );
  assert.throws(
    () =>
      validatePublishedCaseResponse({
        candidate,
        snapshot,
        caseKnowledgeSnapshotId: snapshot.snapshot_id,
        evidenceRefs: [],
      }),
    /ACTION_CARD_NOT_APPROVED_OR_APPLICABLE/,
  );
  assert.throws(
    () =>
      validatePublishedCaseResponse({
        candidate: {
          ...candidate,
          claim_refs: [{ knowledge_id: "DOC-DISPLAY-001", version: "2" }],
        },
        snapshot,
        caseKnowledgeSnapshotId: snapshot.snapshot_id,
        evidenceRefs: [VEHICLE_SAFELY_PARKED_EVIDENCE_REF],
      }),
    /KNOWLEDGE_REFERENCE_NOT_APPROVED_OR_APPLICABLE/,
  );
  assert.throws(
    () =>
      validatePublishedCaseResponse({
        candidate,
        snapshot,
        caseKnowledgeSnapshotId: "CHANGED_SNAPSHOT",
        evidenceRefs: [VEHICLE_SAFELY_PARKED_EVIDENCE_REF],
      }),
    /FROZEN_KNOWLEDGE_SNAPSHOT_MISMATCH/,
  );
});
