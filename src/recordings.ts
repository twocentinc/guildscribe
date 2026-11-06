import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { GuildscribePaths } from "./config.js";
import {
  locationForDirectory,
  readManifest,
  type RecordingLocation,
  type RecordingManifest,
} from "./manifests.js";
import { GuildscribeError } from "./results.js";
import {
  readTranscriptionState,
  type TranscriptionStatus,
} from "./transcription.js";
import { readParticipants } from "./participants.js";

export type RecordingStorage = "inProgress" | "published";

export interface RecordingSummary {
  recordingID: string;
  guildID: string;
  guildName: string | null;
  channelID: string;
  channelName: string | null;
  status: RecordingManifest["status"];
  storage: RecordingStorage;
  directory: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  interrupted: boolean;
  audioFile: string | null;
  audioFileBytes: number;
  transcriptionStatus: TranscriptionStatus | null;
  transcriptJSONBytes: number;
  transcriptTextBytes: number;
  participantCount: number;
  pcmFileCount: number;
  pcmFileBytes: number;
  fileCount: number;
  totalBytes: number;
}

export interface RecordingTotals {
  recordingCount: number;
  audioFileBytes: number;
  pcmFileCount: number;
  pcmFileBytes: number;
  fileCount: number;
  totalBytes: number;
}

export interface DiscoveredRecording {
  storage: RecordingStorage;
  location: RecordingLocation;
}

export interface FileUsage {
  relativePath: string;
  bytes: number;
}

const directoryEntries = async (directory: string) => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

export const discoverRecordings = async (
  paths: GuildscribePaths,
): Promise<DiscoveredRecording[]> => {
  const discovered: DiscoveredRecording[] = [];
  for (const entry of await directoryEntries(paths.inProgress)) {
    if (!entry.isDirectory()) continue;
    discovered.push({
      storage: "inProgress",
      location: locationForDirectory(path.join(paths.inProgress, entry.name)),
    });
  }
  for (const year of await directoryEntries(paths.recordings)) {
    if (!year.isDirectory()) continue;
    const yearDirectory = path.join(paths.recordings, year.name);
    for (const month of await directoryEntries(yearDirectory)) {
      if (!month.isDirectory()) continue;
      const monthDirectory = path.join(yearDirectory, month.name);
      for (const recording of await directoryEntries(monthDirectory)) {
        if (!recording.isDirectory()) continue;
        discovered.push({
          storage: "published",
          location: locationForDirectory(
            path.join(monthDirectory, recording.name),
          ),
        });
      }
    }
  }
  return discovered;
};

export const collectRecordingFiles = async (
  root: string,
  directory = root,
): Promise<FileUsage[]> => {
  const files: FileUsage[] = [];
  for (const entry of await directoryEntries(directory)) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRecordingFiles(root, candidate)));
    } else if (entry.isFile()) {
      const info = await stat(candidate);
      files.push({
        relativePath: path.relative(root, candidate),
        bytes: info.size,
      });
    }
  }
  return files;
};

const summarizeRecording = async (
  discovered: DiscoveredRecording,
): Promise<RecordingSummary> => {
  const manifest = await readManifest(discovered.location);
  const files = await collectRecordingFiles(discovered.location.directory);
  const pcmFiles = files.filter(({ relativePath }) =>
    relativePath.endsWith(".pcm"),
  );
  const audioRelativePath = manifest.audioFile
    ? path.basename(manifest.audioFile)
    : null;
  const audioFileBytes = audioRelativePath
    ? (files.find(({ relativePath }) => relativePath === audioRelativePath)
        ?.bytes ?? 0)
    : 0;
  const [transcription, participants] = await Promise.all([
    readTranscriptionState(discovered.location),
    readParticipants(discovered.location),
  ]);
  const transcriptJSONBytes =
    files.find(({ relativePath }) => relativePath === "transcript.json")
      ?.bytes ?? 0;
  const transcriptTextBytes =
    files.find(({ relativePath }) => relativePath === "transcript.txt")
      ?.bytes ?? 0;
  return {
    recordingID: manifest.recordingID,
    guildID: manifest.guildID,
    guildName: manifest.guildName ?? null,
    channelID: manifest.channelID,
    channelName: manifest.channelName ?? null,
    status: manifest.status,
    storage: discovered.storage,
    directory: discovered.location.directory,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    durationMs: manifest.durationMs,
    interrupted: manifest.interrupted,
    audioFile: manifest.audioFile,
    audioFileBytes,
    transcriptionStatus: transcription?.status ?? null,
    transcriptJSONBytes,
    transcriptTextBytes,
    participantCount: participants?.participants.length ?? 0,
    pcmFileCount: pcmFiles.length,
    pcmFileBytes: pcmFiles.reduce((total, file) => total + file.bytes, 0),
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  };
};

const totalsFor = (recordings: RecordingSummary[]): RecordingTotals =>
  recordings.reduce<RecordingTotals>(
    (totals, recording) => ({
      recordingCount: totals.recordingCount + 1,
      audioFileBytes: totals.audioFileBytes + recording.audioFileBytes,
      pcmFileCount: totals.pcmFileCount + recording.pcmFileCount,
      pcmFileBytes: totals.pcmFileBytes + recording.pcmFileBytes,
      fileCount: totals.fileCount + recording.fileCount,
      totalBytes: totals.totalBytes + recording.totalBytes,
    }),
    {
      recordingCount: 0,
      audioFileBytes: 0,
      pcmFileCount: 0,
      pcmFileBytes: 0,
      fileCount: 0,
      totalBytes: 0,
    },
  );

export const listRecordings = async (
  paths: GuildscribePaths,
): Promise<{ recordings: RecordingSummary[]; totals: RecordingTotals }> => {
  const recordings = await Promise.all(
    (await discoverRecordings(paths)).map(summarizeRecording),
  );
  recordings.sort(
    (left, right) =>
      right.startedAt.localeCompare(left.startedAt) ||
      left.recordingID.localeCompare(right.recordingID),
  );
  return { recordings, totals: totalsFor(recordings) };
};

export const showRecording = async (
  paths: GuildscribePaths,
  recordingID: string,
): Promise<RecordingSummary> => {
  return summarizeRecording(await findRecording(paths, recordingID));
};

export const findRecording = async (
  paths: GuildscribePaths,
  recordingID: string,
): Promise<DiscoveredRecording> => {
  const matches = (await discoverRecordings(paths)).filter(
    ({ location }) => path.basename(location.directory) === recordingID,
  );
  if (matches.length === 0) {
    throw new GuildscribeError(
      "recording_not_found",
      "Recording was not found",
      {
        details: { recordingID },
      },
    );
  }
  if (matches.length > 1) {
    throw new GuildscribeError(
      "recording_ambiguous",
      "Recording ID exists in more than one storage location",
      { details: { recordingID }, retrySafety: "unknown" },
    );
  }
  return matches[0] as DiscoveredRecording;
};
