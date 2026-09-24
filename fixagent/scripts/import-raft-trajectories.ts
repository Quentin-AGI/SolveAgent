import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  importRaftTrajectoryJsonl,
  parseRaftTrajectoryImportOptions,
} from "../src/historical-case-import.js";

const [inputArgument, optionsArgument, outputArgument] = process.argv.slice(2);
if (!inputArgument || !optionsArgument || !outputArgument) {
  throw new Error(
    "Usage: pnpm knowledge:import:raft <trajectories.jsonl> <options.json> <documents.json>",
  );
}

const [source, rawOptions] = await Promise.all([
  readFile(resolve(inputArgument), "utf8"),
  readFile(resolve(optionsArgument), "utf8").then(JSON.parse),
]);
const documents = importRaftTrajectoryJsonl(
  source,
  parseRaftTrajectoryImportOptions(rawOptions),
);
await writeFile(
  resolve(outputArgument),
  `${JSON.stringify(documents, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
console.log(`Imported ${documents.length} RAFT Case trajectories.`);
