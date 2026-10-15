import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { scoreEvaluationResponse } from "../src/evaluation-manifest.js";

const [manifestArgument, caseId, responseArgument] = process.argv.slice(2);
if (!manifestArgument || !caseId || !responseArgument) {
  throw new Error(
    "Usage: pnpm eval:score <evaluation-manifest.json> <evaluation-case-id> <response.txt>",
  );
}

const [manifest, responseText] = await Promise.all([
  readFile(resolve(manifestArgument), "utf8").then(JSON.parse),
  readFile(resolve(responseArgument), "utf8"),
]);
console.log(
  JSON.stringify(
    scoreEvaluationResponse({ manifest, evaluationCaseId: caseId, responseText }),
    null,
    2,
  ),
);
