import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildFrozenProviderProfile,
  hashProviderProfile,
} from "../src/provider-profile.js";

const completeProviderEnvironment: NodeJS.ProcessEnv = {
  FIXAGENT_PROVIDER_ID: "qwen",
  ANTHROPIC_BASE_URL: "https://provider.example/anthropic",
  ANTHROPIC_AUTH_TOKEN: "secret",
  FIXAGENT_MODEL: "requested-model",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-tier",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-tier",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-tier",
  ANTHROPIC_DEFAULT_FABLE_MODEL: "fable-tier",
  FIXAGENT_PROVIDER_CAPABILITIES: "vision,tools",
  FIXAGENT_EXPECTED_CLAUDE_CODE_VERSION: "2.1.0",
};

test("Frozen Provider Profile hashes all non-secret runtime identity inputs", () => {
  const baseEnvironment: NodeJS.ProcessEnv = {
    FIXAGENT_PROVIDER_ID: "qwen",
    ANTHROPIC_BASE_URL: "https://provider.example/anthropic",
    ANTHROPIC_AUTH_TOKEN: "first-secret",
    FIXAGENT_MODEL: "requested-model",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-tier",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-tier",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-tier",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "fable-tier",
    FIXAGENT_PROVIDER_CAPABILITIES: "vision,tools",
    FIXAGENT_EXPECTED_CLAUDE_CODE_VERSION: "2.1.0",
    FIXAGENT_EXPECTED_OBSERVED_MODEL_ID: "observed-model",
  };
  const first = buildFrozenProviderProfile(baseEnvironment);
  const rotatedSecret = buildFrozenProviderProfile({
    ...baseEnvironment,
    ANTHROPIC_AUTH_TOKEN: "rotated-secret",
  });
  const changedTier = buildFrozenProviderProfile({
    ...baseEnvironment,
    ANTHROPIC_DEFAULT_SONNET_MODEL: "different-tier",
  });

  assert.equal(first.credential_type, "ANTHROPIC_AUTH_TOKEN");
  assert.equal(hashProviderProfile(first), hashProviderProfile(rotatedSecret));
  assert.notEqual(hashProviderProfile(first), hashProviderProfile(changedTier));
  assert.equal(JSON.stringify(first).includes("first-secret"), false);
});

test("partial Provider Profiles fail closed before a Case can run", () => {
  assert.throws(
    () =>
      buildFrozenProviderProfile({
        FIXAGENT_PROVIDER_ID: "qwen",
        FIXAGENT_MODEL: "requested-model",
      }),
    /PROVIDER_PROFILE_INCOMPLETE.*ANTHROPIC_BASE_URL.*credential_type.*expected_claude_code_version/,
  );
});

test("blank provider and model identifiers fail closed", () => {
  const otherwiseComplete: NodeJS.ProcessEnv = {
    FIXAGENT_PROVIDER_ID: "qwen",
    ANTHROPIC_BASE_URL: "https://provider.example/anthropic",
    ANTHROPIC_AUTH_TOKEN: "secret",
    FIXAGENT_MODEL: "requested-model",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-tier",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-tier",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-tier",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "fable-tier",
    FIXAGENT_PROVIDER_CAPABILITIES: "vision,tools",
    FIXAGENT_EXPECTED_CLAUDE_CODE_VERSION: "2.1.0",
  };

  assert.throws(
    () =>
      buildFrozenProviderProfile({
        ...otherwiseComplete,
        FIXAGENT_MODEL: "   ",
      }),
    /PROVIDER_PROFILE_INCOMPLETE.*requested_model_id/,
  );
  assert.throws(
    () =>
      buildFrozenProviderProfile({
        ...otherwiseComplete,
        FIXAGENT_PROVIDER_ID: "\t",
      }),
    /PROVIDER_PROFILE_INCOMPLETE.*provider_id/,
  );
});

test("provider base URLs reject insecure or credential-bearing variants", () => {
  for (const baseUrl of [
    "http://provider.example/anthropic",
    "https://user:password@provider.example/anthropic",
    "https://provider.example/anthropic?api_key=secret",
    "https://provider.example/anthropic#secret",
  ]) {
    assert.throws(
      () =>
        buildFrozenProviderProfile({
          ...completeProviderEnvironment,
          ANTHROPIC_BASE_URL: baseUrl,
        }),
      /PROVIDER_BASE_URL_INVALID/,
    );
  }
});
