import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  publishedCaseResponseSchema,
  type PublishedCaseResponse,
} from "./published-case-response.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

const hashJson = (value: unknown): string =>
  sha256(JSON.stringify(canonicalize(value)));

const hashPattern = /^[a-f0-9]{64}$/;
const approvalSchema = z.enum(["EVAL_APPROVED", "PRODUCTION_APPROVED"]);
export const VEHICLE_SAFELY_PARKED_EVIDENCE_REF =
  "case:vehicle_safely_parked";

const applicabilitySchema = z
  .object({
    configuration_ids: z.array(z.string().min(1)).min(1),
    software_versions: z.array(z.string().min(1)).min(1),
    regions: z.array(z.string().min(1)).min(1),
  })
  .strict();

const sourceSchema = z
  .object({
    uri: z.string().url(),
    title: z.string().min(1),
    retrieved_at: z.string().datetime(),
    source_content_hash: z.string().regex(hashPattern),
  })
  .strict();

const knowledgeDocumentWithoutHashSchema = z
  .object({
    knowledge_id: z.string().min(1),
    version: z.string().min(1),
    kind: z.enum(["PRODUCT_DOC", "HISTORICAL_CASE"]),
    title: z.string().min(1),
    text: z.string().min(1),
    tags: z.array(z.string().min(1)),
    applicability: applicabilitySchema,
    source: sourceSchema,
    approval_status: approvalSchema,
  })
  .strict();

const knowledgeDocumentSchema = knowledgeDocumentWithoutHashSchema.extend({
  content_hash: z.string().regex(hashPattern),
});

