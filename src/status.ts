import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  loadConfig,
  type GuildscribePaths,
} from "./config.js";
import {
  listInProgress,
  listRecordings,
  readManifest,
  type RecordingManifest,
} from "./recording.js";

const daemonLockSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    startedAt: z.iso.datetime(),
  })
  .strict();

export type DaemonLock = z.infer<typeof daemonLockSchema>;

export const DAEMON_HEARTBEAT_INTERVAL_MS = 10_000;
export const DAEMON_HEARTBEAT_STALE_MS = 30_000;

const daemonRuntimeStateSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    state: z.enum(["starting", "ready", "degraded", "stopping"]),
    discordReady: z.boolean(),
    lastError: z.string().nullable(),
  })
  .strict();

export type DaemonRuntimeState = z.infer<typeof daemonRuntimeStateSchema>;
export type DaemonHealth =
  | "stopped"
  | "starting"
  | "ready"
  | "recording"
  | "degraded"
  | "stopping"
  | "stale";

export const writeDaemonRuntimeState = async (
  paths: GuildscribePaths,
  state: DaemonRuntimeState,
): Promise<void> => {
  const validated = daemonRuntimeStateSchema.parse(state);
  const temporaryPath = path.join(
    paths.home,
    `.runtime.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(validated)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporaryPath, paths.runtimeState);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const readDaemonRuntimeState = async (
  paths: GuildscribePaths,
): Promise<DaemonRuntimeState | null> => {
  try {
    return daemonRuntimeStateSchema.parse(
      JSON.parse(await readFile(paths.runtimeState, "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError || error instanceof z.ZodError) return null;
    throw error;
  }
};

export const classifyDaemonHealth = (input: {
  running: boolean;
  lock: DaemonLock | null;
  runtime: DaemonRuntimeState | null;
  recording: RecordingManifest | null;
  now?: Date;
}): DaemonHealth => {
  if (!input.running) return "stopped";
  if (
    !input.lock ||
    !input.runtime ||
    input.runtime.pid !== input.lock.pid ||
    (input.now ?? new Date()).getTime() -
      Date.parse(input.runtime.updatedAt) >
      DAEMON_HEARTBEAT_STALE_MS
  ) {
    return "stale";
  }
  if (input.runtime.state !== "ready") return input.runtime.state;
  return input.recording ? "recording" : "ready";
};

export const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const daemonLockText = (
  pid = process.pid,
  startedAt = new Date(),
): string =>
  `${JSON.stringify({ version: 1, pid, startedAt: startedAt.toISOString() })}\n`;

export const parseDaemonLock = (contents: string): DaemonLock | null => {
  const trimmed = contents.trim();
  if (!trimmed) return null;
  try {
    return daemonLockSchema.parse(JSON.parse(trimmed) as unknown);
  } catch {
    const legacyPID = Number(trimmed);
    if (!Number.isSafeInteger(legacyPID) || legacyPID < 1) return null;
    return { version: 1, pid: legacyPID, startedAt: new Date(0).toISOString() };
  }
};

export const readDaemonLock = async (
  paths: GuildscribePaths,
): Promise<DaemonLock | null> => {
  try {
    return parseDaemonLock(await readFile(paths.lock, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const activeRecording = async (
  paths: GuildscribePaths,
): Promise<RecordingManifest | null> => {
  const manifests = await Promise.all(
    (await listInProgress(paths)).map((location) => readManifest(location)),
  );
  return (
    manifests
      .filter(
        (manifest) =>
          manifest.status === "recording" || manifest.status === "finalizing",
      )
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ??
    null
  );
};

export const getRuntimeStatus = async (paths: GuildscribePaths) => {
  const now = new Date();
  const [config, lock, runtime, recording, inventory] = await Promise.all([
    loadConfig(paths),
    readDaemonLock(paths),
    readDaemonRuntimeState(paths),
    activeRecording(paths),
    listRecordings(paths),
  ]);
  const running = lock ? processIsAlive(lock.pid) : false;
  const startedAt = lock && lock.startedAt !== new Date(0).toISOString()
    ? lock.startedAt
    : null;
  const latest = inventory.recordings.find(
    (candidate) => candidate.storage === "published",
  );
  const health = classifyDaemonHealth({
    running,
    lock,
    runtime,
    recording,
    now,
  });
  return {
    daemon: {
      health,
      running,
      pid: lock?.pid ?? null,
      startedAt,
      uptimeMs:
        running && startedAt
          ? Math.max(0, now.getTime() - Date.parse(startedAt))
          : null,
      heartbeatAt: runtime?.updatedAt ?? null,
      discordReady:
        health === "stale" || health === "stopped"
          ? null
          : (runtime?.discordReady ?? null),
      lastError: runtime?.lastError ?? null,
    },
    configuration: {
      voiceChannelIDs: config.voiceChannelIDs,
      emptyGraceMs: config.emptyGraceMs,
      transcriptionEnabled: Boolean(config.transcriptionHook),
    },
    recording: recording
      ? {
          recordingID: recording.recordingID,
          guildID: recording.guildID,
          guildName: recording.guildName ?? null,
          channelID: recording.channelID,
          channelName: recording.channelName ?? null,
          status: recording.status,
          startedAt: recording.startedAt,
          elapsedMs: Math.max(
            0,
            now.getTime() - Date.parse(recording.startedAt),
          ),
        }
      : null,
    latestRecording: latest ?? null,
    storage: inventory.totals,
  };
};
