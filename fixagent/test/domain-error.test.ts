import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import {
  deserializeFixAgentError,
  domainErrorCode,
  FixAgentDomainError,
  serializeFixAgentError,
} from "../src/domain-error.js";

test("domain errors expose stable codes without leaking validation messages", () => {
  assert.equal(
    domainErrorCode(
      new FixAgentDomainError("KNOWLEDGE_HASH_MISMATCH"),
      "FALLBACK",
    ),
    "KNOWLEDGE_HASH_MISMATCH",
  );

  let validationError: unknown;
  try {
    z.object({ value: z.string() }).parse({ value: 42 });
  } catch (error) {
    validationError = error;
  }
  assert.equal(
    domainErrorCode(validationError, "FALLBACK"),
    "SCHEMA_VALIDATION_FAILED",
  );
  assert.equal(domainErrorCode(new Error("provider timed out"), "FALLBACK"), "FALLBACK");
  assert.equal(
    domainErrorCode(new Error("PROVIDER_TEMPORARY_FAILURE"), "FALLBACK"),
    "FALLBACK",
  );
});

test("Worker IPC preserves typed domain codes without promoting plain messages", () => {
  const restored = deserializeFixAgentError(
    serializeFixAgentError(
      new FixAgentDomainError(
        "CASE_REVISION_CONFLICT",
        "expected 1, actual 2",
      ),
      "FALLBACK",
    ),
  );
  assert.ok(restored instanceof FixAgentDomainError);
  assert.equal(
    domainErrorCode(restored, "FALLBACK"),
    "CASE_REVISION_CONFLICT",
  );
  assert.equal(
    domainErrorCode(
      deserializeFixAgentError({ message: "CASE_WORKER_LEASE_LOST" }),
      "FALLBACK",
    ),
    "FALLBACK",
  );
});
