import assert from "node:assert/strict";
import test from "node:test";

// The helper is shipped directly to the browser, so it intentionally remains JavaScript.
// @ts-expect-error The public browser module has no separate declaration file.
import { loadCaseHistory, mergeCaseHistories, saveCaseHistory } from "../public/case-history.js";

class MemoryStorage {
  readonly values = new Map<string, string>();
  maximumLength = Number.POSITIVE_INFINITY;

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (value.length > this.maximumLength) throw new Error("QUOTA_EXCEEDED");
    this.values.set(key, value);
  }
}

const caseRecord = (id: string, updatedAt: number, text = "已保存的回答") => ({
  id,
  title: `Case ${id}`,
  status: "已完成",
  messages: [
    {
      role: "user",
      text: "扫地机器人无法回充",
      error: false,
      attachments: [],
    },
    { role: "agent", text, error: false, attachments: [] },
  ],
  providerProfileId: "qwen",
  updatedAt,
});

test("visible Case conversations survive a browser reload", () => {
  const storage = new MemoryStorage();
  const records = [caseRecord("10000000-0000-4000-8000-000000000001", 1)];

  assert.equal(saveCaseHistory(storage, records), true);
  assert.deepEqual(loadCaseHistory(storage), records);
});

test("malformed or unsafe history entries are discarded", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    "fixagent.case-history.v1",
    JSON.stringify([
      caseRecord("10000000-0000-4000-8000-000000000002", 2),
      { id: "case-invalid", title: "missing fields" },
      {
        ...caseRecord("10000000-0000-4000-8000-000000000003", 3),
        messages: [{ role: "system", text: "hidden" }],
      },
    ]),
  );

  const loaded = loadCaseHistory(storage);
  assert.deepEqual(loaded.map((record: { id: string }) => record.id), [
    "10000000-0000-4000-8000-000000000003",
    "10000000-0000-4000-8000-000000000002",
  ]);
  assert.deepEqual(loaded[0]?.messages, []);
});

test("quota pressure drops the oldest Case before the newest one", () => {
  const storage = new MemoryStorage();
  const newest = caseRecord(
    "10000000-0000-4000-8000-000000000004",
    2,
    "short",
  );
  const oldest = caseRecord(
    "10000000-0000-4000-8000-000000000005",
    1,
    "x".repeat(2_000),
  );
  storage.maximumLength = JSON.stringify([newest]).length + 5;

  assert.equal(saveCaseHistory(storage, [newest, oldest]), true);
  assert.deepEqual(
    loadCaseHistory(storage).map((record: { id: string }) => record.id),
    ["10000000-0000-4000-8000-000000000004"],
  );
});

test("local and server history merge by the newest Case revision", () => {
  const id = "10000000-0000-4000-8000-000000000006";
  const oldRecord = caseRecord(id, 1, "旧回答");
  const newRecord = caseRecord(id, 2, "新回答");

  const merged = mergeCaseHistories([oldRecord], [newRecord]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.messages[1]?.text, "新回答");
});
