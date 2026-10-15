import { createHash } from "node:crypto";

import { z } from "zod";

import type { KnowledgeDocumentInput } from "./knowledge-store.js";

const trajectorySchema = z
  .object({
    case_id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    timeline: z
      .array(
        z
          .object({
            sequence: z.number().int().positive(),
            phase: z.enum([
              "SYMPTOM",
              "HYPOTHESIS",
              "FINDING",
              "ACTION",
              "RESULT",
              "RESOLUTION",
            ]),
            text: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
    root_cause: z.string().trim().min(1).optional(),
    resolution: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).default([]),
    related_case_ids: z.array(z.string().trim().min(1)).default([]),
    source: z
      .object({
        uri: z.string().url(),
        title: z.string().trim().min(1),
        published_at: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

const raftTrajectoryImportOptionsSchema = z
  .object({
    version: z.string().trim().min(1),
    retrievedAt: z.string().datetime(),
    approvedBy: z.string().trim().min(1),
    approvedAt: z.string().datetime(),
    approvalStatus: z.enum(["EVAL_APPROVED", "PRODUCTION_APPROVED"]),
    approvalAuthority: z.enum([
      "EVALUATION_DATA_OWNER",
      "SKU_MANUFACTURER",
      "DOMAIN_OWNER",
    ]),
    applicability: z
      .object({
        configuration_ids: z.array(z.string().trim().min(1)).min(1),
        software_versions: z.array(z.string().trim().min(1)).min(1),
        regions: z.array(z.string().trim().min(1)).min(1),
      })
      .strict(),
  })
  .strict();

export type RaftTrajectoryImportOptions = z.infer<
  typeof raftTrajectoryImportOptionsSchema
>;

export const parseRaftTrajectoryImportOptions = (
  candidate: unknown,
): RaftTrajectoryImportOptions =>
  raftTrajectoryImportOptionsSchema.parse(candidate);

const hashRecord = (record: unknown): string =>
  createHash("sha256").update(JSON.stringify(record)).digest("hex");

const renderTrajectory = (trajectory: z.infer<typeof trajectorySchema>) => {
  const sections = [
    `## Summary\n${trajectory.summary}`,
    `## Timeline\n${trajectory.timeline
      .map(
        (entry) =>
          `${entry.sequence}. [${entry.phase}] ${entry.text}`,
      )
      .join("\n")}`,
  ];
  if (trajectory.root_cause) {
    sections.push(`## Root Cause\n${trajectory.root_cause}`);
  }
  if (trajectory.resolution) {
    sections.push(`## Resolution\n${trajectory.resolution}`);
  }
  return sections.join("\n\n");
};

export const importRaftTrajectoryJsonl = (
  source: string,
  options: RaftTrajectoryImportOptions,
): KnowledgeDocumentInput[] => {
  const parsedOptions = parseRaftTrajectoryImportOptions(options);
  const trajectories = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      let trajectory: z.infer<typeof trajectorySchema>;
      try {
        trajectory = trajectorySchema.parse(JSON.parse(line));
      } catch {
        throw new Error(`RAFT_TRAJECTORY_INVALID: line ${index + 1}`);
      }
      if (
        trajectory.timeline.some(
          (entry, entryIndex) => entry.sequence !== entryIndex + 1,
        )
      ) {
        throw new Error(
          `RAFT_TIMELINE_SEQUENCE_INVALID: line ${index + 1}`,
        );
      }
      return trajectory;
    });
  if (trajectories.length === 0) throw new Error("RAFT_TRAJECTORY_DATASET_EMPTY");
  if (
    new Set(trajectories.map((trajectory) => trajectory.case_id)).size !==
    trajectories.length
  ) {
    throw new Error("RAFT_TRAJECTORY_DUPLICATE_CASE");
  }

  return trajectories.map((trajectory) => ({
    knowledge_id: `RAFT-${trajectory.case_id}`,
    version: parsedOptions.version,
    kind: "HISTORICAL_CASE",
    document_type: "CASE_CONTENT",
    title: trajectory.title,
    text: renderTrajectory(trajectory),
    tags: ["raft-trajectory", ...trajectory.tags],
    applicability: parsedOptions.applicability,
    case_content: {
      issue_id: trajectory.case_id,
      content_id: `${trajectory.case_id}:raft-trajectory:${parsedOptions.version}`,
      content_role: "SOLUTION",
      related_issue_ids: trajectory.related_case_ids,
    },
    source: {
      ...trajectory.source,
      retrieved_at: parsedOptions.retrievedAt,
      source_content_hash: hashRecord(trajectory),
    },
    approval_status: parsedOptions.approvalStatus,
    approved_by: parsedOptions.approvedBy,
    approved_at: parsedOptions.approvedAt,
    approval_authority: parsedOptions.approvalAuthority,
  }));
};
