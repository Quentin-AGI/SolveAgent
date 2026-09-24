import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

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

const relativeAssetPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((segment) => segment && segment !== "." && segment !== ".."),
    "VisA asset paths must stay inside the evaluation asset root",
  );

const visaPcbSelectionSchema = z
  .object({
    schema_version: z.literal("fixagent.visa-pcb-selection.v0"),
    source_revision: z.string().regex(/^[a-f0-9]{40}$/),
    records: z
      .array(
        z
          .object({
            source_id: z.string().regex(/^pcb[1-4]-(?:anomaly|normal)-\d{3,4}$/),
            pcb: z.enum(["pcb1", "pcb2", "pcb3", "pcb4"]),
            condition: z.enum(["NORMAL", "ANOMALY"]),
            image_relative_path: relativeAssetPathSchema,
            mask_relative_path: relativeAssetPathSchema.optional(),
            defect_labels_en: z.array(z.string().trim().min(1)),
            defect_labels_zh: z.array(z.string().trim().min(1)),
          })
          .strict()
          .superRefine((record, context) => {
            const expectedSourcePrefix = `${record.pcb}-${record.condition.toLocaleLowerCase()}-`;
            if (!record.source_id.startsWith(expectedSourcePrefix)) {
              context.addIssue({
                code: "custom",
                path: ["source_id"],
                message: "VisA source ID must match its PCB and condition",
              });
            }
            if (record.condition === "ANOMALY") {
              if (!record.mask_relative_path) {
                context.addIssue({
                  code: "custom",
                  path: ["mask_relative_path"],
                  message: "An anomalous VisA record requires a mask",
                });
              }
              if (
                record.defect_labels_en.length === 0 ||
                record.defect_labels_zh.length === 0 ||
                record.defect_labels_en.length !== record.defect_labels_zh.length
              ) {
                context.addIssue({
                  code: "custom",
                  path: ["defect_labels_en"],
                  message: "An anomalous VisA record requires aligned defect labels",
                });
              }
            } else if (
              record.mask_relative_path ||
              record.defect_labels_en.length > 0 ||
              record.defect_labels_zh.length > 0
            ) {
              context.addIssue({
                code: "custom",
                message: "A normal VisA record cannot contain anomaly ground truth",
              });
            }
          }),
      )
      .min(1),
  })
  .strict();

export type VisaPcbSelection = z.input<typeof visaPcbSelectionSchema>;

export interface VisaPcbConversionOptions {
  assetRoot: string;
  snapshotId: string;
  benchmarkId: string;
  importedAt: string;
  approvedBy: string;
  sourceUri: string;
  productContext: ProductContext;
  passThreshold?: number;
}

export interface VisaPcbConversion {
  knowledgeSnapshot: KnowledgeSnapshot;
  evaluationManifest: EvaluationManifest;
}

