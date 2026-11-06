import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { GuildscribePaths } from "./config.js";
import { GuildscribeError } from "./results.js";

export type RecordingStatus =
  | "recording"
  | "finalizing"
  | "complete"
  | "failed";

export interface RecordingManifest {
  version: 1;
  recordingID: string;
  guildID: string;
  guildName?: string | null;
  channelID: string;
  channelName?: string | null;
  status: RecordingStatus;
  startedAt: string;
  updatedAt: string;
  emptySince: string | null;
  endedAt: string | null;
  durationMs: number | null;
  interrupted: boolean;
  audioFile: string | null;
  intervalCount: number;
  error: string | null;
}

export interface RecordingInterval {
  version: 1;
  intervalID: string;
  recordingID: string;
  kind: "speaking" | "connectionGap";
  userID: string | null;
  username: string | null;
  displayName: string | null;
  startOffsetMs: number;
  endOffsetMs: number;
  incomplete: boolean;
  reason: string | null;
  pcmFile: string | null;
  updatedAt: string;
}

export interface RecordingLocation {
  directory: string;
  intervalsDirectory: string;
  manifestPath: string;
}

export const locationForDirectory = (directory: string): RecordingLocation => ({
  directory,
  intervalsDirectory: path.join(directory, "intervals"),
  manifestPath: path.join(directory, "recording.json"),
});

const atomicWrite = async (
  destination: string,
  contents: string,
  mode = 0o600,
): Promise<void> => {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const writeJSON = async (
  destination: string,
  value: unknown,
): Promise<void> =>
  atomicWrite(destination, `${JSON.stringify(value, null, 2)}\n`);

export const createRecording = async (
  paths: GuildscribePaths,
  guildID: string,
  channelID: string,
  now = new Date(),
  names: { guildName?: string | null; channelName?: string | null } = {},
): Promise<{ location: RecordingLocation; manifest: RecordingManifest }> => {
  const recordingID = randomUUID();
  const location = locationForDirectory(
    path.join(paths.inProgress, recordingID),
  );
  await mkdir(location.intervalsDirectory, { recursive: true, mode: 0o700 });
  const timestamp = now.toISOString();
  const manifest: RecordingManifest = {
    version: 1,
    recordingID,
    guildID,
    guildName: names.guildName ?? null,
    channelID,
    channelName: names.channelName ?? null,
    status: "recording",
    startedAt: timestamp,
    updatedAt: timestamp,
    emptySince: null,
    endedAt: null,
    durationMs: null,
    interrupted: false,
    audioFile: null,
    intervalCount: 0,
    error: null,
  };
  await writeJSON(location.manifestPath, manifest);
  return { location, manifest };
};

export const saveManifest = async (
  location: RecordingLocation,
  manifest: RecordingManifest,
): Promise<void> => {
  manifest.updatedAt = new Date().toISOString();
  await writeJSON(location.manifestPath, manifest);
};

export const readManifest = async (
  location: RecordingLocation,
): Promise<RecordingManifest> => {
  try {
    return JSON.parse(
      await readFile(location.manifestPath, "utf8"),
    ) as RecordingManifest;
  } catch (error) {
    throw new GuildscribeError(
      "invalid_recording_manifest",
      "Could not read recording manifest",
      { details: { manifestPath: location.manifestPath }, cause: error },
    );
  }
};

export const saveInterval = async (
  location: RecordingLocation,
  interval: RecordingInterval,
): Promise<void> => {
  interval.updatedAt = new Date().toISOString();
  await writeJSON(
    path.join(location.intervalsDirectory, `${interval.intervalID}.json`),
    interval,
  );
};

export const loadIntervals = async (
  location: RecordingLocation,
): Promise<RecordingInterval[]> => {
  let names: string[];
  try {
    names = await readdir(location.intervalsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const intervals: RecordingInterval[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(location.intervalsDirectory, name), "utf8"),
      ) as RecordingInterval;
      if (parsed.version === 1 && parsed.intervalID && parsed.recordingID) {
        intervals.push(parsed);
      }
    } catch {
      // A damaged sidecar is skipped so the remaining captured audio can recover.
    }
  }
  return intervals.sort(
    (left, right) => left.startOffsetMs - right.startOffsetMs,
  );
};

export const listInProgress = async (
  paths: GuildscribePaths,
): Promise<RecordingLocation[]> => {
  let entries;
  try {
    entries = await readdir(paths.inProgress, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      locationForDirectory(path.join(paths.inProgress, entry.name)),
    )
    .sort((left, right) => left.directory.localeCompare(right.directory));
};

export const intervalPCMPath = (
  location: RecordingLocation,
  interval: RecordingInterval,
): string | null =>
  interval.pcmFile
    ? path.join(location.intervalsDirectory, path.basename(interval.pcmFile))
    : null;

export const capturedDurationMs = async (
  location: RecordingLocation,
  intervals: RecordingInterval[],
): Promise<number> => {
  let maximum = 0;
  for (const interval of intervals) {
    let end = interval.endOffsetMs;
    const pcmPath = intervalPCMPath(location, interval);
    if (interval.kind === "speaking" && pcmPath) {
      try {
        const info = await stat(pcmPath);
        const audioDuration = Math.floor(
          (info.size * 1_000) / (48_000 * 2 * 2),
        );
        end = interval.startOffsetMs + audioDuration;
      } catch {
        // The sidecar end remains the recovery boundary when PCM is unavailable.
      }
    }
    maximum = Math.max(maximum, end);
  }
  return Math.max(100, maximum);
};

export const publishRecording = async (
  paths: GuildscribePaths,
  location: RecordingLocation,
  manifest: RecordingManifest,
): Promise<RecordingLocation> => {
  const started = new Date(manifest.startedAt);
  const year = String(started.getUTCFullYear());
  const month = String(started.getUTCMonth() + 1).padStart(2, "0");
  const parent = path.join(paths.recordings, year, month);
  const destination = path.join(parent, manifest.recordingID);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    await rename(location.directory, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new GuildscribeError(
        "recording_destination_exists",
        "Completed recording destination already exists",
        {
          details: { recordingID: manifest.recordingID },
          retrySafety: "unsafe",
        },
      );
    }
    throw error;
  }
  return locationForDirectory(destination);
};
