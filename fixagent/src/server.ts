import { resolve } from "node:path";

import { createFixAgentServer } from "./app.js";
import { createCaseWorkerRuntime } from "./case-worker-runtime.js";

const port = Number(process.env.FIXAGENT_PORT ?? 4174);
const host = process.env.FIXAGENT_HOST ?? "127.0.0.1";
const workspaceRoot = resolve(
  process.env.FIXAGENT_RUNTIME_ROOT ?? ".runtime/cases",
);

const app = createFixAgentServer({
  runtime: createCaseWorkerRuntime(),
  workspaceRoot,
});

await app.listen(port, host);
console.log(`FixAgent V0: ${app.url}`);

const shutdown = async () => {
  await app.close();
  process.exitCode = 0;
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
