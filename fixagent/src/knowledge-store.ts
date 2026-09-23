import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { FixAgentDomainError } from "./domain-error.js";
import {
  knowledgeReferenceShape,
  MAX_PUBLISHED_CLAIM_REFS,
  MAX_PUBLISHED_CONFLICT_REFS,
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
const identifierSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), "Identifiers cannot have surrounding whitespace");
const approvalSchema = z.enum(["EVAL_APPROVED", "PRODUCTION_APPROVED"]);
const approvalAuthoritySchema = z.enum([
  "EVALUATION_DATA_OWNER",
  "SKU_MANUFACTURER",
  "DOMAIN_OWNER",
]);
const approvalMetadataShape = {
  approval_status: approvalSchema,
  approved_by: z.string().trim().min(1),
  approved_at: z.string().datetime(),
  approval_authority: approvalAuthoritySchema,
};
export const VEHICLE_SAFELY_PARKED_EVIDENCE_REF =
  "case:vehicle_safely_parked";

const applicabilitySchema = z
  .object({
    configuration_ids: z.array(identifierSchema).min(1),
    software_versions: z.array(identifierSchema).min(1),
    regions: z.array(identifierSchema).min(1),
  })
  .strict();

const sourceSchema = z
  .object({
    uri: z.string().url(),
    title: z.string().min(1),
    retrieved_at: z.string().datetime(),
    published_at: z.string().datetime(),
    source_content_hash: z.string().regex(hashPattern),
  })
  .strict();

const historicalCaseContentSchema = z
  .object({
    issue_id: identifierSchema,
    content_id: identifierSchema,
    content_role: z.enum([
      "ISSUE_BODY",
      "COMMENT",
      "SOLUTION",
      "DUPLICATE_ISSUE",
      "GENERATED_FAQ",
    ]),
    related_issue_ids: z.array(identifierSchema),
  })
  .strict()
  .superRefine((content, context) => {
    if (
      ["DUPLICATE_ISSUE", "GENERATED_FAQ"].includes(content.content_role) &&
      content.related_issue_ids.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: `${content.content_role} must identify its related Issue`,
      });
    }
  });

const evaluationCaseSchema = z
  .object({
    evaluation_case_id: identifierSchema,
    target_issue_id: identifierSchema,
    issue_created_at: z.string().datetime(),
  })
  .strict();

const knowledgeDocumentWithoutHashSchema = z
  .object({
    knowledge_id: identifierSchema,
    version: identifierSchema,
    kind: z.enum(["PRODUCT_DOC", "HISTORICAL_CASE"]),
    document_type: z.enum([
      "GENERAL",
      "ACTION_SOP",
      "SAFETY_SOP",
      "RELEASE_NOTES",
      "CASE_CONTENT",
    ]),
    title: z.string().min(1),
    text: z.string().min(1),
    tags: z.array(z.string().min(1)),
    applicability: applicabilitySchema,
    case_content: historicalCaseContentSchema.optional(),
    source: sourceSchema,
    ...approvalMetadataShape,
  })
  .strict();

const knowledgeDocumentSchema = knowledgeDocumentWithoutHashSchema.extend({
  content_hash: z.string().regex(hashPattern),
});

const actionCardWithoutHashSchema = z
  .object({
    action_id: identifierSchema,
    version: identifierSchema,
    title: z.string().min(1),
    applicability: applicabilitySchema,
    prerequisite_evidence_refs: z
      .array(identifierSchema)
      .refine(
        (references) =>
          references.includes(VEHICLE_SAFELY_PARKED_EVIDENCE_REF),
        "Every Action Card requires evidence that the vehicle is safely parked",
      ),
    risk_level: z.enum(["LEVEL_1", "LEVEL_2"]),
    steps: z.array(z.string().min(1)).min(1),
    verification: z.array(z.string().min(1)).min(1),
    rollback: z.array(z.string().min(1)).min(1),
    source_ref: knowledgeReferenceShape,
    ...approvalMetadataShape,
  })
  .strict();

const actionCardSchema = actionCardWithoutHashSchema.extend({
  content_hash: z.string().regex(hashPattern),
});

