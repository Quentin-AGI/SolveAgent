import { randomUUID } from "node:crypto";

import { createClaudeAgentRuntime } from "./claude-agent-runtime.js";

interface RunMessage {
  type: "run";
  caseId: string;
  cwd: string;
  userMessage: string;
  sessionId?: string;
}

interface AckMessage {
  type: "ack";
  requestId: string;
  ok: boolean;
  message?: string;
}

const pending = new Map<
  string,
  { resolve(): void; reject(error: Error): void }
>();

const sendToParent = (message: unknown): Promise<void> =>
  new Promise((resolve, reject) => {
    process.send?.(message, (error) => (error ? reject(error) : resolve()));
  });

const invokeParent = async (
  type: "publish" | "trace" | "session",
  payload: unknown,
): Promise<void> => {
  const requestId = randomUUID();
  const acknowledgement = new Promise<void>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
  });
  await sendToParent({ type, requestId, payload });
  await acknowledgement;
};

process.on("message", (untrustedMessage) => {
  const message = untrustedMessage as RunMessage | AckMessage;
  if (message.type === "ack") {
    const callback = pending.get(message.requestId);
    if (!callback) return;
    pending.delete(message.requestId);
    if (message.ok) callback.resolve();
    else callback.reject(new Error(message.message ?? "HOST_CALLBACK_FAILED"));
    return;
  }

  if (message.type !== "run") return;
  void createClaudeAgentRuntime()
    .run({
      caseId: message.caseId,
      cwd: message.cwd,
      userMessage: message.userMessage,
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      publish: (response) => invokeParent("publish", response),
      saveSession: (sessionId) => invokeParent("session", sessionId),
      trace: (event) => invokeParent("trace", event),
    })
    .then(() => sendToParent({ type: "complete" }))
    .catch((error: unknown) =>
      sendToParent({
        type: "error",
        message: error instanceof Error ? error.message : "CASE_WORKER_FAILED",
      }),
    )
    .finally(() => {
      process.disconnect?.();
    });
});
