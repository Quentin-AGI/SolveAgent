import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const visibleMessageSchema = z
  .object({
    role: z.enum(["user", "agent"]),
    text: z.string().max(100_000),
    error: z.boolean(),
    attachments: z.array(z.string().max(180)).max(4),
  })
  .strict();

const historyUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    status: z.string().trim().min(1).max(240),
    messages: z.array(visibleMessageSchema).max(200),
  })
  .strict();

const historyRecordSchema = historyUpdateSchema.extend({
  id: z.string().uuid(),
  providerProfileId: z.string().min(1).max(100).optional(),
  updatedAt: z.number().int().nonnegative(),
});

export type UiHistoryRecord = z.infer<typeof historyRecordSchema>;

const historyDirectory = (workspaceRoot: string, clientId: string): string =>
  join(
    workspaceRoot,
    ".ui-history",
    createHash("sha256").update(clientId).digest("hex"),
  );

export const writeUiHistoryRecord = async ({
  workspaceRoot,
  clientId,
  caseId,
  providerProfileId,
  candidate,
}: {
  workspaceRoot: string;
  clientId: string;
  caseId: string;
  providerProfileId?: string;
  candidate: unknown;
}): Promise<UiHistoryRecord> => {
  const update = historyUpdateSchema.parse(candidate);
  const record = historyRecordSchema.parse({
    id: caseId,
    ...update,
    ...(providerProfileId ? { providerProfileId } : {}),
    updatedAt: Date.now(),
  });
  const directory = historyDirectory(workspaceRoot, clientId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, `${caseId}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, destination);
  return record;
};

export const readUiHistory = async (
  workspaceRoot: string,
  clientId: string,
): Promise<UiHistoryRecord[]> => {
  const directory = historyDirectory(workspaceRoot, clientId);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        try {
          return historyRecordSchema.parse(
            JSON.parse(await readFile(join(directory, entry), "utf8")),
          );
        } catch {
          return undefined;
        }
      }),
  );
  return records
    .filter((record): record is UiHistoryRecord => Boolean(record))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 8);
};