const actionCardWithoutHashSchema = z
  .object({
    action_id: z.string().min(1),
    version: z.string().min(1),
    title: z.string().min(1),
    applicability: applicabilitySchema,
    prerequisite_evidence_refs: z
      .array(z.string().min(1))
      .refine(
        (references) =>
          references.includes(VEHICLE_SAFELY_PARKED_EVIDENCE_REF),
        "Every Action Card requires evidence that the vehicle is safely parked",
      ),
    risk_level: z.enum(["LEVEL_1", "LEVEL_2"]),
    steps: z.array(z.string().min(1)).min(1),
    verification: z.array(z.string().min(1)).min(1),
    rollback: z.array(z.string().min(1)).min(1),
    source_ref: z
      .object({
        knowledge_id: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
    approval_status: approvalSchema,
  })
  .strict();

const actionCardSchema = actionCardWithoutHashSchema.extend({
  content_hash: z.string().regex(hashPattern),
});

const prohibitedActionWithoutHashSchema = z
  .object({
    policy_id: z.string().min(1),
    description: z.string().min(1),
    applicability: applicabilitySchema,
    source_ref: z
      .object({
        knowledge_id: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
    approval_status: approvalSchema,
  })
  .strict();

const prohibitedActionSchema = prohibitedActionWithoutHashSchema.extend({
  content_hash: z.string().regex(hashPattern),
});

const productContextSchema = z
  .object({
    product_family: z.string().min(1),
    configuration_id: z.string().min(1),
    hardware_version: z.string().min(1),
    software_version: z.string().min(1),
    region: z.string().min(1),
  })
  .strict();

const snapshotWithoutHashSchema = z
  .object({
    schema_version: z.literal("fixagent.knowledge-snapshot.v0"),
    snapshot_id: z.string().min(1),
    mode: z.enum(["EVALUATION", "CUSTOMER"]),
    created_at: z.string().datetime(),
    cutoff_at: z.string().datetime(),
    product_context: productContextSchema,
    documents: z.array(knowledgeDocumentSchema),
    action_cards: z.array(actionCardSchema),
    prohibited_actions: z.array(prohibitedActionSchema),
  })
  .strict();

const knowledgeSnapshotSchema = snapshotWithoutHashSchema.extend({
  content_hash: z.string().regex(hashPattern),
});

export type KnowledgeDocumentInput = z.infer<
  typeof knowledgeDocumentWithoutHashSchema
>;
export type ActionCardInput = z.infer<typeof actionCardWithoutHashSchema>;
export type ProhibitedActionInput = z.infer<
  typeof prohibitedActionWithoutHashSchema
>;
export type KnowledgeSnapshot = z.infer<typeof knowledgeSnapshotSchema>;
export type ProductContext = z.infer<typeof productContextSchema>;

export interface KnowledgeSnapshotInput {
  snapshot_id: string;
  mode: "EVALUATION" | "CUSTOMER";
  created_at: string;
  cutoff_at: string;
  product_context: ProductContext;
  documents: KnowledgeDocumentInput[];
  action_cards: ActionCardInput[];
  prohibited_actions: ProhibitedActionInput[];
}

const withHash = <T extends object>(value: T): T & { content_hash: string } => ({
  ...value,
  content_hash: hashJson(value),
});

const verifyHash = <T extends { content_hash: string }>(value: T): void => {
  const { content_hash: contentHash, ...withoutHash } = value;
  if (hashJson(withoutHash) !== contentHash) {
    throw new Error("KNOWLEDGE_HASH_MISMATCH");
  }
};

const referenceKey = (id: string, version: string): string => `${id}@${version}`;

export const createKnowledgeSnapshot = (
  input: KnowledgeSnapshotInput,
): KnowledgeSnapshot => {
  const snapshot = withHash({
    schema_version: "fixagent.knowledge-snapshot.v0" as const,
    snapshot_id: input.snapshot_id,
    mode: input.mode,
    created_at: input.created_at,
    cutoff_at: input.cutoff_at,
    product_context: input.product_context,
    documents: input.documents.map((document) => withHash(document)),
    action_cards: input.action_cards.map((action) => withHash(action)),
    prohibited_actions: input.prohibited_actions.map((action) => withHash(action)),
  });
  return parseKnowledgeSnapshot(snapshot);
};

export const parseKnowledgeSnapshot = (candidate: unknown): KnowledgeSnapshot => {
  const snapshot = knowledgeSnapshotSchema.parse(candidate);
  verifyHash(snapshot);
  snapshot.documents.forEach(verifyHash);
  snapshot.action_cards.forEach(verifyHash);
  snapshot.prohibited_actions.forEach(verifyHash);

  const expectedApproval =
    snapshot.mode === "EVALUATION" ? "EVAL_APPROVED" : "PRODUCTION_APPROVED";
  const entries = [
    ...snapshot.documents,
    ...snapshot.action_cards,
    ...snapshot.prohibited_actions,
  ];
  if (entries.some((entry) => entry.approval_status !== expectedApproval)) {
    throw new Error("KNOWLEDGE_APPROVAL_MODE_MISMATCH");
  }
  const cutoff = Date.parse(snapshot.cutoff_at);
  if (cutoff > Date.parse(snapshot.created_at)) {
    throw new Error("KNOWLEDGE_CUTOFF_AFTER_SNAPSHOT_CREATION");
  }
  if (
    snapshot.documents.some(
      (document) => Date.parse(document.source.retrieved_at) > cutoff,
    )
  ) {
    throw new Error("KNOWLEDGE_SOURCE_AFTER_CUTOFF");
  }

  const documentKeys = snapshot.documents.map((document) =>
    referenceKey(document.knowledge_id, document.version),
  );
  if (new Set(documentKeys).size !== documentKeys.length) {
    throw new Error("KNOWLEDGE_DUPLICATE_REFERENCE");
  }
  const documentKeySet = new Set(documentKeys);

  const actionKeys = snapshot.action_cards.map((action) =>
    referenceKey(action.action_id, action.version),
  );
  if (new Set(actionKeys).size !== actionKeys.length) {
    throw new Error("ACTION_CARD_DUPLICATE_REFERENCE");
  }
  const prohibitedPolicyIds = snapshot.prohibited_actions.map(
    (action) => action.policy_id,
  );
  if (new Set(prohibitedPolicyIds).size !== prohibitedPolicyIds.length) {
    throw new Error("PROHIBITED_ACTION_DUPLICATE_ID");
  }

  for (const entry of [
    ...snapshot.action_cards,
    ...snapshot.prohibited_actions,
  ]) {
    if (
      !documentKeySet.has(
        referenceKey(entry.source_ref.knowledge_id, entry.source_ref.version),
      )
    ) {
      throw new Error("KNOWLEDGE_SOURCE_REFERENCE_NOT_FOUND");
    }
  }

  return snapshot;
};

export const loadKnowledgeSnapshotFile = async (
  path: string,
): Promise<KnowledgeSnapshot> =>
  parseKnowledgeSnapshot(
    JSON.parse(await readFile(path, "utf8")),
  );

export const loadCaseKnowledgeSnapshot = (
  caseWorkspaceRoot: string,
): Promise<KnowledgeSnapshot> =>
  loadKnowledgeSnapshotFile(
    join(caseWorkspaceRoot, ".fixagent", "knowledge-snapshot.json"),
  );

const includesScopeValue = (values: string[], current: string): boolean =>
  values.includes("*") || values.includes(current);

const isApplicable = (
  applicability: z.infer<typeof applicabilitySchema>,
  context: ProductContext,
): boolean =>
  includesScopeValue(applicability.configuration_ids, context.configuration_id) &&
  includesScopeValue(applicability.software_versions, context.software_version) &&
  includesScopeValue(applicability.regions, context.region);

const queryTerms = (query: string): string[] =>
  query
    .toLocaleLowerCase()
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter(Boolean);

export const searchKnowledge = (
  snapshot: KnowledgeSnapshot,
  kind: "PRODUCT_DOC" | "HISTORICAL_CASE",
  query: string,
  maxResults = 5,
): KnowledgeSnapshot["documents"] => {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  return snapshot.documents
    .filter(
      (document) =>
        document.kind === kind &&
        isApplicable(document.applicability, snapshot.product_context),
    )
    .map((document) => {
      const searchable = [document.title, document.text, ...document.tags]
        .join("\n")
        .toLocaleLowerCase();
      const score = terms.reduce(
        (total, term) => total + (searchable.includes(term) ? 1 : 0),
        0,
      );
      return { document, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.document.knowledge_id.localeCompare(right.document.knowledge_id),
    )
    .slice(0, Math.max(1, Math.min(maxResults, 10)))
    .map(({ document }) => document);
};

export const getActionPolicy = (
  snapshot: KnowledgeSnapshot,
  evidenceRefs: string[],
): {
  action_cards: KnowledgeSnapshot["action_cards"];
  prohibited_actions: KnowledgeSnapshot["prohibited_actions"];
} => {
  const availableEvidence = new Set(evidenceRefs);
  return {
    action_cards: snapshot.action_cards.filter(
      (action) =>
        isApplicable(action.applicability, snapshot.product_context) &&
        action.prerequisite_evidence_refs.every((reference) =>
          availableEvidence.has(reference),
        ),
    ),
    prohibited_actions: snapshot.prohibited_actions.filter((action) =>
      isApplicable(action.applicability, snapshot.product_context),
    ),
  };
};

export const validatePublishedCaseResponse = ({
  candidate,
  snapshot,
  caseKnowledgeSnapshotId,
  evidenceRefs,
}: {
  candidate: unknown;
  snapshot: KnowledgeSnapshot;
  caseKnowledgeSnapshotId: string;
  evidenceRefs: string[];
}): PublishedCaseResponse => {
  const response = publishedCaseResponseSchema.parse(candidate);
  if (snapshot.snapshot_id !== caseKnowledgeSnapshotId) {
    throw new Error("FROZEN_KNOWLEDGE_SNAPSHOT_MISMATCH");
  }

  const documents = new Map(
    snapshot.documents
      .filter((document) =>
        isApplicable(document.applicability, snapshot.product_context),
      )
      .map((document) => [
        referenceKey(document.knowledge_id, document.version),
        document,
      ]),
  );
  for (const reference of response.claim_refs) {
    if (!documents.has(referenceKey(reference.knowledge_id, reference.version))) {
      throw new Error("KNOWLEDGE_REFERENCE_NOT_APPROVED_OR_APPLICABLE");
    }
  }

  const applicableActions = new Map(
    getActionPolicy(snapshot, evidenceRefs).action_cards.map((action) => [
      referenceKey(action.action_id, action.version),
      action,
    ]),
  );
  for (const reference of response.action_card_refs) {
    if (!applicableActions.has(referenceKey(reference.action_id, reference.version))) {
      throw new Error("ACTION_CARD_NOT_APPROVED_OR_APPLICABLE");
    }
  }

  return response;
};

export const EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT = createKnowledgeSnapshot({
  snapshot_id: "EMPTY_EVAL_V0",
  mode: "EVALUATION",
  created_at: "2026-09-23T00:00:00.000Z",
  cutoff_at: "2026-09-22T23:59:59.999Z",
  product_context: {
    product_family: "CRANKSHAFT_RASPBERRY_PI_DISPLAY",
    configuration_id: "UNCONFIRMED_REFERENCE_CONFIGURATION",
    hardware_version: "UNCONFIRMED",
    software_version: "UNCONFIRMED",
    region: "GLOBAL",
  },
  documents: [],
  action_cards: [],
  prohibited_actions: [],
});
