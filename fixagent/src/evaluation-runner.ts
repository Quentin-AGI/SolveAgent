import { randomUUID } from "node:crypto";

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
  fetchImpl = fetch,
}: {
  baseUrl: string;
  manifest: EvaluationManifest | unknown;
  providerProfileId?: string;
  evaluationCaseIds?: string[];
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
