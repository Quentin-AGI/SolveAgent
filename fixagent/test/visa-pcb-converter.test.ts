import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { convertVisaPcbSelection } from "../src/visa-pcb-converter.js";

const options = (assetRoot: string) => ({
  assetRoot,
  snapshotId: "VISA_PCB_V1",
  benchmarkId: "VISA-PCB-V1",
  importedAt: "2026-09-24T00:00:00.000Z",
  approvedBy: "FixAgent evaluation owner",
  sourceUri: "https://github.com/amazon-science/spot-diff",
  productContext: {
    product_family: "VISA-PCB",
    configuration_id: "pcb1-pcb4",
    hardware_version: "DATASET",
    software_version: "NOT_APPLICABLE",
    region: "DATASET",
  },
});

const selection = {
  schema_version: "fixagent.visa-pcb-selection.v0",
  source_revision: "d47f019b89ca501009e65b8afd940cbd8b888642",
  records: [
    {
      source_id: "pcb1-anomaly-000",
      pcb: "pcb1",
      condition: "ANOMALY",
      image_relative_path: "assets/visa-pcb-001.jpg",
      mask_relative_path: "ground-truth/visa-pcb-001.png",
      defect_labels_en: ["Bent"],
      defect_labels_zh: ["弯曲"],
    },
  ],
};

test("VisA PCB converter hash-locks images while keeping labels out of runtime snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "fixagent-visa-"));
  await mkdir(join(root, "assets"));
  await mkdir(join(root, "ground-truth"));
  await writeFile(join(root, "assets/visa-pcb-001.jpg"), "jpeg-fixture");
  await writeFile(join(root, "ground-truth/visa-pcb-001.png"), "mask-fixture");

  const converted = await convertVisaPcbSelection(selection, options(root));

  assert.equal(converted.evaluationManifest.cases.length, 1);
  assert.equal(
    converted.evaluationManifest.cases[0]?.attachments?.[0]?.relative_path,
    "assets/visa-pcb-001.jpg",
  );
  assert.deepEqual(
    converted.evaluationManifest.cases[0]?.expected.fault_classifications,
    ["弯曲", "Bent"],
  );
  assert.equal(converted.knowledgeSnapshot.evaluation_cases.length, 1);
  assert.equal(
    JSON.stringify(converted.knowledgeSnapshot).includes("弯曲"),
    false,
  );
  assert.equal(
    JSON.stringify(converted.knowledgeSnapshot).includes("ANOMALY"),
    false,
  );
});

test("VisA PCB converter rejects selection paths outside the asset root", async () => {
  const root = await mkdtemp(join(tmpdir(), "fixagent-visa-"));
  await assert.rejects(
    convertVisaPcbSelection(
      {
        ...selection,
        records: [
          {
            ...selection.records[0],
            image_relative_path: "../outside.jpg",
          },
        ],
      },
      options(root),
    ),
    /VisA asset paths must stay inside the evaluation asset root/,
  );
});
