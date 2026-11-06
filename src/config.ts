import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  configUpdateRequestSchema,
  GuildscribeError,
  initRequestSchema,
  type ConfigUpdateRequest,
  type InitRequest,
  voiceChannelIDsSchema,
} from "./protocol.js";

export interface GuildscribePaths {
  home: string;
  env: string;
  inProgress: string;
  recordings: string;
  logs: string;
  daemonLog: string;
  launchdStdoutLog: string;
  launchdStderrLog: string;
  lock: string;
}

export interface HookConfiguration {
  channelJoined?: string;
  channelLeft?: string;
  recordingStarted?: string;
  recordingCompleted?: string;
  recordingFailed?: string;
  transcriptionCompleted?: string;
  transcriptionFailed?: string;
}

export interface GuildscribeConfig {
  discordToken: string;
  voiceChannelIDs: string[];
  emptyGraceMs: number;
  hookTimeoutMs: number;
  transcriptionHook: string | undefined;
  hooks: HookConfiguration;
}

const ENV_KEYS = {
  discordToken: "GUILDSCRIBE_DISCORD_TOKEN",
  voiceChannelIDs: "GUILDSCRIBE_VOICE_CHANNEL_IDS",
  legacyVoiceChannelID: "GUILDSCRIBE_VOICE_CHANNEL_ID",
  emptyGraceMs: "GUILDSCRIBE_EMPTY_GRACE_MS",
  hookTimeoutMs: "GUILDSCRIBE_HOOK_TIMEOUT_MS",
  transcriptionHook: "GUILDSCRIBE_TRANSCRIPTION_HOOK",
  channelJoined: "GUILDSCRIBE_HOOK_CHANNEL_JOINED",
  channelLeft: "GUILDSCRIBE_HOOK_CHANNEL_LEFT",
  recordingStarted: "GUILDSCRIBE_HOOK_RECORDING_STARTED",
  recordingCompleted: "GUILDSCRIBE_HOOK_RECORDING_COMPLETED",
  recordingFailed: "GUILDSCRIBE_HOOK_RECORDING_FAILED",
  transcriptionCompleted: "GUILDSCRIBE_HOOK_TRANSCRIPTION_COMPLETED",
  transcriptionFailed: "GUILDSCRIBE_HOOK_TRANSCRIPTION_FAILED",
} as const;

export const resolveHome = (requested?: string): string => {
  if (!requested) return path.join(homedir(), ".guildscribe");
  if (!path.isAbsolute(requested)) {
    throw new GuildscribeError(
      "invalid_home",
      "--home must be an absolute path",
      { details: { home: requested } },
    );
  }
  return path.normalize(requested);
};

