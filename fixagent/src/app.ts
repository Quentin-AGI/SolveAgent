import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  publishedCaseResponseSchema,
  type PublishedCaseResponse,
} from "./published-case-response.js";
import {
  createSafetyHandoff,
  detectSafetyRedline,
  SAFETY_FALLBACK_MESSAGE,
  SAFETY_FALLBACK_MESSAGE_HASH,
  SAFETY_FALLBACK_TEMPLATE_ID,
} from "./safety-gate.js";

export type { PublishedCaseResponse } from "./published-case-response.js";

export interface AgentRunRequest {
  caseId: string;
  cwd: string;
  userMessage: string;
  publish(response: unknown): Promise<void>;
  trace(event: unknown): Promise<void>;
}

export interface AgentRuntime {
  run(request: AgentRunRequest): Promise<void>;
}

export interface FixAgentServer {
  readonly url: URL;
  listen(port?: number, host?: string): Promise<void>;
  close(): Promise<void>;
}

interface CreateFixAgentServerOptions {
  runtime: AgentRuntime;
  workspaceRoot: string;
  publicRoot?: string;
  skillFile?: string;
  safetyHandoffWriter?: typeof createSafetyHandoff;
}

class AgentResponseRejectedError extends Error {
  constructor() {
    super("AGENT_RESPONSE_REJECTED");
  }
}

const defaultPublicRoot = fileURLToPath(new URL("../public", import.meta.url));
const defaultSkillFile = fileURLToPath(
  new URL("../skills/hardware-troubleshooting/SKILL.md", import.meta.url),
);

const publicFiles = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { name: "styles.css", type: "text/css; charset=utf-8" }],
]);

const rawTraceRetentionMs = 7 * 24 * 60 * 60 * 1_000;
const tracePruneIntervalMs = 60 * 60 * 1_000;