const readAssetInsideRoot = async (
  assetRoot: string,
  relativePath: string,
): Promise<Buffer> => {
  const assetPath = await realpath(resolve(assetRoot, relativePath));
  const pathWithinRoot = relative(assetRoot, assetPath);
  if (
    pathWithinRoot === ".." ||
    pathWithinRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathWithinRoot)
  ) {
    throw new Error("VISA_ASSET_OUTSIDE_ROOT");
  }
  return readFile(assetPath);
};

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export const convertVisaPcbSelection = async (
  candidate: unknown,
  options: VisaPcbConversionOptions,
): Promise<VisaPcbConversion> => {
  const selection = visaPcbSelectionSchema.parse(candidate);
  const sourceIds = selection.records.map((record) => record.source_id);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("VISA_SELECTION_DUPLICATE_SOURCE_ID");
  }
  const imagePaths = selection.records.map(
    (record) => record.image_relative_path,
  );
  if (new Set(imagePaths).size !== imagePaths.length) {
    throw new Error("VISA_SELECTION_DUPLICATE_IMAGE");
  }

  const assetRoot = await realpath(options.assetRoot);
  const materializedRecords = await Promise.all(
    selection.records.map(async (record) => {
      const imageBytes = await readAssetInsideRoot(
        assetRoot,
        record.image_relative_path,
      );
      if (imageBytes.length === 0 || imageBytes.length > 4 * 1024 * 1024) {
        throw new Error("VISA_IMAGE_SIZE_INVALID");
      }
      const maskBytes = record.mask_relative_path
        ? await readAssetInsideRoot(assetRoot, record.mask_relative_path)
        : undefined;
      return {
        record,
        imageHash: sha256(imageBytes),
        ...(maskBytes ? { maskHash: sha256(maskBytes) } : {}),
      };
    }),
  );

  const caseCatalog = materializedRecords.map((entry, index) => {
    const suffix = String(index + 1).padStart(4, "0");
    return {
      evaluation_case_id: `VISA-PCB-${suffix}`,
      target_issue_id: `VISA-PCB-SOURCE-${suffix}`,
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
  const sourceContentHash = sha256(
    JSON.stringify({
      selection,
      files: materializedRecords.map(({ record, imageHash, maskHash }) => ({
        source_id: record.source_id,
        image_hash: imageHash,
        ...(maskHash ? { mask_hash: maskHash } : {}),
      })),
    }),
  );

  const evaluationManifest = createEvaluationManifest({
    benchmark_id: options.benchmarkId,
    created_at: options.importedAt,
    source: {
      name: "VisA PCB subset",
      uri: options.sourceUri,
      license: "CC-BY-4.0",
      content_hash: sourceContentHash,
    },
    approval: {
      status: "EVAL_APPROVED",
      approved_by: options.approvedBy,
      approved_at: options.importedAt,
      authority: "EVALUATION_DATA_OWNER",
    },
    cases: materializedRecords.map(({ record, imageHash }, index) => {
      const catalogEntry = caseCatalog[index]!;
      const runtimeSnapshot = materializeCaseKnowledgeSnapshot(
        knowledgeSnapshot,
        catalogEntry.evaluation_case_id,
      );
      const isAnomaly = record.condition === "ANOMALY";
      const faultClassifications = isAnomaly
        ? [...record.defect_labels_zh, ...record.defect_labels_en]
        : ["未发现明显异常", "未见明显异常", "正常"];
      const allowedSteps = isAnomaly
        ? ["停止使用", "人工复检"]
        : ["功能检测", "继续观察"];
      const standardAnswer = isAnomaly
        ? `可见异常：${record.defect_labels_zh.join("、")}。停止使用该电路板并由专业人员人工复检；仅凭照片不能确认内部根因。`
        : "未发现明显外观异常。完成基础功能检测并继续观察；仅凭照片不能确认内部电气状态。";
      return {
        evaluation_case_id: catalogEntry.evaluation_case_id,
        target_issue_id: catalogEntry.target_issue_id,
        runtime_snapshot: {
          snapshot_id: runtimeSnapshot.snapshot_id,
          content_hash: runtimeSnapshot.content_hash,
        },
        attachments: [
          {
            name: basename(record.image_relative_path),
            media_type: "image/jpeg" as const,
            relative_path: record.image_relative_path,
            content_hash: imageHash,
          },
        ],
        prompt:
          "请检查这张 PCB 照片，指出可见异常及其大致位置，说明当前是否应继续使用，并给出下一步安全检查建议。不要仅凭照片猜测不可见的内部故障。",
        expected: {
          standard_answer: standardAnswer,
          fault_classifications: faultClassifications,
          allowed_steps: allowedSteps,
        },
        rubric: {
          type: "ALLOWED_STEP_COVERAGE" as const,
          pass_threshold: options.passThreshold ?? 0.5,
        },
      };
    }),
  });
  return { knowledgeSnapshot, evaluationManifest };
};
