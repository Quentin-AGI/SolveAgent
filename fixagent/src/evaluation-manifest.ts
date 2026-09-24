import { createHash } from "node:crypto";

import { z } from "zod";

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

const identifierSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    "Identifiers cannot have surrounding whitespace",
  );

const evaluationManifestWithoutHashSchema = z
  .object({
    schema_version: z.literal("fixagent.evaluation-manifest.v0"),
    benchmark_id: identifierSchema,
    created_at: z.string().datetime(),
    source: z
      .object({
        name: z.string().trim().min(1),
        uri: z.string().url(),
        license: z.string().trim().min(1),
        content_hash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    approval: z
      .object({
        status: z.literal("EVAL_APPROVED"),
        approved_by: z.string().trim().min(1),
        approved_at: z.string().datetime(),
        authority: z.literal("EVALUATION_DATA_OWNER"),
      })
      .strict(),
    cases: z
      .array(
        z
          .object({
            evaluation_case_id: identifierSchema,
            target_issue_id: identifierSchema,
            runtime_snapshot: z
              .object({
                snapshot_id: identifierSchema,
                content_hash: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict(),
            prompt: z.string().trim().min(1),
            expected: z
              .object({
                standard_answer: z.string().trim().min(1),
                fault_classifications: z.array(
                  z
                    .string()
                    .trim()
                    .min(1)
                    .refine(
                      (value) => /[\p{L}\p{N}]/u.test(value),
                      "Fault classifications must contain text",
                    ),
                ),
                allowed_steps: z.array(z.string().trim().min(1)).min(1),
              })
              .strict(),
            rubric: z
              .object({
                type: z.literal("ALLOWED_STEP_COVERAGE"),
                pass_threshold: z.number().min(0).max(1),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const evaluationManifestSchema = evaluationManifestWithoutHashSchema
  .extend({
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type EvaluationManifestInput = Omit<
  z.input<typeof evaluationManifestWithoutHashSchema>,
  "schema_version"
>;
export type EvaluationManifest = z.infer<typeof evaluationManifestSchema>;

const assertUniqueCases = (manifest: EvaluationManifest): void => {
  const caseIds = manifest.cases.map((entry) => entry.evaluation_case_id);
  const targetIds = manifest.cases.map((entry) => entry.target_issue_id);
  if (
    new Set(caseIds).size !== caseIds.length ||
    new Set(targetIds).size !== targetIds.length
  ) {
    throw new Error("EVALUATION_MANIFEST_DUPLICATE_CASE");
  }
};

export const createEvaluationManifest = (
  input: EvaluationManifestInput,
): EvaluationManifest => {
  const withoutHash = evaluationManifestWithoutHashSchema.parse({
    schema_version: "fixagent.evaluation-manifest.v0",
    ...input,
  });
  const manifest = evaluationManifestSchema.parse({
    ...withoutHash,
    content_hash: hashJson(withoutHash),
  });
  assertUniqueCases(manifest);
  return manifest;
};

export const parseEvaluationManifest = (
  candidate: unknown,
): EvaluationManifest => {
  const manifest = evaluationManifestSchema.parse(candidate);
  const { content_hash: contentHash, ...withoutHash } = manifest;
  if (hashJson(withoutHash) !== contentHash) {
    throw new Error("EVALUATION_MANIFEST_HASH_MISMATCH");
  }
  assertUniqueCases(manifest);
  return manifest;
};

const normalizeForCoverage = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");

export interface EvaluationScore {
  evaluation_case_id: string;
  matched_step_indexes: number[];
  missed_step_indexes: number[];
  matched_fault_classifications: string[];
  classification_passed: boolean;
  coverage: number;
  passed: boolean;
}

const hasNonNegatedMention = (
  normalizedResponse: string,
  normalizedExpected: string,
): boolean => {
  let offset = normalizedResponse.indexOf(normalizedExpected);
  while (offset >= 0) {
    const prefix = normalizedResponse.slice(Math.max(0, offset - 16), offset);
    if (
      !/(?:不要|不应|不能|不可|不建议|禁止|避免|无需|切勿|donot|dont|never|avoid)$/u.test(
        prefix,
      )
    ) {
      return true;
    }
    offset = normalizedResponse.indexOf(
      normalizedExpected,
      offset + normalizedExpected.length,
    );
  }
  return false;
};

export const scoreEvaluationResponse = ({
  manifest: candidate,
  evaluationCaseId,
  responseText,
}: {
  manifest: unknown;
  evaluationCaseId: string;
  responseText: string;
}): EvaluationScore => {
  const manifest = parseEvaluationManifest(candidate);
  const evaluationCase = manifest.cases.find(
    (entry) => entry.evaluation_case_id === evaluationCaseId,
  );
  if (!evaluationCase) throw new Error("EVALUATION_CASE_NOT_FOUND");

  const normalizedResponse = normalizeForCoverage(responseText);
  const matchedStepIndexes: number[] = [];
  const missedStepIndexes: number[] = [];
  evaluationCase.expected.allowed_steps.forEach((step, index) => {
    const normalizedStep = normalizeForCoverage(step);
    if (
      normalizedStep &&
      hasNonNegatedMention(normalizedResponse, normalizedStep)
    ) {
      matchedStepIndexes.push(index);
    } else {
      missedStepIndexes.push(index);
    }
  });
  const coverage =
    matchedStepIndexes.length / evaluationCase.expected.allowed_steps.length;
  const matchedFaultClassifications =
    evaluationCase.expected.fault_classifications.filter((classification) =>
      hasNonNegatedMention(
        normalizedResponse,
        normalizeForCoverage(classification),
      ),
    );
  const classificationPassed =
    evaluationCase.expected.fault_classifications.length === 0 ||
    matchedFaultClassifications.length > 0;
  return {
    evaluation_case_id: evaluationCaseId,
    matched_step_indexes: matchedStepIndexes,
    missed_step_indexes: missedStepIndexes,
    matched_fault_classifications: matchedFaultClassifications,
    classification_passed: classificationPassed,
    coverage,
    passed:
      coverage >= evaluationCase.rubric.pass_threshold &&
      classificationPassed,
  };
};
