import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createKnowledgeSnapshot,
  getActionPolicy,
  materializeCaseKnowledgeSnapshot,
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
const evaluationApproval = {
  approval_status: "EVAL_APPROVED" as const,
  approved_by: "test-data-owner",
  approved_at: "2026-09-22T18:00:00.000Z",
  approval_authority: "EVALUATION_DATA_OWNER" as const,
};

const fixtureInput = (): KnowledgeSnapshotInput => ({
  snapshot_id: "CRANKSHAFT_EVAL_2026_09_22",
  mode: "EVALUATION",
  created_at: "2026-09-23T00:00:00.000Z",
  cutoff_at: "2026-09-22T23:59:59.999Z",
  evaluation_cases: [
    {
      evaluation_case_id: "TARGET-EARLY",
      target_issue_id: "issue-100",
      issue_created_at: "2026-09-20T23:59:59.000Z",
    },
    {
      evaluation_case_id: "TARGET-LATE",
      target_issue_id: "issue-200",
      issue_created_at: "2026-09-21T23:59:59.000Z",
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
      title: "Display settings",
      text: "Approved display configuration guidance.",
      tags: ["display", "configuration"],
      applicability,
      source: {
        uri: "https://example.test/docs/display",
        title: "Display documentation",
        retrieved_at: "2026-09-22T20:00:00.000Z",
        published_at: "2026-09-20T12:00:00.000Z",
        source_content_hash: sha,
      },
      ...evaluationApproval,
    },
    {
      knowledge_id: "CASE-279",
      version: "1",
      kind: "HISTORICAL_CASE",
      document_type: "CASE_CONTENT",
      title: "Display border case",
      text: "A historical display border report.",
      tags: ["display", "border"],
      applicability,
      case_content: {
        issue_id: "issue-279",
        content_id: "issue-279:body",
        content_role: "ISSUE_BODY",
        related_issue_ids: [],
      },
      source: {
        uri: "https://example.test/cases/279",
        title: "Historical case 279",
        retrieved_at: "2026-09-22T12:00:00.000Z",
        published_at: "2026-09-21T12:00:00.000Z",
        source_content_hash: sha,
      },
      ...evaluationApproval,
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
      ...evaluationApproval,
    },
  ],
  prohibited_actions: [
    {
      policy_id: "NO-VEHICLE-WIRING",
      description: "Do not alter vehicle wiring.",
      blocked_action_ids: ["ACTION-VEHICLE-WIRING"],
      applicability,
      source_ref: { knowledge_id: "DOC-DISPLAY-001", version: "1" },
      ...evaluationApproval,
    },
  ],
  knowledge_conflicts: [],
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
  const missingCatalog = fixtureInput();
  missingCatalog.evaluation_cases = [];
  assert.throws(
    () => createKnowledgeSnapshot(missingCatalog),
    /EVALUATION_CASE_CATALOG_REQUIRED/,
  );

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
  lateDocument.source.published_at = "2026-09-23T01:00:00.000Z";
  assert.throws(
    () => createKnowledgeSnapshot(afterCutoff),
    /KNOWLEDGE_SOURCE_PUBLISHED_AFTER_CUTOFF/,
  );

  const unsafeAction = fixtureInput();
  const action = unsafeAction.action_cards[0];
  assert.ok(action);
  action.prerequisite_evidence_refs = [];
  assert.throws(() => createKnowledgeSnapshot(unsafeAction), /safely parked/);

  const customer = fixtureInput();
  customer.mode = "CUSTOMER";
  customer.evaluation_cases = [];
  for (const entry of [
    ...customer.documents,
    ...customer.action_cards,
    ...customer.prohibited_actions,
  ]) {
    entry.approval_status = "PRODUCTION_APPROVED";
  }
  assert.throws(
    () => createKnowledgeSnapshot(customer),
    /KNOWLEDGE_APPROVAL_AUTHORITY_MISMATCH/,
  );
  for (const entry of [
    ...customer.documents,
    ...customer.action_cards,
    ...customer.prohibited_actions,
  ]) {
    entry.approval_authority = "DOMAIN_OWNER";
    entry.approved_by = "named-domain-owner";
  }
  assert.doesNotThrow(() => createKnowledgeSnapshot(customer));
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

  const vetoInput = fixtureInput();
  const prohibition = vetoInput.prohibited_actions[0];
  assert.ok(prohibition);
  prohibition.blocked_action_ids = ["ACTION-DISPLAY-RESTART"];
  const vetoed = getActionPolicy(createKnowledgeSnapshot(vetoInput), [
    VEHICLE_SAFELY_PARKED_EVIDENCE_REF,
  ]);
  assert.equal(vetoed.action_cards.length, 0);
});

