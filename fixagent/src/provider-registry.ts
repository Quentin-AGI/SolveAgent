import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type {
  ModelConfigurationInput,
  ProviderRegistryEditor,
  ProviderRegistrySnapshot,
  ProviderRuntimeProfile,
} from "./app.js";
import { FixAgentDomainError } from "./domain-error.js";
import { findKnownProvider, knownProviderCatalog } from "./provider-catalog.js";
import {
  buildFrozenProviderProfile,
  hashProviderProfile,
} from "./provider-profile.js";

const providerRegistryProfileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
    display_name: z.string().trim().min(1).max(80),
    provider_label: z.string().trim().min(1).max(80),
    environment: z.record(z.string(), z.string().min(1)),
  })
  .strict();

const providerRegistrySchema = z
  .object({
    default_profile_id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i)
      .nullable(),
    profiles: z.array(providerRegistryProfileSchema).default([]),
    profile_history: z.array(providerRegistryProfileSchema).default([]),
  })
  .strict();

const runtimeHostKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "NODE_NO_WARNINGS",
] as const;

export interface ProviderRegistry {
  providerProfiles: readonly ProviderRuntimeProfile[];
  historicalProviderProfiles: readonly ProviderRuntimeProfile[];
  defaultProviderProfileId?: string;
}

type ProviderRegistryDocument = z.infer<typeof providerRegistrySchema>;
type ProviderRegistryProfileDocument = z.infer<
  typeof providerRegistryProfileSchema
>;

const toRuntimeProfile = (
  entry: ProviderRegistryProfileDocument,
  hostEnvironment: NodeJS.ProcessEnv,
): ProviderRuntimeProfile => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of runtimeHostKeys) environment[key] = hostEnvironment[key];
  Object.assign(environment, entry.environment);
  return {
    id: entry.id,
    display_name: entry.display_name,
    provider_label: entry.provider_label,
    profile: buildFrozenProviderProfile(entry.environment),
    environment,
  };
};

const profileRuntimeHash = (
  entry: ProviderRegistryProfileDocument,
): string => hashProviderProfile(buildFrozenProviderProfile(entry.environment));

const appendHistoricalProfile = (
  history: ProviderRegistryProfileDocument[],
  profile: ProviderRegistryProfileDocument,
): void => {
  const profileHash = profileRuntimeHash(profile);
  if (!history.some((entry) => profileRuntimeHash(entry) === profileHash)) {
    history.push(profile);
  }
};

const toProviderRegistry = (
  parsed: ProviderRegistryDocument,
  hostEnvironment: NodeJS.ProcessEnv,
): ProviderRegistry => {
  const ids = new Set<string>();
  const providerProfiles = parsed.profiles.map((entry) => {
    if (ids.has(entry.id)) {
      throw new Error(`PROVIDER_PROFILE_ID_DUPLICATE: ${entry.id}`);
    }
    ids.add(entry.id);
    return toRuntimeProfile(entry, hostEnvironment);
  });

  if (providerProfiles.length === 0 && parsed.default_profile_id !== null) {
    throw new Error("DEFAULT_PROVIDER_PROFILE_NOT_FOUND");
  }
  if (
    providerProfiles.length > 0 &&
    (!parsed.default_profile_id || !ids.has(parsed.default_profile_id))
  ) {
    throw new Error("DEFAULT_PROVIDER_PROFILE_NOT_FOUND");
  }

  return {
    providerProfiles,
    historicalProviderProfiles: parsed.profile_history.map((entry) =>
      toRuntimeProfile(entry, hostEnvironment),
    ),
    ...(parsed.default_profile_id
      ? { defaultProviderProfileId: parsed.default_profile_id }
      : {}),
  };
};

const readProviderRegistryDocument = async (
  file: string,
): Promise<ProviderRegistryDocument> =>
  providerRegistrySchema.parse(JSON.parse(await readFile(file, "utf8")));

export const loadProviderRegistryFile = async (
  file: string,
  hostEnvironment: NodeJS.ProcessEnv,
): Promise<ProviderRegistry> =>
  toProviderRegistry(await readProviderRegistryDocument(file), hostEnvironment);