export const getPaths = (home: string): GuildscribePaths => ({
  home,
  env: path.join(home, ".env"),
  inProgress: path.join(home, "in-progress"),
  recordings: path.join(home, "recordings"),
  logs: path.join(home, "logs"),
  daemonLog: path.join(home, "logs", "daemon.jsonl"),
  launchdStdoutLog: path.join(home, "logs", "launchd.stdout.log"),
  launchdStderrLog: path.join(home, "logs", "launchd.stderr.log"),
  lock: path.join(home, "guildscribe.lock"),
});

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const readRequest = async <T>(
  source: string,
  schema: z.ZodType<T>,
): Promise<T> => {
  let raw: string;
  try {
    raw = source === "-" ? await readStdin() : await readFile(source, "utf8");
  } catch (error) {
    throw new GuildscribeError(
      "request_read_failed",
      "Could not read request",
      {
        details: { source: source === "-" ? "stdin" : source },
        cause: error,
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new GuildscribeError(
      "invalid_request_json",
      "Request is not valid JSON",
      {
        cause: error,
      },
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new GuildscribeError("invalid_request", "Request validation failed", {
      details: {
        issues: result.error.issues.map((issue) => ({
          message: issue.message,
          path: issue.path.join("."),
        })),
      },
    });
  }
  return result.data;
};

export const readInitRequest = async (source: string): Promise<InitRequest> =>
  readRequest(source, initRequestSchema);

export const readConfigUpdateRequest = async (
  source: string,
): Promise<ConfigUpdateRequest> =>
  readRequest(source, configUpdateRequestSchema);

const encodeValue = (value: string | number): string =>
  JSON.stringify(String(value));

const renderEnv = (request: InitRequest): string => {
  const lines = [
    `${ENV_KEYS.discordToken}=${encodeValue(request.discordToken)}`,
    `${ENV_KEYS.voiceChannelIDs}=${encodeValue(JSON.stringify(request.voiceChannelIDs))}`,
    `${ENV_KEYS.emptyGraceMs}=${encodeValue(request.emptyGraceMs ?? 30_000)}`,
    `${ENV_KEYS.hookTimeoutMs}=${encodeValue(request.hookTimeoutMs ?? 30_000)}`,
  ];
  const hooks = request.hooks;
  if (hooks?.channelJoined) {
    lines.push(`${ENV_KEYS.channelJoined}=${encodeValue(hooks.channelJoined)}`);
  }
  if (hooks?.channelLeft) {
    lines.push(`${ENV_KEYS.channelLeft}=${encodeValue(hooks.channelLeft)}`);
  }
  if (hooks?.recordingStarted) {
    lines.push(
      `${ENV_KEYS.recordingStarted}=${encodeValue(hooks.recordingStarted)}`,
    );
  }
  if (hooks?.recordingCompleted) {
    lines.push(
      `${ENV_KEYS.recordingCompleted}=${encodeValue(hooks.recordingCompleted)}`,
    );
  }
  if (hooks?.recordingFailed) {
    lines.push(
      `${ENV_KEYS.recordingFailed}=${encodeValue(hooks.recordingFailed)}`,
    );
  }
  if (hooks?.transcriptionCompleted) {
    lines.push(
      `${ENV_KEYS.transcriptionCompleted}=${encodeValue(hooks.transcriptionCompleted)}`,
    );
  }
  if (hooks?.transcriptionFailed) {
    lines.push(
      `${ENV_KEYS.transcriptionFailed}=${encodeValue(hooks.transcriptionFailed)}`,
    );
  }
  if (request.transcriptionHook) {
    lines.push(
      `${ENV_KEYS.transcriptionHook}=${encodeValue(request.transcriptionHook)}`,
    );
  }
  return `${lines.join("\n")}\n`;
};

export const redactedConfiguration = (config: GuildscribeConfig) => ({
  discordToken: "[redacted]",
  voiceChannelIDs: config.voiceChannelIDs,
  emptyGraceMs: config.emptyGraceMs,
  hookTimeoutMs: config.hookTimeoutMs,
  transcriptionHook: config.transcriptionHook ?? null,
  hooks: config.hooks,
});

const mergedConfiguration = (
  config: GuildscribeConfig,
  update: ConfigUpdateRequest,
): InitRequest => {
  const hooks: HookConfiguration = {};
  for (const [name, value] of Object.entries(config.hooks) as Array<
    [keyof HookConfiguration, string]
  >) {
    hooks[name] = value;
  }
  for (const [name, value] of Object.entries(update.hooks ?? {}) as Array<
    [keyof HookConfiguration, string | null]
  >) {
    if (value === null) delete hooks[name];
    else hooks[name] = value;
  }
  const transcriptionHook =
    update.transcriptionHook === null
      ? undefined
      : (update.transcriptionHook ?? config.transcriptionHook);
  return {
    discordToken: update.discordToken ?? config.discordToken,
    voiceChannelIDs: update.voiceChannelIDs ?? config.voiceChannelIDs,
    emptyGraceMs: update.emptyGraceMs ?? config.emptyGraceMs,
    hookTimeoutMs: update.hookTimeoutMs ?? config.hookTimeoutMs,
    ...(transcriptionHook ? { transcriptionHook } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
  };
};

export const updateConfiguration = async (
  paths: GuildscribePaths,
  update: ConfigUpdateRequest,
  dryRun: boolean,
) => {
  const current = await loadConfig(paths);
  const merged = mergedConfiguration(current, update);
  const previewHooks: HookConfiguration = {};
  for (const [name, value] of Object.entries(merged.hooks ?? {}) as Array<
    [keyof HookConfiguration, string | undefined]
  >) {
    if (value) previewHooks[name] = value;
  }
  const preview = redactedConfiguration({
    discordToken: merged.discordToken,
    voiceChannelIDs: merged.voiceChannelIDs,
    emptyGraceMs: merged.emptyGraceMs ?? 30_000,
    hookTimeoutMs: merged.hookTimeoutMs ?? 30_000,
    transcriptionHook: merged.transcriptionHook,
    hooks: previewHooks,
  });
  if (dryRun) {
    return { changed: false, dryRun: true, restartRequired: true, configuration: preview };
  }
  const temporaryPath = path.join(paths.home, `.env.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, renderEnv(merged), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, paths.env);
    await chmod(paths.env, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new GuildscribeError(
      "configuration_update_failed",
      "Could not update Guildscribe configuration",
      { cause: error, retrySafety: "unsafe" },
    );
  }
  return { changed: true, dryRun: false, restartRequired: true, configuration: preview };
};

const exists = async (candidate: string): Promise<boolean> => {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

export const initializeHome = async (
  paths: GuildscribePaths,
  request: InitRequest,
  dryRun: boolean,
): Promise<{ created: boolean; home: string; configurationPath: string }> => {
  if (await exists(paths.env)) {
    throw new GuildscribeError(
      "configuration_exists",
      "Guildscribe is already initialized at this home",
      { details: { configurationPath: paths.env }, retrySafety: "never" },
    );
  }
  if (await exists(paths.home)) {
    await assertOwnedAndPrivate(paths.home, "directory");
  }
  if (dryRun) {
    return { created: false, home: paths.home, configurationPath: paths.env };
  }

  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  await mkdir(paths.inProgress, { recursive: true, mode: 0o700 });
  await mkdir(paths.recordings, { recursive: true, mode: 0o700 });
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });

  const temporaryPath = path.join(paths.home, `.env.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, renderEnv(request), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await link(temporaryPath, paths.env);
    await chmod(paths.env, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new GuildscribeError(
        "configuration_exists",
        "Guildscribe is already initialized at this home",
        { details: { configurationPath: paths.env }, retrySafety: "never" },
      );
    }
    throw new GuildscribeError(
      "initialization_failed",
      "Could not initialize Guildscribe",
      { cause: error, retrySafety: "unsafe" },
    );
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return { created: true, home: paths.home, configurationPath: paths.env };
};

const parseEnvText = (text: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const [index, originalLine] of text.split(/\r?\n/).entries()) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new GuildscribeError("invalid_configuration", "Invalid .env line", {
        details: { line: index + 1 },
      });
    }
    const key = match[1] as string;
    if (Object.hasOwn(values, key)) {
      throw new GuildscribeError(
        "invalid_configuration",
        "Duplicate .env key",
        {
          details: { key, line: index + 1 },
        },
      );
    }
    const encoded = match[2] as string;
    try {
      values[key] = encoded.startsWith('"')
        ? (JSON.parse(encoded) as string)
        : encoded.trim();
    } catch (error) {
      throw new GuildscribeError(
        "invalid_configuration",
        "Invalid .env value",
        {
          details: { key, line: index + 1 },
          cause: error,
        },
      );
    }
  }
  return values;
};

const integerSetting = (
  values: Record<string, string>,
  key: string,
  fallback: number,
  minimum: number,
): number => {
  const raw = values[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > 3_600_000) {
    throw new GuildscribeError("invalid_configuration", `Invalid ${key}`, {
      details: { key },
    });
  }
  return value;
};

const optionalHook = (
  values: Record<string, string>,
  key: string,
): string | undefined => {
  const value = values[key]?.trim();
  if (!value) return undefined;
  if (!path.isAbsolute(value)) {
    throw new GuildscribeError(
      "invalid_configuration",
      `${key} must be absolute`,
      {
        details: { key },
      },
    );
  }
  return path.normalize(value);
};

export const loadConfig = async (
  paths: GuildscribePaths,
): Promise<GuildscribeConfig> => {
  await assertSecureRuntime(paths);
  let text: string;
  try {
    text = await readFile(paths.env, "utf8");
  } catch (error) {
    throw new GuildscribeError(
      "configuration_missing",
      "Guildscribe is not initialized; run guildscribe init",
      { details: { configurationPath: paths.env }, cause: error },
    );
  }
  const values = parseEnvText(text);
  const token = values[ENV_KEYS.discordToken]?.trim();
  const configuredChannels = values[ENV_KEYS.voiceChannelIDs]?.trim();
  const legacyChannel = values[ENV_KEYS.legacyVoiceChannelID]?.trim();
  let channelCandidates: unknown = legacyChannel ? [legacyChannel] : undefined;
  if (configuredChannels) {
    try {
      channelCandidates = JSON.parse(configuredChannels) as unknown;
    } catch (error) {
      throw new GuildscribeError(
        "invalid_configuration",
        `Invalid ${ENV_KEYS.voiceChannelIDs}`,
        { details: { key: ENV_KEYS.voiceChannelIDs }, cause: error },
      );
    }
  }
  const channelResult = voiceChannelIDsSchema.safeParse(channelCandidates);
  if (!token || !channelResult.success) {
    throw new GuildscribeError(
      "invalid_configuration",
      "Discord token and at least one valid voice channel ID are required",
    );
  }
  const hooks: HookConfiguration = {};
  const hookEntries = [
    ["channelJoined", ENV_KEYS.channelJoined],
    ["channelLeft", ENV_KEYS.channelLeft],
    ["recordingStarted", ENV_KEYS.recordingStarted],
    ["recordingCompleted", ENV_KEYS.recordingCompleted],
    ["recordingFailed", ENV_KEYS.recordingFailed],
    ["transcriptionCompleted", ENV_KEYS.transcriptionCompleted],
    ["transcriptionFailed", ENV_KEYS.transcriptionFailed],
  ] as const;
  for (const [property, key] of hookEntries) {
    const value = optionalHook(values, key);
    if (value) hooks[property] = value;
  }
  return {
    discordToken: token,
    voiceChannelIDs: channelResult.data,
    emptyGraceMs: integerSetting(values, ENV_KEYS.emptyGraceMs, 30_000, 0),
    hookTimeoutMs: integerSetting(values, ENV_KEYS.hookTimeoutMs, 30_000, 1),
    transcriptionHook: optionalHook(values, ENV_KEYS.transcriptionHook),
    hooks,
  };
};

const assertOwnedAndPrivate = async (
  candidate: string,
  expected: "directory" | "file",
): Promise<void> => {
  const info = await lstat(candidate);
  const typeMatches =
    expected === "directory" ? info.isDirectory() : info.isFile();
  const currentUID = process.getuid?.();
  const owned = currentUID === undefined || info.uid === currentUID;
  const privateMode = (info.mode & 0o077) === 0;
  if (info.isSymbolicLink() || !typeMatches || !owned || !privateMode) {
    throw new GuildscribeError(
      "configuration_unsafe",
      "Guildscribe runtime paths must be owner-controlled, private, and not symbolic links",
      {
        details: {
          path: candidate,
          expected,
          mode: `0${(info.mode & 0o777).toString(8)}`,
          ownerMatches: owned,
          symbolicLink: info.isSymbolicLink(),
        },
      },
    );
  }
};

export const assertSecureRuntime = async (
  paths: GuildscribePaths,
): Promise<void> => {
  try {
    await assertOwnedAndPrivate(paths.home, "directory");
    await assertOwnedAndPrivate(paths.env, "file");
  } catch (error) {
    if (error instanceof GuildscribeError) throw error;
    throw new GuildscribeError(
      "configuration_missing",
      "Guildscribe is not initialized; run guildscribe init",
      { details: { configurationPath: paths.env }, cause: error },
    );
  }
};

export const verifyExecutable = async (candidate: string): Promise<void> => {
  await access(candidate, constants.X_OK);
};

export const removeLock = async (paths: GuildscribePaths): Promise<void> => {
  await unlink(paths.lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
};