test("unresolved Knowledge conflicts cite both sides and block dependent actions", () => {
  const input = fixtureInput();
  const conflictingDocument = structuredClone(input.documents[0]);
  assert.ok(conflictingDocument);
  conflictingDocument.knowledge_id = "DOC-DISPLAY-002";
  conflictingDocument.title = "Conflicting display settings";
  conflictingDocument.text = "An incompatible approved display configuration.";
  conflictingDocument.source = {
    ...conflictingDocument.source,
    uri: "https://example.test/docs/display-conflict",
    title: "Conflicting display documentation",
  };
  input.documents.push(conflictingDocument);
  input.knowledge_conflicts.push({
    conflict_id: "CONFLICT-DISPLAY-CONFIG",
    description: "The approved display configuration sources cannot both apply.",
    source_refs: [
      { knowledge_id: "DOC-DISPLAY-001", version: "1" },
      { knowledge_id: "DOC-DISPLAY-002", version: "1" },
    ],
    applicability,
    blocked_action_ids: ["ACTION-DISPLAY-RESTART"],
    resolutions: [
      {
        resolution_id: "DISPLAY-CONFIG-CONFIRMED",
        required_evidence_refs: ["case:display_config_confirmed"],
        selected_source_refs: [
          { knowledge_id: "DOC-DISPLAY-001", version: "1" },
        ],
        allowed_action_ids: ["ACTION-DISPLAY-RESTART"],
      },
    ],
    ...evaluationApproval,
  });
  const snapshot = createKnowledgeSnapshot(input);

  const unresolved = getActionPolicy(snapshot, [
    VEHICLE_SAFELY_PARKED_EVIDENCE_REF,
  ]);
  assert.equal(unresolved.action_cards.length, 0);
  assert.equal(
    unresolved.knowledge_conflicts[0]?.resolution_status,
    "UNRESOLVED",
  );

  const incompleteInformation = {
    message_markdown: "The first approved source recommends this configuration.",
    claim_refs: [{ knowledge_id: "DOC-DISPLAY-001", version: "1" }],
    action_card_refs: [],
    response_type: "INFORMATION",
  };
  assert.throws(
    () =>
      validatePublishedCaseResponse({
        candidate: incompleteInformation,
        snapshot,
        caseKnowledgeSnapshotId: snapshot.snapshot_id,
        caseKnowledgeSnapshotHash: snapshot.content_hash,
        evidenceRefs: [],
      }),
    /KNOWLEDGE_CONFLICT_ACKNOWLEDGEMENT_REQUIRED/,
  );

  const acknowledgedInformation = {
    ...incompleteInformation,
    message_markdown: "The two approved sources conflict, so the configuration is uncertain.",
    claim_refs: [
      { knowledge_id: "DOC-DISPLAY-001", version: "1" },
      { knowledge_id: "DOC-DISPLAY-002", version: "1" },
    ],
    knowledge_conflict_refs: ["CONFLICT-DISPLAY-CONFIG"],
  };
  assert.deepEqual(
    validatePublishedCaseResponse({
      candidate: acknowledgedInformation,
      snapshot,
      caseKnowledgeSnapshotId: snapshot.snapshot_id,
      caseKnowledgeSnapshotHash: snapshot.content_hash,
      evidenceRefs: [],
    }),
    acknowledgedInformation,
  );

  const resolved = getActionPolicy(snapshot, [
    VEHICLE_SAFELY_PARKED_EVIDENCE_REF,
    "case:display_config_confirmed",
  ]);
  assert.equal(resolved.action_cards.length, 1);
  assert.equal(
    resolved.knowledge_conflicts[0]?.resolution_status,
    "RESOLVED",
  );
});