const prohibitedActionWithoutHashSchema = z
  .object({
    policy_id: identifierSchema,
    description: z.string().min(1),
    blocked_action_ids: z.array(identifierSchema).min(1),
    applicability: applicabilitySchema,
    source_ref: knowledgeReferenceShape,
    ...approvalMetadataShape,
  })
  .strict();

const prohibitedActionSchema = prohibitedActionWithoutHashSchema.extend({
  content_hash: z.string().regex(hashPattern),
});

const conflictResolutionSchema = z
  .object({
    resolution_id: identifierSchema,
    required_evidence_refs: z.array(identifierSchema).min(1),
    selected_source_refs: z.array(knowledgeReferenceShape).min(1),
    allowed_action_ids: z.array(identifierSchema),
  })
  .strict();

const knowledgeConflictWithoutHashSchema = z
  .object({
    conflict_id: identifierSchema,
    description: z.string().min(1),
    source_refs: z.array(knowledgeReferenceShape).min(2),
    applicability: applicabilitySchema,
    blocked_action_ids: z.array(identifierSchema),
    resolutions: z.array(conflictResolutionSchema),
    ...approvalMetadataShape,
  })
  .strict();

const knowledgeConflictSchema = knowledgeConflictWithoutHashSchema.extend({
  content_hash: z.string().regex(hashPattern),
});

const productContextSchema = z
  .object({
    product_family: identifierSchema,
    configuration_id: identifierSchema,
    hardware_version: identifierSchema,
    software_version: identifierSchema,
    region: identifierSchema,
  })
  .strict();

