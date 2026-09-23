import { resolve } from "node:path";

import { createFixAgentServer } from "./app.js";
import { createCaseWorkerRuntime } from "./case-worker-runtime.js";
import {
  EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT,
  loadKnowledgeSnapshotFile,
} from "./knowledge-store.js";

const port = Number(process.env.FIXAGENT_PORT ?? 4174);
const host = process.env.FIXAGENT_HOST ?? "127.0.0.1";
const workspaceRoot = resolve(
  process.env.FIXAGENT_RUNTIME_ROOT ?? ".runtime/cases",
);
const configuredKnowledgeSnapshotFile =
  process.env.FIXAGENT_KNOWLEDGE_SNAPSHOT_FILE;
const knowledgeSnapshot = configuredKnowledgeSnapshotFile
  ? await loadKnowledgeSnapshotFile(resolve(configuredKnowledgeSnapshotFile))
  : EMPTY_EVALUATION_KNOWLEDGE_SNAPSHOT;

const app = createFixAgentServer({
  runtime: createCaseWorkerRuntime(),
  workspaceRoot,
  knowledgeSnapshot,
});

await app.listen(port, host);
console.log(`FixAgent V0: ${app.url}`);

const shutdown = async () => {
  await app.close();
  process.exitCode = 0;
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