test("Case cutoff prunes unavailable actions from surviving Knowledge conflicts", () => {
  const input = fixtureInput();
  const firstDocument = input.documents[0];
  const firstAction = input.action_cards[0];
  assert.ok(firstDocument && firstAction);

  const conflictingDocument = structuredClone(firstDocument);
  conflictingDocument.knowledge_id = "DOC-DISPLAY-002";
  conflictingDocument.source = {
    ...conflictingDocument.source,
    uri: "https://example.test/docs/display-conflict",
  };
  const lateSop = structuredClone(firstDocument);
  lateSop.knowledge_id = "DOC-LATE-SOP";
  lateSop.document_type = "ACTION_SOP";
  lateSop.source = {
    ...lateSop.source,
    uri: "https://example.test/docs/late-sop",
    published_at: "2026-09-21T12:00:00.000Z",
  };
  input.documents.push(conflictingDocument, lateSop);

  const lateAction = structuredClone(firstAction);
  lateAction.action_id = "ACTION-LATE";
  lateAction.source_ref = { knowledge_id: "DOC-LATE-SOP", version: "1" };
  input.action_cards.push(lateAction);
  input.knowledge_conflicts.push({
    conflict_id: "CONFLICT-WITH-LATE-ACTION",
    description: "The early sources conflict about a later action.",
    source_refs: [
      { knowledge_id: "DOC-DISPLAY-001", version: "1" },
      { knowledge_id: "DOC-DISPLAY-002", version: "1" },
    ],
    applicability,
    blocked_action_ids: ["ACTION-LATE"],
    resolutions: [
      {
        resolution_id: "LATE-ACTION-RESOLUTION",
        required_evidence_refs: ["case:late_action_resolution"],
        selected_source_refs: [
          { knowledge_id: "DOC-DISPLAY-001", version: "1" },
        ],
        allowed_action_ids: ["ACTION-LATE"],
      },
    ],
    ...evaluationApproval,
  });

  const materialized = materializeCaseKnowledgeSnapshot(
    createKnowledgeSnapshot(input),
    "TARGET-EARLY",
  );
  const conflict = materialized.knowledge_conflicts[0];
  assert.ok(conflict);
  assert.deepEqual(conflict.blocked_action_ids, []);
  assert.deepEqual(conflict.resolutions[0]?.allowed_action_ids, []);
  assert.equal(
    materialized.action_cards.some((action) => action.action_id === "ACTION-LATE"),
    false,
  );
});

test("Case-specific cutoff filters knowledge by publication time, not retrieval time", () => {
  const snapshot = createKnowledgeSnapshot(fixtureInput());
  const earlier = materializeCaseKnowledgeSnapshot(
    snapshot,
    "TARGET-EARLY",
  );

  assert.deepEqual(
    earlier.documents.map((document) => document.knowledge_id),
    ["DOC-DISPLAY-001"],
  );
  assert.equal(earlier.action_cards.length, 1);
  assert.notEqual(earlier.snapshot_id, snapshot.snapshot_id);
  assert.notEqual(earlier.content_hash, snapshot.content_hash);
  assert.throws(
    () =>
      materializeCaseKnowledgeSnapshot(
        snapshot,
        "UNKNOWN-EVALUATION-CASE",
      ),
    /EVALUATION_CASE_NOT_FOUND/,
  );
});

