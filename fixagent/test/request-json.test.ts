import assert from "node:assert/strict";
import test from "node:test";

// The helper is shipped directly to the browser, so it intentionally remains JavaScript.
// @ts-expect-error The public browser module has no separate declaration file.
import { requestJson } from "../public/request-json.js";

test("JSON requests retry an empty response once", async () => {
  let calls = 0;
  const body = await requestJson("/api/cases", { method: "POST" }, {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response("", { status: 502 })
        : Response.json({ case_id: "case-1" }, { status: 201 });
    },
    sleep: async () => {},
  });

  assert.equal(calls, 2);
  assert.deepEqual(body, { case_id: "case-1" });
});

test("JSON requests retry a malformed transient response once", async () => {
  let calls = 0;
  const body = await requestJson("/api/cases", { method: "POST" }, {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response("upstream reset", { status: 502 })
        : Response.json({ case_id: "case-2" }, { status: 201 });
    },
    sleep: async () => {},
  });

  assert.equal(calls, 2);
  assert.deepEqual(body, { case_id: "case-2" });
});

test("structured API errors are not retried", async () => {
  let calls = 0;
  await assert.rejects(
    requestJson("/api/cases", { method: "POST" }, {
      fetchImpl: async () => {
        calls += 1;
        return Response.json(
          { error: "PROVIDER_PROFILE_NOT_CONFIGURED" },
          { status: 400 },
        );
      },
      sleep: async () => {},
    }),
    { message: "PROVIDER_PROFILE_NOT_CONFIGURED" },
  );
  assert.equal(calls, 1);
});

test("network failures become a stable service error after retry", async () => {
  let calls = 0;
  await assert.rejects(
    requestJson("/api/cases", { method: "POST" }, {
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError("socket closed");
      },
      sleep: async () => {},
    }),
    { message: "SERVICE_UNAVAILABLE" },
  );
  assert.equal(calls, 2);
});
