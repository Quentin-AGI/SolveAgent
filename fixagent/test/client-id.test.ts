import assert from "node:assert/strict";
import test from "node:test";

// The helper is shipped directly to the browser, so it intentionally remains JavaScript.
// @ts-expect-error The public browser module has no separate declaration file.
import { createClientUuid } from "../public/client-id.js";

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("client UUID uses native randomUUID when available", () => {
  const expected = "00000000-0000-4000-8000-000000000123";
  const actual = createClientUuid({ randomUUID: () => expected });
  assert.equal(actual, expected);
});

test("client UUID falls back to getRandomValues on insecure HTTP origins", () => {
  const actual = createClientUuid({
    getRandomValues(bytes: Uint8Array) {
      bytes.fill(0xaa);
      return bytes;
    },
  });

  assert.match(actual, uuidV4Pattern);
  assert.equal(actual, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
});

test("client UUID remains valid when the Web Crypto object is unavailable", () => {
  assert.match(createClientUuid(null), uuidV4Pattern);
});