test("Case materialization excludes the target Issue and all linked future-answer content", () => {
  const input = fixtureInput();
  const historical = input.documents[1];
  assert.ok(historical);
  historical.source.published_at = "2026-09-20T12:00:00.000Z";

  const targetBody = structuredClone(historical);
  targetBody.knowledge_id = "TARGET-ISSUE-BODY";
  targetBody.case_content = {
    issue_id: "issue-100",
    content_id: "issue-100:body",
    content_role: "ISSUE_BODY",
    related_issue_ids: [],
  };
  const targetSolution = structuredClone(historical);
  targetSolution.knowledge_id = "TARGET-ISSUE-SOLUTION";
  targetSolution.case_content = {
    issue_id: "issue-100",
    content_id: "issue-100:solution",
    content_role: "SOLUTION",
    related_issue_ids: [],
  };
  const duplicate = structuredClone(historical);
  duplicate.knowledge_id = "TARGET-DUPLICATE";
  duplicate.case_content = {
    issue_id: "issue-300",
    content_id: "issue-300:body",
    content_role: "DUPLICATE_ISSUE",
    related_issue_ids: ["issue-100"],
  };
  const duplicateSolution = structuredClone(historical);
  duplicateSolution.knowledge_id = "TARGET-DUPLICATE-SOLUTION";
  duplicateSolution.case_content = {
    issue_id: "issue-300",
    content_id: "issue-300:solution",
    content_role: "SOLUTION",
    related_issue_ids: [],
  };
  const generatedFaq = structuredClone(historical);
  generatedFaq.knowledge_id = "TARGET-GENERATED-FAQ";
  generatedFaq.case_content = {
    issue_id: "faq-100",
    content_id: "faq-100:body",
    content_role: "GENERATED_FAQ",
    related_issue_ids: ["issue-300"],
  };
  const generatedFaqComment = structuredClone(historical);
  generatedFaqComment.knowledge_id = "TARGET-GENERATED-FAQ-COMMENT";
  generatedFaqComment.case_content = {
    issue_id: "faq-100",
    content_id: "faq-100:comment-1",
    content_role: "COMMENT",
    related_issue_ids: [],
  };
  const laterComment = structuredClone(historical);
  laterComment.knowledge_id = "UNRELATED-LATE-COMMENT";
  laterComment.source.published_at = "2026-09-21T12:00:00.000Z";
  laterComment.case_content = {
    issue_id: "issue-400",
    content_id: "issue-400:comment-1",
    content_role: "COMMENT",
    related_issue_ids: [],
  };
  input.documents.push(
    targetBody,
    targetSolution,
    duplicate,
    duplicateSolution,
    generatedFaq,
    generatedFaqComment,
    laterComment,
  );

  const materialized = materializeCaseKnowledgeSnapshot(
    createKnowledgeSnapshot(input),
    "TARGET-EARLY",
  );

  assert.deepEqual(
    materialized.documents.map((document) => document.knowledge_id),
    ["DOC-DISPLAY-001", "CASE-279"],
  );
  assert.deepEqual(materialized.case_binding, {
    evaluation_case_id: "TARGET-EARLY",
    target_issue_id: "issue-100",
    issue_created_at: "2026-09-20T23:59:59.000Z",
  });
});

test("Historical knowledge must be an attributable atomic Case content item", () => {
  const invalid = fixtureInput();
  const historical = invalid.documents[1];
  assert.ok(historical);
  delete historical.case_content;

  assert.throws(
    () => createKnowledgeSnapshot(invalid),
    /KNOWLEDGE_DOCUMENT_TYPE_MISMATCH|Invalid input/,
  );
});