const snapshotWithoutHashSchema = z
  .object({
    schema_version: z.literal("fixagent.knowledge-snapshot.v0"),
    snapshot_id: identifierSchema,
    mode: z.enum(["EVALUATION", "CUSTOMER"]),
    created_at: z.string().datetime(),
    corpus_cutoff_at: z.string().datetime(),
    cutoff_at: z.string().datetime(),
    evaluation_cases: z.array(evaluationCaseSchema),
    case_binding: evaluationCaseSchema.nullable(),
    product_context: productContextSchema,
    documents: z.array(knowledgeDocumentSchema),
    action_cards: z.array(actionCardSchema),
    prohibited_actions: z.array(prohibitedActionSchema),
    knowledge_conflicts: z.array(knowledgeConflictSchema),
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
export type KnowledgeConflictInput = z.infer<
  typeof knowledgeConflictWithoutHashSchema
>;
export type KnowledgeSnapshot = z.infer<typeof knowledgeSnapshotSchema>;
export type ProductContext = z.infer<typeof productContextSchema>;
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;

export interface KnowledgeSnapshotInput {
  snapshot_id: string;
  mode: "EVALUATION" | "CUSTOMER";
  created_at: string;
  cutoff_at: string;
  evaluation_cases: EvaluationCase[];
  product_context: ProductContext;
  documents: KnowledgeDocumentInput[];
  action_cards: ActionCardInput[];
  prohibited_actions: ProhibitedActionInput[];
  knowledge_conflicts: KnowledgeConflictInput[];
}

const withHash = <T extends object>(value: T): T & { content_hash: string } => ({
  ...value,
  content_hash: hashJson(value),
});

const verifyHash = <T extends { content_hash: string }>(value: T): void => {
  const { content_hash: contentHash, ...withoutHash } = value;
  if (hashJson(withoutHash) !== contentHash) {
    throw new FixAgentDomainError("KNOWLEDGE_HASH_MISMATCH");
  }
};

const referenceKey = (id: string, version: string): string =>
  JSON.stringify([id, version]);

const includesScopeValue = (values: string[], current: string): boolean =>
  values.includes("*") || values.includes(current);

const isApplicable = (
  applicability: z.infer<typeof applicabilitySchema>,
  context: ProductContext,
): boolean =>
  includesScopeValue(applicability.configuration_ids, context.configuration_id) &&
  includesScopeValue(applicability.software_versions, context.software_version) &&
  includesScopeValue(applicability.regions, context.region);

const isExactProductAndVersion = (
  applicability: z.infer<typeof applicabilitySchema>,
  context: ProductContext,
): boolean =>
  applicability.configuration_ids.length === 1 &&
  applicability.configuration_ids[0] === context.configuration_id &&
  applicability.software_versions.length === 1 &&
  applicability.software_versions[0] === context.software_version;

const collectTargetRelatedIssueIds = (
  documents: Array<z.infer<typeof knowledgeDocumentSchema>>,
  targetIssueId: string,
): Set<string> => {
  const excludedIssueIds = new Set([targetIssueId]);
  let discoveredRelatedIssue = true;
  while (discoveredRelatedIssue) {
    discoveredRelatedIssue = false;
    for (const document of documents) {
      const content = document.case_content;
      if (
        content &&
        !excludedIssueIds.has(content.issue_id) &&
        content.related_issue_ids.some((issueId) =>
          excludedIssueIds.has(issueId),
        )
      ) {
        excludedIssueIds.add(content.issue_id);
        discoveredRelatedIssue = true;
      }
    }
  }
  return excludedIssueIds;
};

export const createKnowledgeSnapshot = (
  input: KnowledgeSnapshotInput,
): KnowledgeSnapshot => {
  const snapshot = withHash({
    schema_version: "fixagent.knowledge-snapshot.v0" as const,
    snapshot_id: input.snapshot_id,
    mode: input.mode,
    created_at: input.created_at,
    corpus_cutoff_at: input.cutoff_at,
    cutoff_at: input.cutoff_at,
    evaluation_cases: input.evaluation_cases,
    case_binding: null,
    product_context: input.product_context,
    documents: input.documents.map((document) => withHash(document)),
    action_cards: input.action_cards.map((action) => withHash(action)),
    prohibited_actions: input.prohibited_actions.map((action) => withHash(action)),
    knowledge_conflicts: input.knowledge_conflicts.map((conflict) =>
      withHash(conflict),
    ),
  });
  return parseKnowledgeSnapshot(snapshot);
};

export const parseKnowledgeSnapshot = (candidate: unknown): KnowledgeSnapshot => {
  const snapshot = knowledgeSnapshotSchema.parse(candidate);
  verifyHash(snapshot);
  snapshot.documents.forEach(verifyHash);
  snapshot.action_cards.forEach(verifyHash);
  snapshot.prohibited_actions.forEach(verifyHash);
  snapshot.knowledge_conflicts.forEach(verifyHash);

  const expectedApproval =
    snapshot.mode === "EVALUATION" ? "EVAL_APPROVED" : "PRODUCTION_APPROVED";
  const entries = [
    ...snapshot.documents,
    ...snapshot.action_cards,
    ...snapshot.prohibited_actions,
    ...snapshot.knowledge_conflicts,
  ];
  if (entries.some((entry) => entry.approval_status !== expectedApproval)) {
    throw new FixAgentDomainError("KNOWLEDGE_APPROVAL_MODE_MISMATCH");
  }
  if (
    snapshot.mode === "EVALUATION" &&
    entries.some(
      (entry) => entry.approval_authority !== "EVALUATION_DATA_OWNER",
    )
  ) {
    throw new FixAgentDomainError("KNOWLEDGE_APPROVAL_AUTHORITY_MISMATCH");
  }
  if (
    snapshot.mode === "CUSTOMER" &&
    entries.some(
      (entry) =>
        entry.approval_authority !== "SKU_MANUFACTURER" &&
        entry.approval_authority !== "DOMAIN_OWNER",
    )
  ) {
    throw new FixAgentDomainError("KNOWLEDGE_APPROVAL_AUTHORITY_MISMATCH");
  }
  if (
    entries.some(
      (entry) => Date.parse(entry.approved_at) > Date.parse(snapshot.created_at),
    )
  ) {
    throw new FixAgentDomainError("KNOWLEDGE_APPROVAL_AFTER_SNAPSHOT_CREATION");
  }
  const corpusCutoff = Date.parse(snapshot.corpus_cutoff_at);
  const cutoff = Date.parse(snapshot.cutoff_at);
  if (corpusCutoff > Date.parse(snapshot.created_at)) {
    throw new FixAgentDomainError("KNOWLEDGE_CUTOFF_AFTER_SNAPSHOT_CREATION");
  }
  if (cutoff > corpusCutoff) {
    throw new FixAgentDomainError("CASE_KNOWLEDGE_CUTOFF_EXCEEDS_CORPUS");
  }
  if (!snapshot.case_binding && snapshot.cutoff_at !== snapshot.corpus_cutoff_at) {
    throw new FixAgentDomainError("EVALUATION_CASE_BINDING_MISMATCH");
  }
  const evaluationCaseIds = snapshot.evaluation_cases.map(
    (evaluationCase) => evaluationCase.evaluation_case_id,
  );
  const targetIssueIds = snapshot.evaluation_cases.map(
    (evaluationCase) => evaluationCase.target_issue_id,
  );
  if (
    new Set(evaluationCaseIds).size !== evaluationCaseIds.length ||
    new Set(targetIssueIds).size !== targetIssueIds.length
  ) {
    throw new FixAgentDomainError("EVALUATION_CASE_DUPLICATE_ID");
  }
  if (
    snapshot.evaluation_cases.some(
      (evaluationCase) =>
        Date.parse(evaluationCase.issue_created_at) > corpusCutoff,
    )
  ) {
    throw new FixAgentDomainError("EVALUATION_CASE_AFTER_CORPUS_CUTOFF");
  }
  if (
    snapshot.mode === "EVALUATION" &&
    snapshot.documents.length > 0 &&
    snapshot.evaluation_cases.length === 0
  ) {
    throw new FixAgentDomainError("EVALUATION_CASE_CATALOG_REQUIRED");
  }
  if (
    snapshot.mode === "CUSTOMER" &&
    (snapshot.evaluation_cases.length > 0 || snapshot.case_binding !== null)
  ) {
    throw new FixAgentDomainError("CUSTOMER_SNAPSHOT_HAS_EVALUATION_CASES");
  }
  if (snapshot.case_binding) {
    const catalogEntry = snapshot.evaluation_cases.find(
      (evaluationCase) =>
        evaluationCase.evaluation_case_id ===
        snapshot.case_binding?.evaluation_case_id,
    );
    const excludedIssueIds = collectTargetRelatedIssueIds(
      snapshot.documents,
      snapshot.case_binding.target_issue_id,
    );
    if (
      !catalogEntry ||
      hashJson(catalogEntry) !== hashJson(snapshot.case_binding) ||
      snapshot.cutoff_at !== snapshot.case_binding.issue_created_at ||
      snapshot.documents.some(
        (document) =>
          document.case_content !== undefined &&
          excludedIssueIds.has(document.case_content.issue_id),
      )
    ) {
      throw new FixAgentDomainError("EVALUATION_CASE_BINDING_MISMATCH");
    }
  }
  if (
    snapshot.documents.some(
      (document) => Date.parse(document.source.published_at) > cutoff,
    )
  ) {
    throw new FixAgentDomainError("KNOWLEDGE_SOURCE_PUBLISHED_AFTER_CUTOFF");
  }
  if (
    snapshot.documents.some(
      (document) =>
        Date.parse(document.source.published_at) >
          Date.parse(document.source.retrieved_at) ||
        Date.parse(document.source.retrieved_at) >
          Date.parse(snapshot.created_at),
    )
  ) {
    throw new FixAgentDomainError("KNOWLEDGE_SOURCE_TIME_INVALID");
  }
  if (
    snapshot.documents.some(
      (document) =>
        (document.kind === "HISTORICAL_CASE") !==
          (document.document_type === "CASE_CONTENT") ||
        (document.kind === "HISTORICAL_CASE") !==
          (document.case_content !== undefined),
    )
  ) {
    throw new FixAgentDomainError("KNOWLEDGE_DOCUMENT_TYPE_MISMATCH");
  }

  const historicalContentIds = snapshot.documents.flatMap((document) =>
    document.case_content ? [document.case_content.content_id] : [],
  );
  if (new Set(historicalContentIds).size !== historicalContentIds.length) {
    throw new FixAgentDomainError("HISTORICAL_CASE_CONTENT_DUPLICATE_ID");
  }

  const documentKeys = snapshot.documents.map((document) =>
    referenceKey(document.knowledge_id, document.version),
  );
  if (new Set(documentKeys).size !== documentKeys.length) {
    throw new FixAgentDomainError("KNOWLEDGE_DUPLICATE_REFERENCE");
  }
  const documentKeySet = new Set(documentKeys);
  const documentsByKey = new Map(
    snapshot.documents.map((document) => [
      referenceKey(document.knowledge_id, document.version),
      document,
    ]),
  );

  const actionKeys = snapshot.action_cards.map((action) =>
    referenceKey(action.action_id, action.version),
  );
  if (new Set(actionKeys).size !== actionKeys.length) {
    throw new FixAgentDomainError("ACTION_CARD_DUPLICATE_REFERENCE");
  }
  const prohibitedPolicyIds = snapshot.prohibited_actions.map(
    (action) => action.policy_id,
  );
  if (new Set(prohibitedPolicyIds).size !== prohibitedPolicyIds.length) {
    throw new FixAgentDomainError("PROHIBITED_ACTION_DUPLICATE_ID");
  }
  const conflictIds = snapshot.knowledge_conflicts.map(
    (conflict) => conflict.conflict_id,
  );
  if (new Set(conflictIds).size !== conflictIds.length) {
    throw new FixAgentDomainError("KNOWLEDGE_CONFLICT_DUPLICATE_ID");
  }
  const actionIdSet = new Set(
    snapshot.action_cards.map((action) => action.action_id),
  );

  for (const conflict of snapshot.knowledge_conflicts) {
    const sourceKeys = conflict.source_refs.map((reference) =>
      referenceKey(reference.knowledge_id, reference.version),
    );
    if (
      new Set(sourceKeys).size !== sourceKeys.length ||
      sourceKeys.some((key) => !documentKeySet.has(key))
    ) {
      throw new FixAgentDomainError("KNOWLEDGE_CONFLICT_SOURCE_INVALID");
    }
    if (
      isApplicable(conflict.applicability, snapshot.product_context) &&
      sourceKeys.some((key) => {
        const source = documentsByKey.get(key);
        return !source || !isApplicable(source.applicability, snapshot.product_context);
      })
    ) {
      throw new FixAgentDomainError("KNOWLEDGE_CONFLICT_SOURCE_NOT_APPLICABLE");
    }
    if (
      conflict.blocked_action_ids.some(
        (actionId) => actionId !== "*" && !actionIdSet.has(actionId),
      )
    ) {
      throw new FixAgentDomainError("KNOWLEDGE_CONFLICT_ACTION_NOT_FOUND");
    }
    const resolutionIds = conflict.resolutions.map(
      (resolution) => resolution.resolution_id,
    );
    if (new Set(resolutionIds).size !== resolutionIds.length) {
      throw new FixAgentDomainError("KNOWLEDGE_CONFLICT_RESOLUTION_DUPLICATE_ID");
    }
    for (const resolution of conflict.resolutions) {
      const selectedKeys = resolution.selected_source_refs.map((reference) =>
        referenceKey(reference.knowledge_id, reference.version),
      );
      if (
        new Set(resolution.required_evidence_refs).size !==
          resolution.required_evidence_refs.length ||
        new Set(selectedKeys).size !== selectedKeys.length ||
        selectedKeys.some((key) => !sourceKeys.includes(key)) ||
        resolution.allowed_action_ids.some(
          (actionId) =>
            !actionIdSet.has(actionId) ||
            (!conflict.blocked_action_ids.includes("*") &&
              !conflict.blocked_action_ids.includes(actionId)),
        )
      ) {
        throw new FixAgentDomainError("KNOWLEDGE_CONFLICT_RESOLUTION_INVALID");
      }
    }
  }

  const applicableConflicts = snapshot.knowledge_conflicts.filter((conflict) =>
    isApplicable(conflict.applicability, snapshot.product_context),
  );
  const conflictSourceKeys = new Map(
    applicableConflicts.map((conflict) => [
      conflict.conflict_id,
      conflict.source_refs.map((reference) =>
        referenceKey(reference.knowledge_id, reference.version),
      ),
    ]),
  );
  const pendingConflictIds = new Set(
    applicableConflicts.map((conflict) => conflict.conflict_id),
  );
  while (pendingConflictIds.size > 0) {
    const seedConflictId = pendingConflictIds.values().next().value;
    if (typeof seedConflictId !== "string") break;
    const componentConflictIds = new Set([seedConflictId]);
    const componentSourceKeys = new Set(
      conflictSourceKeys.get(seedConflictId) ?? [],
    );
    let componentExpanded = true;
    while (componentExpanded) {
      componentExpanded = false;
      for (const conflictId of pendingConflictIds) {
        if (componentConflictIds.has(conflictId)) continue;
        const sourceKeys = conflictSourceKeys.get(conflictId) ?? [];
        if (!sourceKeys.some((key) => componentSourceKeys.has(key))) continue;
        componentConflictIds.add(conflictId);
        sourceKeys.forEach((key) => componentSourceKeys.add(key));
        componentExpanded = true;
      }
    }
    if (
      componentConflictIds.size > MAX_PUBLISHED_CONFLICT_REFS ||
      componentSourceKeys.size > MAX_PUBLISHED_CLAIM_REFS
    ) {
      throw new FixAgentDomainError("KNOWLEDGE_CONFLICT_COMPONENT_TOO_LARGE");
    }
    componentConflictIds.forEach((conflictId) =>
      pendingConflictIds.delete(conflictId),
    );
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
      throw new FixAgentDomainError("KNOWLEDGE_SOURCE_REFERENCE_NOT_FOUND");
    }
  }
  for (const action of snapshot.action_cards) {
    const source = documentsByKey.get(
      referenceKey(action.source_ref.knowledge_id, action.source_ref.version),
    );
    if (!source) continue;
    if (
      isApplicable(action.applicability, snapshot.product_context) &&
      !isApplicable(source.applicability, snapshot.product_context)
    ) {
      throw new FixAgentDomainError("ACTION_SOURCE_NOT_APPLICABLE");
    }
    if (
      action.risk_level === "LEVEL_2" &&
      (source.kind !== "PRODUCT_DOC" ||
        source.document_type !== "ACTION_SOP" ||
        !isExactProductAndVersion(
          action.applicability,
          snapshot.product_context,
        ) ||
        !isExactProductAndVersion(
          source.applicability,
          snapshot.product_context,
        ))
    ) {
      throw new FixAgentDomainError("LEVEL_2_ACTION_REQUIRES_EXACT_APPROVED_SOP");
    }
  }
  for (const prohibition of snapshot.prohibited_actions) {
    const source = documentsByKey.get(
      referenceKey(
        prohibition.source_ref.knowledge_id,
        prohibition.source_ref.version,
      ),
    );
    if (
      source &&
      isApplicable(prohibition.applicability, snapshot.product_context) &&
      !isApplicable(source.applicability, snapshot.product_context)
    ) {
      throw new FixAgentDomainError("PROHIBITED_ACTION_SOURCE_NOT_APPLICABLE");
    }
  }

  return snapshot;
};

export const materializeCaseKnowledgeSnapshot = (
  snapshot: KnowledgeSnapshot,
  evaluationCaseId: string,
): KnowledgeSnapshot => {
  if (snapshot.mode !== "EVALUATION") {
    throw new FixAgentDomainError("EVALUATION_CASE_MODE_REQUIRED");
  }
  if (snapshot.case_binding) {
    throw new FixAgentDomainError("EVALUATION_SNAPSHOT_ALREADY_CASE_BOUND");
  }
  const evaluationCase = snapshot.evaluation_cases.find(
    (candidate) => candidate.evaluation_case_id === evaluationCaseId,
  );
  if (!evaluationCase) {
    throw new FixAgentDomainError("EVALUATION_CASE_NOT_FOUND");
  }
  const cutoffAt = evaluationCase.issue_created_at;
  const parsedCutoff = Date.parse(cutoffAt);
  const excludedIssueIds = collectTargetRelatedIssueIds(
    snapshot.documents,
    evaluationCase.target_issue_id,
  );

  const documents = snapshot.documents.filter(
    (document) => {
      if (Date.parse(document.source.published_at) > parsedCutoff) return false;
      const content = document.case_content;
      return (
        !content ||
        (!excludedIssueIds.has(content.issue_id) &&
          !content.related_issue_ids.some((issueId) =>
            excludedIssueIds.has(issueId),
          ))
      );
    },
  );
  const documentKeys = new Set(
    documents.map((document) =>
      referenceKey(document.knowledge_id, document.version),
    ),
  );
  const sourceRemains = (entry: {
    source_ref: z.infer<typeof knowledgeReferenceShape>;
  }) =>
    documentKeys.has(
      referenceKey(entry.source_ref.knowledge_id, entry.source_ref.version),
    );
  const { content_hash: _contentHash, ...withoutHash } = snapshot;
  const actionCards = snapshot.action_cards.filter(sourceRemains);
  const availableActionIds = new Set(
    actionCards.map((action) => action.action_id),
  );
  const knowledgeConflicts = snapshot.knowledge_conflicts
    .filter((conflict) =>
      conflict.source_refs.every((reference) =>
        documentKeys.has(
          referenceKey(reference.knowledge_id, reference.version),
        ),
      ),
    )
    .map((conflict) => {
      const { content_hash: _conflictHash, ...conflictWithoutHash } = conflict;
      return withHash({
        ...conflictWithoutHash,
        blocked_action_ids: conflict.blocked_action_ids.filter(
          (actionId) => actionId === "*" || availableActionIds.has(actionId),
        ),
        resolutions: conflict.resolutions.map((resolution) => ({
          ...resolution,
          allowed_action_ids: resolution.allowed_action_ids.filter((actionId) =>
            availableActionIds.has(actionId),
          ),
        })),
      });
    });
  return parseKnowledgeSnapshot(
    withHash({
      ...withoutHash,
      snapshot_id: `${snapshot.snapshot_id}@${sha256(
        evaluationCase.evaluation_case_id,
      ).slice(0, 12)}`,
      cutoff_at: cutoffAt,
      case_binding: evaluationCase,
      documents,
      action_cards: actionCards,
      prohibited_actions: snapshot.prohibited_actions.filter(sourceRemains),
      knowledge_conflicts: knowledgeConflicts,
    }),
  );
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

const getApplicableKnowledgeConflictStates = (
  snapshot: KnowledgeSnapshot,
  evidenceRefs: string[],
) => {
  const availableEvidence = new Set(evidenceRefs);
  return snapshot.knowledge_conflicts
    .filter((conflict) =>
      isApplicable(conflict.applicability, snapshot.product_context),
    )
    .map((conflict) => {
      const matchingResolutions = conflict.resolutions.filter((resolution) =>
        resolution.required_evidence_refs.every((reference) =>
          availableEvidence.has(reference),
        ),
      );
      const resolution =
        matchingResolutions.length === 1 ? matchingResolutions[0] : undefined;
      return {
        ...conflict,
        resolution_status: resolution ? ("RESOLVED" as const) : ("UNRESOLVED" as const),
        matched_resolution: resolution ?? null,
      };
    });
};

export const getActionPolicy = (
  snapshot: KnowledgeSnapshot,
  evidenceRefs: string[],
): {
  action_cards: KnowledgeSnapshot["action_cards"];
  prohibited_actions: KnowledgeSnapshot["prohibited_actions"];
  knowledge_conflicts: ReturnType<
    typeof getApplicableKnowledgeConflictStates
  >;
} => {
  const availableEvidence = new Set(evidenceRefs);
  const prohibitedActions = snapshot.prohibited_actions.filter((action) =>
    isApplicable(action.applicability, snapshot.product_context),
  );
  const knowledgeConflicts = getApplicableKnowledgeConflictStates(
    snapshot,
    evidenceRefs,
  );
  const blockedActionIds = new Set(
    [
      ...prohibitedActions.flatMap((action) => action.blocked_action_ids),
      ...knowledgeConflicts
        .filter((conflict) => conflict.resolution_status === "UNRESOLVED")
        .flatMap((conflict) => conflict.blocked_action_ids),
    ],
  );
  return {
    action_cards: snapshot.action_cards.filter(
      (action) =>
        isApplicable(action.applicability, snapshot.product_context) &&
        !blockedActionIds.has("*") &&
        !blockedActionIds.has(action.action_id) &&
        knowledgeConflicts.every((conflict) => {
          if (conflict.resolution_status !== "RESOLVED") return true;
          const wasBlocked =
            conflict.blocked_action_ids.includes("*") ||
            conflict.blocked_action_ids.includes(action.action_id);
          return (
            !wasBlocked ||
            conflict.matched_resolution?.allowed_action_ids.includes(
              action.action_id,
            ) === true
          );
        }) &&
        action.prerequisite_evidence_refs.every((reference) =>
          availableEvidence.has(reference),
        ),
    ),
    prohibited_actions: prohibitedActions,
    knowledge_conflicts: knowledgeConflicts,
  };
};

export const validatePublishedCaseResponse = ({
  candidate,
  snapshot,
  caseKnowledgeSnapshotId,
  caseKnowledgeSnapshotHash,
  evidenceRefs,
}: {
  candidate: unknown;
  snapshot: KnowledgeSnapshot;
  caseKnowledgeSnapshotId: string;
  caseKnowledgeSnapshotHash: string;
  evidenceRefs: string[];
}): PublishedCaseResponse => {
  const response = publishedCaseResponseSchema.parse(candidate);
  if (snapshot.snapshot_id !== caseKnowledgeSnapshotId) {
    throw new FixAgentDomainError("FROZEN_KNOWLEDGE_SNAPSHOT_MISMATCH");
  }
  if (snapshot.content_hash !== caseKnowledgeSnapshotHash) {
    throw new FixAgentDomainError("FROZEN_KNOWLEDGE_SNAPSHOT_HASH_MISMATCH");
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
  const claimKeys = new Set(
    response.claim_refs.map((reference) =>
      referenceKey(reference.knowledge_id, reference.version),
    ),
  );
  for (const reference of response.claim_refs) {
    if (!documents.has(referenceKey(reference.knowledge_id, reference.version))) {
      throw new FixAgentDomainError(
        "KNOWLEDGE_REFERENCE_NOT_APPROVED_OR_APPLICABLE",
      );
    }
  }

  const conflictStates = getApplicableKnowledgeConflictStates(
    snapshot,
    evidenceRefs,
  );
  const conflictsById = new Map(
    conflictStates.map((conflict) => [conflict.conflict_id, conflict]),
  );
  const acknowledgedConflictIds = new Set(
    response.knowledge_conflict_refs ?? [],
  );
  if (
    [...acknowledgedConflictIds].some(
      (conflictId) => !conflictsById.has(conflictId),
    )
  ) {
    throw new FixAgentDomainError("KNOWLEDGE_CONFLICT_REFERENCE_INVALID");
  }
  for (const conflict of conflictStates) {
    const sourceKeys = conflict.source_refs.map((reference) =>
      referenceKey(reference.knowledge_id, reference.version),
    );
    const citedSourceKeys = sourceKeys.filter((key) => claimKeys.has(key));
    if (conflict.resolution_status === "UNRESOLVED") {
      if (
        (citedSourceKeys.length > 0 ||
          acknowledgedConflictIds.has(conflict.conflict_id)) &&
        (!acknowledgedConflictIds.has(conflict.conflict_id) ||
          citedSourceKeys.length !== sourceKeys.length)
      ) {
        throw new FixAgentDomainError(
          "KNOWLEDGE_CONFLICT_ACKNOWLEDGEMENT_REQUIRED",
        );
      }
      continue;
    }
    const selectedSourceKeys = new Set(
      conflict.matched_resolution?.selected_source_refs.map((reference) =>
        referenceKey(reference.knowledge_id, reference.version),
      ) ?? [],
    );
    if (citedSourceKeys.some((key) => !selectedSourceKeys.has(key))) {
      throw new FixAgentDomainError(
        "KNOWLEDGE_CONFLICT_RESOLUTION_SOURCE_MISMATCH",
      );
    }
  }

  const applicableActions = new Map(
    getActionPolicy(snapshot, evidenceRefs).action_cards.map((action) => [
      referenceKey(action.action_id, action.version),
      action,
    ]),
  );
  for (const reference of response.action_card_refs) {
    if (
      !applicableActions.has(
        referenceKey(reference.action_id, reference.version),
      )
    ) {
      throw new FixAgentDomainError("ACTION_CARD_NOT_APPROVED_OR_APPLICABLE");
    }
  }

  return response;
};

export const EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT = createKnowledgeSnapshot({
  snapshot_id: "EMPTY_EVAL_V0",
  mode: "EVALUATION",
  created_at: "2026-09-23T00:00:00.000Z",
  cutoff_at: "2026-09-22T23:59:59.999Z",
  evaluation_cases: [],
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
  knowledge_conflicts: [],
});
