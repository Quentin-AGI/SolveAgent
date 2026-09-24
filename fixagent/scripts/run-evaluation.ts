import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runEvaluation } from "../src/evaluation-runner.js";

const [baseUrl, manifestArgument, outputArgument, providerProfileId] =
  process.argv.slice(2);
if (!baseUrl || !manifestArgument || !outputArgument) {
  throw new Error(
    "Usage: pnpm eval:run <base-url> <evaluation-manifest.json> <report.json> [provider-profile-id]",
  );
}

const manifest = JSON.parse(
  await readFile(resolve(manifestArgument), "utf8"),
) as unknown;
const report = await runEvaluation({
  baseUrl,
  manifest,
  ...(providerProfileId ? { providerProfileId } : {}),
});
await writeFile(
  resolve(outputArgument),
  `${JSON.stringify(report, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
console.log(
  `Evaluated ${report.total_cases} Cases: ${report.passed_cases} passed (${(
    report.pass_rate * 100
  ).toFixed(1)}%).`,
);