test("Level 2 actions require an exact product and version approved SOP", () => {
  const invalid = fixtureInput();
  const action = invalid.action_cards[0];
  assert.ok(action);
  action.risk_level = "LEVEL_2";
  assert.throws(
    () => createKnowledgeSnapshot(invalid),
    /LEVEL_2_ACTION_REQUIRES_EXACT_APPROVED_SOP/,
  );

  const sop = invalid.documents[0];
  assert.ok(sop);
  sop.document_type = "ACTION_SOP";
  assert.doesNotThrow(() => createKnowledgeSnapshot(invalid));
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
      caseKnowledgeSnapshotHash: snapshot.content_hash,
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
        caseKnowledgeSnapshotHash: snapshot.content_hash,
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
        caseKnowledgeSnapshotHash: snapshot.content_hash,
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
        caseKnowledgeSnapshotHash: snapshot.content_hash,
        evidenceRefs: [VEHICLE_SAFELY_PARKED_EVIDENCE_REF],
      }),
    /FROZEN_KNOWLEDGE_SNAPSHOT_MISMATCH/,
  );
  assert.throws(
    () =>
      validatePublishedCaseResponse({
        candidate,
        snapshot,
        caseKnowledgeSnapshotId: snapshot.snapshot_id,
        caseKnowledgeSnapshotHash: "f".repeat(64),
        evidenceRefs: [VEHICLE_SAFELY_PARKED_EVIDENCE_REF],
      }),
    /FROZEN_KNOWLEDGE_SNAPSHOT_HASH_MISMATCH/,
  );
});

test("reference lookup cannot collide when IDs or versions contain separators", () => {
  const input = fixtureInput();
  const document = input.documents[0];
  const action = input.action_cards[0];
  const prohibition = input.prohibited_actions[0];
  assert.ok(document && action && prohibition);
  document.knowledge_id = "DOC@V";
  action.source_ref = { knowledge_id: "DOC@V", version: "1" };
  prohibition.source_ref = { knowledge_id: "DOC@V", version: "1" };
  const snapshot = createKnowledgeSnapshot(input);

  assert.throws(
    () =>
      validatePublishedCaseResponse({
        candidate: {
          message_markdown: "This reference does not exist.",
          claim_refs: [{ knowledge_id: "DOC", version: "V@1" }],
          action_card_refs: [],
          response_type: "INFORMATION",
        },
        snapshot,
        caseKnowledgeSnapshotId: snapshot.snapshot_id,
        caseKnowledgeSnapshotHash: snapshot.content_hash,
        evidenceRefs: [],
      }),
    /KNOWLEDGE_REFERENCE_NOT_APPROVED_OR_APPLICABLE/,
  );
});

test("Knowledge Snapshot rejects noncanonical IDs and unpublishable conflict components", () => {
  const whitespace = fixtureInput();
  const whitespaceDocument = whitespace.documents[0];
  assert.ok(whitespaceDocument);
  whitespaceDocument.knowledge_id = " DOC-DISPLAY-001 ";
  assert.throws(
    () => createKnowledgeSnapshot(whitespace),
    /Identifiers cannot have surrounding whitespace/,
  );

  const oversized = fixtureInput();
  const source = oversized.documents[0];
  assert.ok(source);
  const sourceRefs = [
    { knowledge_id: source.knowledge_id, version: source.version },
  ];
  for (let index = 2; index <= 21; index += 1) {
    const document = structuredClone(source);
    document.knowledge_id = `DOC-DISPLAY-${String(index).padStart(3, "0")}`;
    document.source = {
      ...document.source,
      uri: `https://example.test/docs/display-${index}`,
    };
    oversized.documents.push(document);
    sourceRefs.push({
      knowledge_id: document.knowledge_id,
      version: document.version,
    });
  }
  oversized.knowledge_conflicts.push({
    conflict_id: "CONFLICT-TOO-LARGE-TO-PUBLISH",
    description: "This conflict has more sources than one response can cite.",
    source_refs: sourceRefs,
    applicability,
    blocked_action_ids: [],
    resolutions: [],
    ...evaluationApproval,
  });
  assert.throws(
    () => createKnowledgeSnapshot(oversized),
    /KNOWLEDGE_CONFLICT_COMPONENT_TOO_LARGE/,
  );
});