export const loadProviderRegistryFileIfExists = async (
  file: string,
  hostEnvironment: NodeJS.ProcessEnv,
): Promise<ProviderRegistry | undefined> => {
  try {
    return await loadProviderRegistryFile(file, hostEnvironment);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const writeProviderRegistryDocument = async (
  file: string,
  document: ProviderRegistryDocument,
): Promise<void> => {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryFile, file);
  await chmod(file, 0o600);
};

const registrySnapshot = (
  document: ProviderRegistryDocument,
  hostEnvironment: NodeJS.ProcessEnv,
): ProviderRegistrySnapshot => toProviderRegistry(document, hostEnvironment);

export const createProviderRegistryEditor = (
  file: string,
  hostEnvironment: NodeJS.ProcessEnv,
): ProviderRegistryEditor => {
  let queue: Promise<void> = Promise.resolve();
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const readOptionalDocument = async (): Promise<
    ProviderRegistryDocument | undefined
  > => {
    try {
      return await readProviderRegistryDocument(file);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };

  return {
    upsert(input: ModelConfigurationInput) {
      return exclusive(async () => {
        const provider = findKnownProvider(input.id);
        if (!provider) {
          throw new FixAgentDomainError("PROVIDER_PROFILE_NOT_FOUND");
        }
        const current = await readOptionalDocument();
        const profiles = [...(current?.profiles ?? [])];
        let profileHistory = [...(current?.profile_history ?? [])];
        const existingIndex = profiles.findIndex((item) => item.id === input.id);
        const existing = existingIndex >= 0 ? profiles[existingIndex] : undefined;
        if (
          existing &&
          existing.environment.ANTHROPIC_BASE_URL !== input.anthropic_base_url &&
          !input.credential
        ) {
          throw new FixAgentDomainError("PROVIDER_CREDENTIAL_REQUIRED");
        }
        const preservedCredential =
          existing?.environment[input.credential_type];
        const credential = input.credential ?? preservedCredential;
        if (!credential) {
          throw new FixAgentDomainError("PROVIDER_CREDENTIAL_REQUIRED");
        }

        const environment = { ...(existing?.environment ?? {}) };
        delete environment.ANTHROPIC_AUTH_TOKEN;
        delete environment.ANTHROPIC_API_KEY;
        Object.assign(environment, {
          FIXAGENT_PROVIDER_ID: provider.provider_id,
          ANTHROPIC_BASE_URL: input.anthropic_base_url,
          FIXAGENT_MODEL: input.model_id,
          ANTHROPIC_DEFAULT_OPUS_MODEL: input.model_id,
          ANTHROPIC_DEFAULT_SONNET_MODEL: input.model_id,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: input.model_id,
          ANTHROPIC_DEFAULT_FABLE_MODEL: input.model_id,
          FIXAGENT_PROVIDER_CAPABILITIES: [
            ...new Set(input.capabilities),
          ]
            .sort()
            .join(","),
          FIXAGENT_EXPECTED_CLAUDE_CODE_VERSION:
            input.expected_claude_code_version,
          FIXAGENT_EXPECTED_OBSERVED_MODEL_ID: input.model_id,
          FIXAGENT_FALLBACK_DETECTED: "false",
          [input.credential_type]: credential,
        });

        const nextProfile = {
          id: provider.id,
          display_name: provider.display_name,
          provider_label: provider.provider_label,
          environment,
        };
        if (
          existing &&
          profileRuntimeHash(existing) !== profileRuntimeHash(nextProfile)
        ) {
          appendHistoricalProfile(profileHistory, existing);
        }
        profileHistory = profileHistory.map((entry) => {
          if (entry.id !== input.id) return entry;
          const historicalEnvironment = { ...entry.environment };
          delete historicalEnvironment.ANTHROPIC_AUTH_TOKEN;
          delete historicalEnvironment.ANTHROPIC_API_KEY;
          historicalEnvironment[input.credential_type] = credential;
          return { ...entry, environment: historicalEnvironment };
        });
        if (existingIndex >= 0) profiles[existingIndex] = nextProfile;
        else profiles.push(nextProfile);
        const providerOrder = new Map<string, number>(
          knownProviderCatalog.map((item, index) => [item.id, index]),
        );
        profiles.sort(
          (left, right) =>
            (providerOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
            (providerOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
        );

        const document = providerRegistrySchema.parse({
          default_profile_id:
            input.make_default || !current?.default_profile_id
              ? input.id
              : current.default_profile_id,
          profiles,
          profile_history: profileHistory,
        });
        await writeProviderRegistryDocument(file, document);
        return registrySnapshot(document, hostEnvironment);
      });
    },

    remove(id) {
      return exclusive(async () => {
        const current = await readOptionalDocument();
        if (!current) {
          return {
            providerProfiles: [],
            historicalProviderProfiles: [],
          };
        }
        const removedProfile = current.profiles.find(
          (profile) => profile.id === id,
        );
        if (!removedProfile) return registrySnapshot(current, hostEnvironment);
        const profiles = current.profiles.filter((profile) => profile.id !== id);
        const profileHistory = current.profile_history.filter(
          (profile) => profile.id !== id,
        );
        const document = providerRegistrySchema.parse({
          default_profile_id:
            current.default_profile_id === id
              ? profiles[0]?.id ?? null
              : current.default_profile_id,
          profiles,
          profile_history: profileHistory,
        });
        await writeProviderRegistryDocument(file, document);
        return registrySnapshot(document, hostEnvironment);
      });
    },
  };
};
