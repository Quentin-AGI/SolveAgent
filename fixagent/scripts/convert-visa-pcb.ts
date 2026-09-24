import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { convertVisaPcbSelection } from "../src/visa-pcb-converter.js";

const [selectionArgument, outputArgument] = process.argv.slice(2);
if (!selectionArgument || !outputArgument) {
  throw new Error(
    "Usage: pnpm eval:convert:visa-pcb <selection.json> <output-directory>",
  );
}

const selectionPath = resolve(selectionArgument);
const outputDirectory = resolve(outputArgument);
if (dirname(selectionPath) !== outputDirectory) {
  throw new Error(
    "VisA output directory must contain selection.json and its relative assets",
  );
}
const importedAt =
  process.env.FIXAGENT_EVAL_IMPORTED_AT ?? new Date().toISOString();
const converted = await convertVisaPcbSelection(
  JSON.parse(await readFile(selectionPath, "utf8")) as unknown,
  {
    assetRoot: dirname(selectionPath),
    snapshotId: "VISA_PCB_V1",
    benchmarkId: "VISA-PCB-V1",
    importedAt,
    approvedBy:
      process.env.FIXAGENT_EVAL_APPROVED_BY ?? "FixAgent evaluation owner",
    sourceUri: "https://github.com/amazon-science/spot-diff",
    productContext: {
      product_family: "VISA-PCB",
      configuration_id: "pcb1-pcb4",
      hardware_version: "DATASET",
      software_version: "NOT_APPLICABLE",
      region: "GLOBAL",
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
  `Converted ${converted.evaluationManifest.cases.length} VisA PCB Cases into ${outputDirectory}`,
);
