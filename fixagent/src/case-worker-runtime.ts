import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentRunRequest, AgentRuntime } from "./app.js";
import {
  deserializeFixAgentError,
  serializeFixAgentError,
  type SerializedFixAgentError,
} from "./domain-error.js";
import {
  providerRuntimeEnvironmentKeys,
  selectProviderCredentials,
} from "./provider-profile.js";

export const buildCaseWorkerEnvironment = (
  source: NodeJS.ProcessEnv,
  agentCwd: string,
): NodeJS.ProcessEnv => {
  const caseWorkspaceRoot = agentCwd;
  const environment: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    HOME: join(caseWorkspaceRoot, ".home"),
    CLAUDE_CONFIG_DIR: join(caseWorkspaceRoot, ".home", ".claude"),
    TMPDIR: source.TMPDIR,
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    NODE_NO_WARNINGS: source.NODE_NO_WARNINGS,
    CLAUDE_AGENT_SDK_CLIENT_APP: "fixagent-v0/0.1.0",
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    FIXAGENT_HOST_HOME: source.HOME,
    FIXAGENT_CASES_ROOT: dirname(caseWorkspaceRoot),
  };

  for (const key of providerRuntimeEnvironmentKeys) {
    environment[key] = source[key];
  }
  Object.assign(environment, selectProviderCredentials(source));

  return environment;
};

type ParentMessage =
  | { type: "publish"; requestId: string; payload: unknown }
  | { type: "trace"; requestId: string; payload: unknown }
  | { type: "session"; requestId: string; payload: string }
  | { type: "complete" }
  | ({ type: "error" } & SerializedFixAgentError);

const workerEntry = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./case-worker-entry.ts"
      : "./case-worker-entry.js",
    import.meta.url,
  ),
);

const send = (worker: ChildProcess, message: unknown): Promise<void> =>
  new Promise((resolve, reject) => {
    worker.send?.(
      message as Parameters<NonNullable<ChildProcess["send"]>>[0],
      (error) => (error ? reject(error) : resolve()),
    );
  });

/**
 * Each invocation creates a new OS process dedicated to exactly one Case.
 * It is deliberately short-lived until same-Case Session resume and Leases land.
 */
export const createCaseWorkerRuntime = (): AgentRuntime => ({
  async run(request: AgentRunRequest) {
    const worker = fork(workerEntry, [], {
      cwd: request.cwd,
      env: {
        ...buildCaseWorkerEnvironment(process.env, request.cwd),
        FIXAGENT_CASE_ID: request.caseId,
      },
      execArgv: process.execArgv,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    await new Promise<void>((resolve, reject) => {
      let finished = false;
      let messageQueue = Promise.resolve();

      const settle = (action: () => void): void => {
        if (finished) return;
        finished = true;
        action();
      };

      worker.on("message", (untrustedMessage) => {
        messageQueue = messageQueue
          .then(async () => {
            const message = untrustedMessage as ParentMessage;
            if (
              message.type === "publish" ||
              message.type === "trace" ||
              message.type === "session"
            ) {
              try {
                if (message.type === "publish") {
                  await request.publish(message.payload);
                } else if (message.type === "trace") {
                  await request.trace(message.payload);
                } else {
                  await request.saveSession(message.payload);
                }
                await send(worker, {
                  type: "ack",
                  requestId: message.requestId,
                  ok: true,
                });
              } catch (error) {
                await send(worker, {
                  type: "ack",
                  requestId: message.requestId,
                  ok: false,
                  ...serializeFixAgentError(error, "HOST_CALLBACK_FAILED"),
                });
              }
              return;
            }

            if (message.type === "complete") {
              settle(resolve);
              return;
            }
            if (message.type === "error") {
              settle(() => reject(deserializeFixAgentError(message)));
            }
          })
          .catch((error: unknown) =>
            settle(() =>
              reject(error instanceof Error ? error : new Error("WORKER_PROTOCOL_ERROR")),
            ),
          );
      });

      worker.once("error", (error) => settle(() => reject(error)));
      worker.once("exit", (code, signal) => {
        void messageQueue.finally(() => {
          if (!finished) {
            settle(() =>
              reject(
                new Error(
                  `CASE_WORKER_EXITED: code=${String(code)} signal=${String(signal)}`,
                ),
              ),
            );
          }
        });
      });

      void send(worker, {
        type: "run",
        requestId: randomUUID(),
        caseId: request.caseId,
        cwd: request.cwd,
        userMessage: request.userMessage,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      }).catch((error: unknown) =>
        settle(() =>
          reject(error instanceof Error ? error : new Error("WORKER_START_FAILED")),
        ),
      );
    }).finally(() => {
      if (worker.connected) worker.disconnect();
      if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    });
  },
});
