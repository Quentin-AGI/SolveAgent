import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { convertCambFaultTreeJsonl } from "../src/camb-converter.js";

const [inputArgument, outputArgument] = process.argv.slice(2);
if (!inputArgument || !outputArgument) {
  throw new Error(
    "Usage: pnpm eval:convert:camb <trouble_tree.jsonl> <output-directory>",
  );
}

const inputPath = resolve(inputArgument);
const outputDirectory = resolve(outputArgument);
const importedAt =
  process.env.FIXAGENT_EVAL_IMPORTED_AT ?? new Date().toISOString();
const converted = convertCambFaultTreeJsonl(
  await readFile(inputPath, "utf8"),
  {
    snapshotId: "CAMB_FAULT_TREE_V1",
    benchmarkId: "CAMB-FAULT-TREE-V1",
    importedAt,
    approvedBy:
      process.env.FIXAGENT_EVAL_APPROVED_BY ?? "FixAgent evaluation owner",
    sourceUri:
      "https://github.com/CamLLM/CamBenchmark/blob/main/faultTree/trouble_tree.jsonl",
    productContext: {
      product_family: "CAMB_CIVIL_AVIATION",
      configuration_id: "BENCHMARK",
      hardware_version: "UNSPECIFIED",
      software_version: "UNSPECIFIED",
      region: "CN",
    },
  },
);

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await Promise.all([
  writeFile(
    resolve(outputDirectory, "knowledge-snapshot.json"),
    `${JSON.stringify(converted.knowledgeSnapshot, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  ),
  writeFile(
    resolve(outputDirectory, "evaluation-manifest.private.json"),
    `${JSON.stringify(converted.evaluationManifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  ),
]);

console.log(
  `Converted ${converted.evaluationManifest.cases.length} CAMB fault-tree Cases into ${outputDirectory}`,
);
