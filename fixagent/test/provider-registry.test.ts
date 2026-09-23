import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createProviderRegistryEditor,
  loadProviderRegistryFile,
} from "../src/provider-registry.js";

test("provider registry loads isolated runtime profiles without exposing secrets in metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fixagent-providers-test-"));
  const file = join(directory, "providers.json");
  await writeFile(
    file,
    JSON.stringify({
      default_profile_id: "qwen",
      profiles: [
        {
          id: "qwen",
          display_name: "通义千问",
          provider_label: "阿里云百炼",
          environment: {
            FIXAGENT_PROVIDER_ID: "qwen",
            ANTHROPIC_BASE_URL: "https://qwen.example.test/anthropic",
            ANTHROPIC_AUTH_TOKEN: "registry-secret",
            FIXAGENT_MODEL: "qwen-model",
            ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen-model",
            ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen-model",
            ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen-model",
            ANTHROPIC_DEFAULT_FABLE_MODEL: "qwen-model",
            FIXAGENT_PROVIDER_CAPABILITIES: "tools,vision",
            FIXAGENT_EXPECTED_CLAUDE_CODE_VERSION: "test-version",
          },
        },
      ],
    }),
  );

  try {
    const registry = await loadProviderRegistryFile(file, {
      PATH: "/bin",
      RANDOM_HOST_SECRET: "must-not-enter-profile-file",
    });
    assert.equal(registry.defaultProviderProfileId, "qwen");
    assert.equal(registry.providerProfiles.length, 1);
    assert.equal(registry.providerProfiles[0]?.profile.provider_id, "qwen");
    assert.equal(
      registry.providerProfiles[0]?.environment.ANTHROPIC_AUTH_TOKEN,
      "registry-secret",
    );
    assert.equal(registry.providerProfiles[0]?.environment.PATH, "/bin");
    assert.equal(
      registry.providerProfiles[0]?.environment.RANDOM_HOST_SECRET,
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider registry editor writes private files and preserves an existing credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fixagent-providers-test-"));
  const file = join(directory, "private", "providers.json");
  const editor = createProviderRegistryEditor(file, { PATH: "/bin" });

  try {
    await assert.rejects(
      editor.upsert({
        id: "qwen",
        anthropic_base_url: "https://qwen.example.test/anthropic",
        model_id: "qwen-model",
        credential_type: "ANTHROPIC_AUTH_TOKEN",
        expected_claude_code_version: "test-version",
        capabilities: ["tools"],
        make_default: true,
      }),
      /PROVIDER_CREDENTIAL_REQUIRED/,
    );

    await editor.upsert({
      id: "qwen",
      anthropic_base_url: "https://qwen.example.test/anthropic",
      model_id: "qwen-model",
      credential_type: "ANTHROPIC_AUTH_TOKEN",
      credential: "private-secret",
      expected_claude_code_version: "test-version",
      capabilities: ["tools", "vision"],
      make_default: true,
    });
    await editor.upsert({
      id: "qwen",
      anthropic_base_url: "https://qwen.example.test/anthropic-v2",
      model_id: "qwen-model-v2",
      credential_type: "ANTHROPIC_AUTH_TOKEN",
      credential: "private-secret-v2",
      expected_claude_code_version: "test-version",
      capabilities: ["tools"],
      make_default: true,
    });

    const metadata = await stat(file);
    assert.equal(metadata.mode & 0o777, 0o600);
    const persisted = await readFile(file, "utf8");
    assert.match(persisted, /private-secret-v2/);
    assert.match(persisted, /qwen-model-v2/);
    assert.doesNotMatch(persisted, /ANTHROPIC_API_KEY/);

    const updatedRegistry = await loadProviderRegistryFile(file, {
      PATH: "/bin",
    });
    assert.equal(updatedRegistry.providerProfiles.length, 1);
    assert.equal(updatedRegistry.historicalProviderProfiles.length, 1);
    assert.equal(
      updatedRegistry.historicalProviderProfiles[0]?.environment.FIXAGENT_MODEL,
      "qwen-model",
    );
    assert.equal(
      updatedRegistry.historicalProviderProfiles[0]?.environment
        .ANTHROPIC_AUTH_TOKEN,
      "private-secret-v2",
    );
    assert.doesNotMatch(persisted, /"private-secret"/);

    await editor.remove("qwen");
    const removedRegistry = await loadProviderRegistryFile(file, {
      PATH: "/bin",
    });
    assert.equal(removedRegistry.providerProfiles.length, 0);
    assert.equal(removedRegistry.historicalProviderProfiles.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
