import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  parseEvaluationManifest,
  scoreEvaluationResponse,
  type EvaluationManifest,
  type EvaluationScore,
} from "./evaluation-manifest.js";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const createdCaseSchema = z
  .object({
    case_id: z.string().min(1),
    knowledge_snapshot_id: z.string().min(1),
    knowledge_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough();

const publishedResponseSchema = z
  .object({
    response: z
      .object({
        message_markdown: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const maxEvaluationAttachmentBytes = 4 * 1024 * 1024;
const maxEvaluationAttachmentTotalBytes = 8 * 1024 * 1024;

const loadEvaluationAttachments = async ({
  evaluationCase,
  evaluationAssetRoot,
}: {
  evaluationCase: EvaluationManifest["cases"][number];
  evaluationAssetRoot?: string;
}) => {
  const attachments = evaluationCase.attachments ?? [];
  if (attachments.length === 0) return [];
  if (!evaluationAssetRoot) throw new Error("EVALUATION_ASSET_ROOT_REQUIRED");

  const assetRoot = await realpath(evaluationAssetRoot);
  const loadedAttachments = await Promise.all(
    attachments.map(async (attachment) => {
      const attachmentPath = await realpath(
        resolve(assetRoot, attachment.relative_path),
      );
      const pathWithinRoot = relative(assetRoot, attachmentPath);
      if (
        pathWithinRoot === ".." ||
        pathWithinRoot.startsWith(`..${sep}`) ||
        isAbsolute(pathWithinRoot)
      ) {
        throw new Error("EVALUATION_ATTACHMENT_OUTSIDE_ROOT");
      }
      const bytes = await readFile(attachmentPath);
      if (bytes.length === 0 || bytes.length > maxEvaluationAttachmentBytes) {
        throw new Error("EVALUATION_ATTACHMENT_SIZE_INVALID");
      }
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      if (contentHash !== attachment.content_hash) {
        throw new Error("EVALUATION_ATTACHMENT_HASH_MISMATCH");
      }
      return {
        byteLength: bytes.length,
        payload: {
          name: attachment.name,
          media_type: attachment.media_type,
          data_base64: bytes.toString("base64"),
        },
      };
    }),
  );
  if (
    loadedAttachments.reduce(
      (total, attachment) => total + attachment.byteLength,
      0,
    ) > maxEvaluationAttachmentTotalBytes
  ) {
    throw new Error("EVALUATION_ATTACHMENT_TOTAL_SIZE_INVALID");
  }
  return loadedAttachments.map((attachment) => attachment.payload);
};

export interface EvaluationCaseResult {
  evaluation_case_id: string;
  case_id: string;
  response_markdown: string;
  score: EvaluationScore;
}

export interface EvaluationReport {
  schema_version: "fixagent.evaluation-report.v0";
  benchmark_id: string;
  total_cases: number;
  passed_cases: number;
  pass_rate: number;
  results: EvaluationCaseResult[];
}

const checkedJson = async (response: Response, operation: string) => {
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`${operation}_FAILED: HTTP ${response.status}`);
  }
  return body;
};

export const runEvaluation = async ({
  baseUrl,
  manifest: candidate,
  providerProfileId,
  evaluationCaseIds,
  evaluationAssetRoot,
  fetchImpl = fetch,
}: {
  baseUrl: string;
  manifest: EvaluationManifest | unknown;
  providerProfileId?: string;
  evaluationCaseIds?: string[];
  evaluationAssetRoot?: string;
  fetchImpl?: FetchLike;
}): Promise<EvaluationReport> => {
  const manifest = parseEvaluationManifest(candidate);
  const requestedIds = evaluationCaseIds
    ? new Set(evaluationCaseIds)
    : undefined;
  const cases = requestedIds
    ? manifest.cases.filter((entry) =>
        requestedIds.has(entry.evaluation_case_id),
      )
    : manifest.cases;
  if (requestedIds && cases.length !== requestedIds.size) {
    throw new Error("EVALUATION_CASE_NOT_FOUND");
  }
  if (cases.length === 0) throw new Error("EVALUATION_SELECTION_EMPTY");

  const endpoint = new URL(baseUrl);
  const results: EvaluationCaseResult[] = [];
  for (const evaluationCase of cases) {
    const attachments = await loadEvaluationAttachments({
      evaluationCase,
      ...(evaluationAssetRoot ? { evaluationAssetRoot } : {}),
    });
    const createResponse = await fetchImpl(new URL("/api/cases", endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evaluation_case_id: evaluationCase.evaluation_case_id,
        ...(providerProfileId
          ? { provider_profile_id: providerProfileId }
          : {}),
      }),
    });
    const createdCase = createdCaseSchema.parse(
      await checkedJson(createResponse, "EVALUATION_CASE_CREATE"),
    );
    if (
      createdCase.knowledge_snapshot_id !==
        evaluationCase.runtime_snapshot.snapshot_id ||
      createdCase.knowledge_snapshot_hash !==
        evaluationCase.runtime_snapshot.content_hash
    ) {
      throw new Error("EVALUATION_KNOWLEDGE_SNAPSHOT_MISMATCH");
    }
    const messageResponse = await fetchImpl(
      new URL(`/api/cases/${createdCase.case_id}/messages`, endpoint),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: evaluationCase.prompt,
          idempotency_key: randomUUID(),
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      },
    );
    const published = publishedResponseSchema.parse(
      await checkedJson(messageResponse, "EVALUATION_CASE_MESSAGE"),
    );
    const responseMarkdown = published.response.message_markdown;
    results.push({
      evaluation_case_id: evaluationCase.evaluation_case_id,
      case_id: createdCase.case_id,
      response_markdown: responseMarkdown,
      score: scoreEvaluationResponse({
        manifest,
        evaluationCaseId: evaluationCase.evaluation_case_id,
        responseText: responseMarkdown,
      }),
    });
  }
  const passedCases = results.filter((result) => result.score.passed).length;
  return {
    schema_version: "fixagent.evaluation-report.v0",
    benchmark_id: manifest.benchmark_id,
    total_cases: results.length,
    passed_cases: passedCases,
    pass_rate: passedCases / results.length,
    results,
  };
};