export const pruneExpiredTraces = async (
  workspaceRoot: string,
  now = new Date(),
): Promise<void> => {
  let caseEntries;
  try {
    caseEntries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    console.error("CRITICAL_OPERATIONAL_ERROR: trace retention scan failed");
    return;
  }

  await Promise.all(
    caseEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const traceFile = join(
          workspaceRoot,
          entry.name,
          "trace",
          "events.jsonl",
        );
        try {
          const metadata = await stat(traceFile);
          if (now.getTime() - metadata.mtimeMs > rawTraceRetentionMs) {
            await unlink(traceFile);
          }
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return;
          }
          console.error(
            `CRITICAL_OPERATIONAL_ERROR: trace retention deletion failed for Case ${entry.name}`,
          );
        }
      }),
  );
};

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > 64 * 1024) {
      throw new Error("REQUEST_TOO_LARGE");
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

export const createFixAgentServer = ({
  runtime,
  workspaceRoot,
  publicRoot = defaultPublicRoot,
  skillFile = defaultSkillFile,
  safetyHandoffWriter = createSafetyHandoff,
}: CreateFixAgentServerOptions): FixAgentServer => {
  const caseDirectories = new Map<string, string>();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      const publicFile = request.method === "GET" ? publicFiles.get(url.pathname) : undefined;
      if (publicFile) {
        const content = await readFile(join(publicRoot, publicFile.name));
        response.writeHead(200, { "content-type": publicFile.type });
        response.end(content);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/cases") {
        const caseId = randomUUID();
        const caseWorkspaceRoot = join(workspaceRoot, caseId);
        const scratchDirectory = join(caseWorkspaceRoot, "scratch");
        const traceDirectory = join(caseWorkspaceRoot, "trace");
        const caseSkillDirectory = join(
          caseWorkspaceRoot,
          ".claude",
          "skills",
          "hardware-troubleshooting",
        );
        await mkdir(scratchDirectory, { recursive: true });
        await mkdir(traceDirectory, { recursive: true, mode: 0o700 });
        await mkdir(join(caseWorkspaceRoot, ".home", ".claude"), {
          recursive: true,
          mode: 0o700,
        });
        await mkdir(join(caseWorkspaceRoot, "handoff_outbox"), {
          recursive: true,
          mode: 0o700,
        });
        await mkdir(caseSkillDirectory, { recursive: true });
        const caseSkillFile = join(caseSkillDirectory, "SKILL.md");
        await copyFile(skillFile, caseSkillFile);
        await chmod(caseSkillFile, 0o444);
        await chmod(caseSkillDirectory, 0o555);
        await chmod(join(caseWorkspaceRoot, ".claude", "skills"), 0o555);
        await chmod(join(caseWorkspaceRoot, ".claude"), 0o555);
        const traceFile = join(traceDirectory, "events.jsonl");
        await writeFile(traceFile, "", { mode: 0o600 });
        await chmod(traceFile, 0o600);
        await chmod(caseWorkspaceRoot, 0o555);
        caseDirectories.set(caseId, caseWorkspaceRoot);
        sendJson(response, 201, { case_id: caseId });
        return;
      }

      const messageRoute = url.pathname.match(
        /^\/api\/cases\/([0-9a-f-]+)\/messages$/,
      );
      if (request.method === "POST" && messageRoute) {
        const caseId = messageRoute[1];
        const caseWorkspaceRoot = caseId
          ? caseDirectories.get(caseId)
          : undefined;
        if (!caseId || !caseWorkspaceRoot) {
          sendJson(response, 404, { error: "CASE_NOT_FOUND" });
          return;
        }

        const body = z
          .object({ message: z.string().trim().min(1).max(8_000) })
          .parse(await readJson(request));

        const safetyTrigger = detectSafetyRedline(body.message);
        if (safetyTrigger) {
          let handoff:
            | Awaited<ReturnType<typeof createSafetyHandoff>>
            | { status: "PERSISTENCE_FAILED" };
          let persistenceError: string | undefined;
          try {
            handoff = await safetyHandoffWriter({
              caseId,
              caseWorkspaceRoot,
              trigger: safetyTrigger,
            });
          } catch {
            try {
              handoff = await safetyHandoffWriter({
                caseId,
                caseWorkspaceRoot,
                trigger: safetyTrigger,
              });
            } catch (error) {
              persistenceError =
                error instanceof Error
                  ? error.message
                  : "HANDOFF_PERSISTENCE_FAILED";
              handoff = { status: "PERSISTENCE_FAILED" };
            }
          }

          try {
            await appendFile(
              join(caseWorkspaceRoot, "trace", "events.jsonl"),
              `${JSON.stringify({
                type: persistenceError
                  ? "critical_operational_error"
                  : "safety_gate",
                source: "APPROVED_TEXT_RULE",
                rule_ids: safetyTrigger.ruleIds,
                template_id: SAFETY_FALLBACK_TEMPLATE_ID,
                template_hash: SAFETY_FALLBACK_MESSAGE_HASH,
                handoff_persistence: handoff.status,
                ...(handoff.status === "SIMULATED_NOT_CONTACTED"
                  ? { handoff_id: handoff.id }
                  : {}),
                ...(persistenceError ? { error: persistenceError } : {}),
              })}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
          } catch {
            console.error("CRITICAL_OPERATIONAL_ERROR: safety trace unavailable");
          }
          sendJson(response, 200, {
            case_id: caseId,
            data_status: "DATA_NO_GO",
            response: {
              message_markdown: SAFETY_FALLBACK_MESSAGE,
              claim_refs: [],
              action_card_refs: [],
              response_type: "SAFETY_HANDOFF",
            },
            handoff,
          });
          return;
        }

        let publishedResponse: PublishedCaseResponse | undefined;

        await runtime.run({
          caseId,
          cwd: caseWorkspaceRoot,
          userMessage: body.message,
          async publish(candidate) {
            const parsed = publishedCaseResponseSchema.safeParse(candidate);
            if (!parsed.success) throw new AgentResponseRejectedError();
            publishedResponse = parsed.data;
          },
          async trace(event) {
            await appendFile(
              join(caseWorkspaceRoot, "trace", "events.jsonl"),
              `${JSON.stringify(event)}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
          },
        });

        if (!publishedResponse) {
          sendJson(response, 502, { error: "AGENT_RESPONSE_NOT_PUBLISHED" });
          return;
        }

        sendJson(response, 200, {
          case_id: caseId,
          data_status: "DATA_NO_GO",
          response: publishedResponse,
        });
        return;
      }

      sendJson(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        sendJson(response, 400, { error: "INVALID_REQUEST" });
        return;
      }
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
        sendJson(response, 413, { error: error.message });
        return;
      }
      if (error instanceof AgentResponseRejectedError) {
        sendJson(response, 502, { error: error.message });
        return;
      }
      sendJson(response, 500, { error: "INTERNAL_ERROR" });
    }
  });

  let address: URL | undefined;
  let tracePruneTimer: NodeJS.Timeout | undefined;

  return {
    get url() {
      if (!address) throw new Error("SERVER_NOT_LISTENING");
      return address;
    },
    async listen(port = 0, host = "127.0.0.1") {
      await pruneExpiredTraces(workspaceRoot);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const bound = server.address();
          if (!bound || typeof bound === "string") {
            reject(new Error("SERVER_ADDRESS_UNAVAILABLE"));
            return;
          }
          address = new URL(`http://${host}:${bound.port}`);
          resolve();
        });
      });
      tracePruneTimer = setInterval(() => {
        void pruneExpiredTraces(workspaceRoot);
      }, tracePruneIntervalMs);
      tracePruneTimer.unref();
    },
    async close() {
      if (tracePruneTimer) {
        clearInterval(tracePruneTimer);
        tracePruneTimer = undefined;
      }
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
};
