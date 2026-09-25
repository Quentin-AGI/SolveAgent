import { z } from "zod";

export const MAX_PUBLISHED_CLAIM_REFS = 20;
export const MAX_PUBLISHED_CONFLICT_REFS = 8;
export const MAX_PUBLISHED_EVIDENCE_REFS = 20;

export const knowledgeReferenceShape = z
  .object({
    knowledge_id: z.string().trim().min(1),
    version: z.string().trim().min(1),
  })
  .strict();

export const actionCardReferenceShape = z
  .object({
    action_id: z.string().trim().min(1),
    version: z.string().trim().min(1),
  })
  .strict();

export const publishedCaseResponseShape = {
  message_markdown: z
    .string()
    .min(1)
    .max(16_000)
    .describe("The exact Markdown response that the user will see"),
  claim_refs: z
    .array(knowledgeReferenceShape)
    .max(MAX_PUBLISHED_CLAIM_REFS)
    .describe("Approved Knowledge references supporting product claims"),
  evidence_refs: z
    .array(z.string().trim().min(1).max(240))
    .max(MAX_PUBLISHED_EVIDENCE_REFS)
    .optional()
    .describe("Exact Case-issued evidence references supporting current-Case claims"),
  action_card_refs: z
    .array(actionCardReferenceShape)
    .max(8)
    .describe("Applicable approved Action Cards used by the response"),
  knowledge_conflict_refs: z
    .array(z.string().trim().min(1))
    .max(MAX_PUBLISHED_CONFLICT_REFS)
    .optional()
    .describe("Unresolved approved Knowledge conflicts acknowledged by the response"),
  response_type: z.enum([
    "GENERAL",
    "EVIDENCE_REQUEST",
    "INFORMATION",
    "ACTION",
  ]),
};

export const publishedCaseResponseSchema = z
  .object(publishedCaseResponseShape)
  .strict()
  .superRefine((response, context) => {
    const claimKeys = response.claim_refs.map(
      (reference) =>
        JSON.stringify([reference.knowledge_id, reference.version]),
    );
    if (new Set(claimKeys).size !== claimKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["claim_refs"],
        message: "Duplicate Knowledge references are not allowed",
      });
    }

    const actionKeys = response.action_card_refs.map(
      (reference) =>
        JSON.stringify([reference.action_id, reference.version]),
    );
    if (new Set(actionKeys).size !== actionKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["action_card_refs"],
        message: "Duplicate Action Card references are not allowed",
      });
    }

    const conflictIds = response.knowledge_conflict_refs ?? [];
    if (new Set(conflictIds).size !== conflictIds.length) {
      context.addIssue({
        code: "custom",
        path: ["knowledge_conflict_refs"],
        message: "Duplicate Knowledge conflict references are not allowed",
      });
    }

    const evidenceRefs = response.evidence_refs ?? [];
    if (new Set(evidenceRefs).size !== evidenceRefs.length) {
      context.addIssue({
        code: "custom",
        path: ["evidence_refs"],
        message: "Duplicate Case evidence references are not allowed",
      });
    }

    if (
      response.response_type === "INFORMATION" &&
      response.claim_refs.length === 0 &&
      evidenceRefs.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["claim_refs"],
        message: "Information responses require approved Knowledge or issued Case evidence",
      });
    }
    if (
      response.response_type === "ACTION" &&
      response.action_card_refs.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["action_card_refs"],
        message: "Action responses require an approved Action Card",
      });
    }
    if (
      response.response_type !== "ACTION" &&
      response.action_card_refs.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["action_card_refs"],
        message: "Only action responses may reference Action Cards",
      });
    }
    if (
      response.response_type === "GENERAL" &&
      (response.claim_refs.length > 0 ||
        evidenceRefs.length > 0 ||
        (response.knowledge_conflict_refs?.length ?? 0) > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["response_type"],
        message: "General responses cannot make approved Knowledge claims",
      });
    }
  });

export type PublishedCaseResponse = z.infer<
  typeof publishedCaseResponseSchema
>;
