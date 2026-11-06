import { readFile } from "node:fs/promises";
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
  const [config, lock, recording, inventory] = await Promise.all([
    loadConfig(paths),
    readDaemonLock(paths),
    activeRecording(paths),
    listRecordings(paths),
  ]);
  const running = lock ? processIsAlive(lock.pid) : false;
  const startedAt = lock && lock.startedAt !== new Date(0).toISOString()
    ? lock.startedAt
    : null;
  const graceEndsAt = recording?.emptySince
    ? new Date(
        Date.parse(recording.emptySince) + config.emptyGraceMs,
      ).toISOString()
    : null;
  const latest = inventory.recordings.find(
    (candidate) => candidate.storage === "published",
  );
  return {
    daemon: {
      running,
      pid: lock?.pid ?? null,
      startedAt,
      uptimeMs:
        running && startedAt
          ? Math.max(0, now.getTime() - Date.parse(startedAt))
          : null,
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
          emptySince: recording.emptySince,
          graceEndsAt,
          graceRemainingMs: graceEndsAt
            ? Math.max(0, Date.parse(graceEndsAt) - now.getTime())
            : null,
        }
      : null,
    latestRecording: latest ?? null,
    storage: inventory.totals,
  };
};
