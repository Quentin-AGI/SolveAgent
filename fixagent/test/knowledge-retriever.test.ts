import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInMemoryKnowledgeRetriever,
  createRaftKnowledgeRetriever,
} from "../src/knowledge-retriever.js";
import {
  createKnowledgeSnapshot,
  type KnowledgeDocumentInput,
} from "../src/knowledge-store.js";

const approvedDocument = (
  knowledgeId: string,
  kind: "PRODUCT_DOC" | "HISTORICAL_CASE",
  text: string,
): KnowledgeDocumentInput => ({
  knowledge_id: knowledgeId,
  version: "1",
  kind,
  document_type: kind === "HISTORICAL_CASE" ? "CASE_CONTENT" : "GENERAL",
  title: knowledgeId,
  text,
  tags: ["display"],
  applicability: {
    configuration_ids: ["CONFIG"],
    software_versions: ["1.0"],
    regions: ["CN"],
  },
  ...(kind === "HISTORICAL_CASE"
    ? {
        case_content: {
          issue_id: knowledgeId,
          content_id: `${knowledgeId}-content`,
          content_role: "SOLUTION" as const,
          related_issue_ids: [],
        },
      }
    : {}),
  source: {
    uri: `https://example.com/${knowledgeId}`,
    title: knowledgeId,
    published_at: "2026-09-20T00:00:00.000Z",
    retrieved_at: "2026-09-21T00:00:00.000Z",
    source_content_hash: "a".repeat(64),
  },
  approval_status: "EVAL_APPROVED",
  approved_by: "owner",
  approved_at: "2026-09-21T00:00:00.000Z",
  approval_authority: "EVALUATION_DATA_OWNER",
});

const snapshot = createKnowledgeSnapshot({
  snapshot_id: "RETRIEVAL_TEST",
  mode: "EVALUATION",
  created_at: "2026-09-24T00:00:00.000Z",
  cutoff_at: "2026-09-24T00:00:00.000Z",
  evaluation_cases: [
    {
      evaluation_case_id: "TARGET",
      target_issue_id: "TARGET-ISSUE",
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
  documents: [
    approvedDocument("DOC-1", "PRODUCT_DOC", "display restart procedure"),
    approvedDocument("CASE-1", "HISTORICAL_CASE", "display cable failure"),
  ],
  action_cards: [],
  prohibited_actions: [],
  knowledge_conflicts: [],
});

test("default retriever preserves the existing in-memory search behavior", async () => {
  const retriever = createInMemoryKnowledgeRetriever();
  const results = await retriever.search({
    snapshot,
    kind: "PRODUCT_DOC",
    query: "restart display",
    maxResults: 5,
  });
  assert.deepEqual(results.map((result) => result.knowledge_id), ["DOC-1"]);
});

test("RAFT adapter can return only approved references from the frozen snapshot", async () => {
  let capturedRequest: unknown;
  const retriever = createRaftKnowledgeRetriever({
    async search(request) {
      capturedRequest = request;
      return [
        { knowledge_id: "UNKNOWN", version: "1", score: 100 },
        { knowledge_id: "CASE-1", version: "1", score: 90 },
        { knowledge_id: "DOC-1", version: "1", score: 80 },
        { knowledge_id: "DOC-1", version: "1", score: 70 },
      ];
    },
  });

  const results = await retriever.search({
    snapshot,
    kind: "PRODUCT_DOC",
    query: "display",
    maxResults: 5,
  });

  assert.deepEqual(results.map((result) => result.knowledge_id), ["DOC-1"]);
  assert.deepEqual(capturedRequest, {
    snapshot_id: "RETRIEVAL_TEST",
    kind: "PRODUCT_DOC",
    query: "display",
    max_results: 5,
    product_context: snapshot.product_context,
  });
  assert.equal(JSON.stringify(capturedRequest).includes("restart procedure"), false);
});
