import { createHash } from "node:crypto";

import { z } from "zod";

import {
  createEvaluationManifest,
  type EvaluationManifest,
} from "./evaluation-manifest.js";
import {
  createKnowledgeSnapshot,
  materializeCaseKnowledgeSnapshot,
  type KnowledgeSnapshot,
  type ProductContext,
} from "./knowledge-store.js";

const cambFaultTreeRecordSchema = z
  .object({
    prompt: z.string().trim().min(1),
    gold_list: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export interface CambFaultTreeConversionOptions {
  snapshotId: string;
  benchmarkId: string;
  importedAt: string;
  approvedBy: string;
  sourceUri: string;
  productContext: ProductContext;
  passThreshold?: number;
}

export interface CambFaultTreeConversion {
  knowledgeSnapshot: KnowledgeSnapshot;
  evaluationManifest: EvaluationManifest;
}

const parseJsonl = (source: string) => {
  const records = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        const result = cambFaultTreeRecordSchema.safeParse(JSON.parse(line));
        if (!result.success) throw result.error;
        return result.data;
      } catch {
        throw new Error(`CAMB_RECORD_INVALID: line ${index + 1}`);
      }
    });
  if (records.length === 0) throw new Error("CAMB_DATASET_EMPTY");
  if (new Set(records.map((record) => record.prompt)).size !== records.length) {
    throw new Error("CAMB_RECORD_DUPLICATE_PROMPT");
  }
  return records;
};

export const convertCambFaultTreeJsonl = (
  source: string,
  options: CambFaultTreeConversionOptions,
): CambFaultTreeConversion => {
  const records = parseJsonl(source);
  const caseCatalog = records.map((_, index) => {
    const suffix = String(index + 1).padStart(4, "0");
    return {
      evaluation_case_id: `CAMB-FAULT-TREE-${suffix}`,
      target_issue_id: `CAMB-FAULT-TREE-SOURCE-${suffix}`,
      issue_created_at: options.importedAt,
    };
  });
  const knowledgeSnapshot = createKnowledgeSnapshot({
    snapshot_id: options.snapshotId,
    mode: "EVALUATION",
    created_at: options.importedAt,
    cutoff_at: options.importedAt,
    evaluation_cases: caseCatalog,
    product_context: options.productContext,
    documents: [],
    action_cards: [],
    prohibited_actions: [],
    knowledge_conflicts: [],
  });
  const evaluationManifest = createEvaluationManifest({
    benchmark_id: options.benchmarkId,
    created_at: options.importedAt,
    source: {
      name: "CAMB faultTree",
      uri: options.sourceUri,
      license: "CC0-1.0",
      content_hash: createHash("sha256").update(source).digest("hex"),
    },
    approval: {
      status: "EVAL_APPROVED",
      approved_by: options.approvedBy,
      approved_at: options.importedAt,
      authority: "EVALUATION_DATA_OWNER",
    },
    cases: records.map((record, index) => {
      const catalogEntry = caseCatalog[index]!;
      const runtimeSnapshot = materializeCaseKnowledgeSnapshot(
        knowledgeSnapshot,
        catalogEntry.evaluation_case_id,
      );
      return {
        evaluation_case_id: catalogEntry.evaluation_case_id,
        target_issue_id: catalogEntry.target_issue_id,
        runtime_snapshot: {
          snapshot_id: runtimeSnapshot.snapshot_id,
          content_hash: runtimeSnapshot.content_hash,
        },
        prompt: record.prompt,
        expected: {
          standard_answer: record.gold_list
            .map((step, stepIndex) => `${stepIndex + 1}. ${step}`)
            .join("\n"),
          // CAMB faultTree provides next-step gold items, not fault labels.
          fault_classifications: [],
          allowed_steps: record.gold_list,
        },
        rubric: {
          type: "ALLOWED_STEP_COVERAGE",
          pass_threshold: options.passThreshold ?? 0.5,
        },
      };
    }),
  });
  return { knowledgeSnapshot, evaluationManifest };
};
