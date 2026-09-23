import { z } from "zod";

/**
 * V0's first tracer slice has no approved Knowledge or Action Card store yet.
 * It may therefore publish evidence requests only. The contract expands only
 * after reference validation exists at the publication boundary.
 */
export const publishedCaseResponseShape = {
  message_markdown: z
    .string()
    .min(1)
    .describe("The exact Markdown evidence request that the user will see"),
  claim_refs: z
    .array(z.string())
    .max(0)
    .describe("Must remain empty until approved Knowledge validation exists"),
  action_card_refs: z
    .array(z.string())
    .max(0)
    .describe("Must remain empty until approved Action Card validation exists"),
  response_type: z.literal("EVIDENCE_REQUEST"),
};

export const publishedCaseResponseSchema = z.object(
  publishedCaseResponseShape,
);

export type PublishedCaseResponse = z.infer<
  typeof publishedCaseResponseSchema
>;
