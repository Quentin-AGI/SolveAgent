import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import {
  domainErrorCode,
  FixAgentDomainError,
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
});
