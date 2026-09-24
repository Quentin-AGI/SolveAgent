import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCaseWorkerEnvironment } from "../src/case-worker-runtime.js";

test("Case Worker receives only the provider profile and required process environment", () => {
  const environment = buildCaseWorkerEnvironment(
    {
      PATH: "/bin",
      HOME: "/host-home",
      TMPDIR: "/tmp",
      LANG: "zh_CN.UTF-8",
      ANTHROPIC_BASE_URL: "https://provider.example/anthropic",
      ANTHROPIC_AUTH_TOKEN: "secret",
      FIXAGENT_MODEL: "provider-model",
      DATABASE_URL: "must-not-cross-boundary",
      RANDOM_SERVER_SECRET: "must-not-cross-boundary",
    },
    "/cases/case-123",
  );

  assert.equal(environment.ANTHROPIC_BASE_URL, "https://provider.example/anthropic");
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, "secret");
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.FIXAGENT_MODEL, "provider-model");
  assert.equal(environment.HOME, "/cases/case-123/.home");
  assert.equal(environment.CLAUDE_CONFIG_DIR, "/cases/case-123/.home/.claude");
  assert.equal(environment.FIXAGENT_HOST_HOME, "/host-home");
  assert.equal(environment.FIXAGENT_CASES_ROOT, "/cases");
  assert.equal(environment.DATABASE_URL, undefined);
  assert.equal(environment.RANDOM_SERVER_SECRET, undefined);
  assert.equal(environment.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  assert.equal(environment.CLAUDE_CODE_SKIP_PROMPT_HISTORY, undefined);
});

test("Case Worker rejects ambiguous provider credential types", () => {
  assert.throws(
    () =>
      buildCaseWorkerEnvironment(
        {
          ANTHROPIC_AUTH_TOKEN: "token",
          ANTHROPIC_API_KEY: "key",
        },
        "/cases/case-123",
      ),
    /PROVIDER_CREDENTIAL_AMBIGUOUS/,
  );
});
