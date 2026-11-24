import { loadRecording, storeRecording } from "./storage.js";
import {
  EndBehaviorType,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type AudioReceiveStream,
  type VoiceConnection,
} from "@discordjs/voice";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream";

import {
  ChannelType,
  type Client,
  type VoiceChannel,
  type VoiceState,
} from "discord.js";
import prism from "prism-media";
import { z } from "zod";

import type { GuildscribeConfig, GuildscribePaths } from "./config.js";
import { invokeHook } from "./hooks.js";
import { PCM_FORMAT, renderMaster } from "./renderer.js";
import { diagnostic, GuildscribeError, sanitizeError } from "./protocol.js";
import type { TranscriptionStatus } from "./transcription.js";

// Recording storage and formats

export type RecordingStatus =
  | "recording"
  | "finalizing"
  | "complete"
  | "failed";

export const recordingIDSchema = z.uuid();
export const discordIDSchema = z.string().regex(/^\d{17,20}$/, {
  message: "Discord IDs must contain 17 to 20 decimal digits",
});

const canonicalRecordingManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordingID: recordingIDSchema,
    guildID: discordIDSchema,
    guildName: z.string().min(1).nullable(),
    channelID: discordIDSchema,
    channelName: z.string().min(1).nullable(),
    status: z.enum(["recording", "finalizing", "complete", "failed"]),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    durationMs: z.number().int().min(0).nullable(),
    recoveredAfterRestart: z.boolean(),
    error: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const issue = (path: (string | number)[], message: string): void =>
      context.addIssue({
        code: "custom",
        path,
        message,
        input: undefined,
      });
    const startedAt = Date.parse(manifest.startedAt);
    const updatedAt = Date.parse(manifest.updatedAt);
    const endedAt = manifest.endedAt ? Date.parse(manifest.endedAt) : null;
    if (updatedAt < startedAt) {
      issue(["updatedAt"], "updatedAt must not precede startedAt");
    }
    if (endedAt !== null && endedAt < startedAt) {
      issue(["endedAt"], "endedAt must not precede startedAt");
    }
    if (
      endedAt !== null &&
      manifest.durationMs !== null &&
      Math.abs(Math.max(100, endedAt - startedAt) - manifest.durationMs) > 1
    ) {
      issue(
        ["durationMs"],
        "durationMs must equal the media duration derived from the timestamps",
      );
    }
    if (manifest.status === "recording") {
      if (manifest.endedAt !== null)
        issue(["endedAt"], "recording must not have endedAt");
      if (manifest.durationMs !== null)
        issue(["durationMs"], "recording must not have durationMs");
      if (manifest.error !== null)
        issue(["error"], "recording must not have error");
    }
    if (manifest.status === "finalizing" || manifest.status === "complete") {
      if (manifest.endedAt === null)
        issue(["endedAt"], `${manifest.status} requires endedAt`);
      if (manifest.durationMs === null)
        issue(["durationMs"], `${manifest.status} requires durationMs`);
      if (manifest.error !== null)
        issue(["error"], `${manifest.status} must not have error`);
    }
    if (manifest.status === "failed" && manifest.error === null) {
      issue(["error"], "failed requires error");
    }
  });

const legacyRecordingManifestSchema = z
  .object({
    version: z.literal(1),
    recordingID: recordingIDSchema,
    guildID: discordIDSchema,
    guildName: z.string().min(1).nullable().optional().default(null),
    channelID: discordIDSchema,
    channelName: z.string().min(1).nullable().optional().default(null),
    status: z.enum(["recording", "finalizing", "complete", "failed"]),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    emptySince: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    durationMs: z.number().int().min(0).nullable(),
    interrupted: z.boolean(),
    audioFile: z.literal("audio.mp3").nullable(),
    intervalCount: z.number().int().min(0),
    error: z.string().min(1).nullable(),
    pcmFormat: z.unknown().optional(),
  })
  .strict();

export const recordingManifestSchema = z.preprocess((input) => {
  const legacy = legacyRecordingManifestSchema.safeParse(input);
  if (!legacy.success) return input;
  const manifest = legacy.data;
  return {
    schemaVersion: 1,
    recordingID: manifest.recordingID,
    guildID: manifest.guildID,
    guildName: manifest.guildName,
    channelID: manifest.channelID,
    channelName: manifest.channelName,
    status: manifest.status,
    startedAt: manifest.startedAt,
    updatedAt: manifest.updatedAt,
    endedAt: manifest.endedAt,
    durationMs: manifest.durationMs,
    recoveredAfterRestart: manifest.interrupted,
    error: manifest.error,
  };
}, canonicalRecordingManifestSchema);

export type RecordingManifest = z.infer<typeof recordingManifestSchema>;

const intervalBaseSchema = z.object({
  schemaVersion: z.literal(1),
  intervalID: z.uuid(),
  recordingID: recordingIDSchema,
  startOffsetMs: z.number().int().min(0),
  endOffsetMs: z.number().int().min(0),
  incomplete: z.boolean(),
});

const speakingIntervalSchema = intervalBaseSchema
  .extend({
    kind: z.literal("speaking"),
    userID: discordIDSchema,
  })
  .strict();

const connectionGapIntervalSchema = intervalBaseSchema
  .extend({
    kind: z.literal("connectionGap"),
    reason: z.literal("voiceDisconnected"),
  })
  .strict();

export const recordingIntervalSchema = z
  .discriminatedUnion("kind", [
    speakingIntervalSchema,
    connectionGapIntervalSchema,
  ])
  .superRefine((interval, context) => {
    if (interval.endOffsetMs < interval.startOffsetMs) {
      context.addIssue({
        code: "custom",
        path: ["endOffsetMs"],
        message: "endOffsetMs must not precede startOffsetMs",
        input: interval.endOffsetMs,
      });
    }
  });

const legacyRecordingIntervalSchema = z
  .object({
    version: z.literal(1),
    intervalID: z.uuid(),
    recordingID: recordingIDSchema,
    kind: z.enum(["speaking", "connectionGap"]),
    userID: discordIDSchema.nullable(),
    username: z.string().min(1).nullable(),
    displayName: z.string().min(1).nullable(),
    startOffsetMs: z.number().int().min(0),
    endOffsetMs: z.number().int().min(0),
    incomplete: z.boolean(),
    reason: z.string().min(1).nullable(),
    pcmFile: z.string().min(1).nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const recordingIntervalDocumentSchema = z.preprocess((input) => {
  const legacy = legacyRecordingIntervalSchema.safeParse(input);
  if (!legacy.success) return input;
  const interval = legacy.data;
  return interval.kind === "speaking"
    ? {
        schemaVersion: 1,
        intervalID: interval.intervalID,
        recordingID: interval.recordingID,
        kind: "speaking",
        userID: interval.userID,
        startOffsetMs: interval.startOffsetMs,
        endOffsetMs: interval.endOffsetMs,
        incomplete: interval.incomplete,
      }
    : {
        schemaVersion: 1,
        intervalID: interval.intervalID,
        recordingID: interval.recordingID,
        kind: "connectionGap",
        startOffsetMs: interval.startOffsetMs,
        endOffsetMs: interval.endOffsetMs,
        incomplete: interval.incomplete,
        reason: interval.reason,
      };
}, recordingIntervalSchema);

export type RecordingInterval = z.infer<typeof recordingIntervalSchema>;

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
    schemaVersion: 1,
    recordingID,
    guildID,
    guildName: names.guildName ?? null,
    channelID,
    channelName: names.channelName ?? null,
    status: "recording",
    startedAt: timestamp,
    updatedAt: timestamp,
    endedAt: null,
    durationMs: null,
    recoveredAfterRestart: false,
    error: null,
  };
  await storeRecording(location, recordingManifestSchema.parse(manifest));
  return { location, manifest };
};

export const saveManifest = async (
  location: RecordingLocation,
  manifest: RecordingManifest,
): Promise<void> => {
  manifest.updatedAt = new Date().toISOString();
  const validated = recordingManifestSchema.parse(manifest);
  if (validated.recordingID !== path.basename(location.directory)) {
    throw new GuildscribeError(
      "invalid_recording_identity",
      "Recording manifest ID does not match its directory",
      {
        details: {
          directory: location.directory,
          recordingID: validated.recordingID,
        },
        retrySafety: "never",
      },
    );
  }
  Object.assign(manifest, validated);
  await storeRecording(location, validated);
};

export const readManifest = async (
  location: RecordingLocation,
): Promise<RecordingManifest> => {
  try {
    const manifest = recordingManifestSchema.parse(
      (await loadRecording(location)) ??
        (JSON.parse(await readFile(location.manifestPath, "utf8")) as unknown),
    );
    if (manifest.recordingID !== path.basename(location.directory)) {
      throw new Error("recordingID does not match the recording directory");
    }
    return manifest;
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
  const validated = recordingIntervalSchema.parse(interval);
  if (validated.recordingID !== path.basename(location.directory)) {
    throw new GuildscribeError(
      "invalid_recording_identity",
      "Interval recording ID does not match its directory",
      {
        details: {
          directory: location.directory,
          intervalID: validated.intervalID,
          recordingID: validated.recordingID,
        },
        retrySafety: "never",
      },
    );
  }
  Object.assign(interval, validated);
  await writeJSON(
    path.join(location.intervalsDirectory, `${validated.intervalID}.json`),
    validated,
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
      const parsed = recordingIntervalDocumentSchema.parse(
        JSON.parse(
          await readFile(path.join(location.intervalsDirectory, name), "utf8"),
        ) as unknown,
      );
      if (
        name === `${parsed.intervalID}.json` &&
        parsed.recordingID === path.basename(location.directory)
      ) {
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
  interval.kind === "speaking"
    ? path.join(location.intervalsDirectory, `${interval.intervalID}.pcm`)
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
          (info.size * 1_000) /
            (PCM_FORMAT.sampleRateHz * PCM_FORMAT.channels * 2),
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
  const validated = recordingManifestSchema.parse(manifest);
  if (validated.recordingID !== path.basename(location.directory)) {
    throw new GuildscribeError(
      "invalid_recording_identity",
      "Recording manifest ID does not match its directory",
      { retrySafety: "never" },
    );
  }
  if (validated.status !== "complete") {
    throw new GuildscribeError(
      "recording_not_complete",
      "Only complete recordings can be published",
      { retrySafety: "never" },
    );
  }
  const started = new Date(validated.startedAt);
  const year = String(started.getUTCFullYear());
  const month = String(started.getUTCMonth() + 1).padStart(2, "0");
  const parent = path.join(paths.recordings, year, month);
  const destination = path.join(parent, validated.recordingID);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    await rename(location.directory, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new GuildscribeError(
        "recording_destination_exists",
        "Completed recording destination already exists",
        {
          details: { recordingID: validated.recordingID },
          retrySafety: "never",
        },
      );
    }
    throw error;
  }
  const published = locationForDirectory(destination);
  await storeRecording(published, validated);
  return published;
};

// Participant metadata

const presenceSessionSchema = z
  .object({
    startOffsetMs: z.number().int().min(0),
    endOffsetMs: z.number().int().min(0).nullable(),
  })
  .strict()
  .refine(
    (session) =>
      session.endOffsetMs === null ||
      session.endOffsetMs >= session.startOffsetMs,
    {
      message: "endOffsetMs must not precede startOffsetMs",
      path: ["endOffsetMs"],
    },
  );

const participantSchema = z
  .object({
    userID: discordIDSchema,
    username: z.string().min(1).nullable(),
    displayName: z.string().min(1).nullable(),
    sessions: z.array(presenceSessionSchema),
  })
  .strict()
  .superRefine((participant, context) => {
    for (let index = 1; index < participant.sessions.length; index += 1) {
      const previous = participant.sessions[index - 1];
      const current = participant.sessions[index];
      if (
        previous &&
        (previous.endOffsetMs === null ||
          (previous.endOffsetMs !== null &&
            current &&
            current.startOffsetMs < previous.endOffsetMs))
      ) {
        context.addIssue({
          code: "custom",
          path: ["sessions", index, "startOffsetMs"],
          message: "participant sessions must be ordered and non-overlapping",
          input: current?.startOffsetMs,
        });
      }
    }
  });

export const participantDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordingID: recordingIDSchema,
    participants: z.array(participantSchema),
  })
  .strict();

const legacyParticipantDocumentSchema = z
  .object({
    version: z.literal(1),
    recordingID: recordingIDSchema,
    updatedAt: z.iso.datetime(),
    participants: z.array(
      z
        .object({
          userID: discordIDSchema,
          username: z.string().min(1).nullable(),
          displayName: z.string().min(1).nullable(),
          sessions: z.array(
            z
              .object({
                joinedAt: z.iso.datetime(),
                leftAt: z.iso.datetime().nullable(),
              })
              .strict(),
          ),
          speakingDurationMs: z.number().int().min(0),
        })
        .strict(),
    ),
  })
  .strict();

export type ParticipantDocument = z.infer<typeof participantDocumentSchema>;

export interface ParticipantSnapshot {
  userID: string;
  username: string | null;
  displayName: string | null;
}

const documentPath = (location: RecordingLocation): string =>
  path.join(location.directory, "participants.json");

export const readParticipants = async (
  location: RecordingLocation,
): Promise<ParticipantDocument | null> => {
  try {
    const input = JSON.parse(
      await readFile(documentPath(location), "utf8"),
    ) as unknown;
    const canonical = participantDocumentSchema.safeParse(input);
    let document: ParticipantDocument;
    if (canonical.success) {
      document = canonical.data;
    } else {
      const legacy = legacyParticipantDocumentSchema.parse(input);
      const manifest = await readManifest(location);
      const startedAt = Date.parse(manifest.startedAt);
      document = participantDocumentSchema.parse({
        schemaVersion: 1,
        recordingID: legacy.recordingID,
        participants: legacy.participants.map((participant) => ({
          userID: participant.userID,
          username: participant.username,
          displayName: participant.displayName,
          sessions: participant.sessions.map((session) => ({
            startOffsetMs: Math.max(
              0,
              Date.parse(session.joinedAt) - startedAt,
            ),
            endOffsetMs:
              session.leftAt === null
                ? null
                : Math.max(0, Date.parse(session.leftAt) - startedAt),
          })),
        })),
      });
    }
    if (document.recordingID !== path.basename(location.directory)) {
      throw new Error("Participant recordingID does not match its directory");
    }
    return document;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const saveParticipants = async (
  location: RecordingLocation,
  document: ParticipantDocument,
): Promise<void> => {
  document.participants.sort((left, right) =>
    left.userID.localeCompare(right.userID),
  );
  const validated = participantDocumentSchema.parse(document);
  if (validated.recordingID !== path.basename(location.directory)) {
    throw new GuildscribeError(
      "invalid_recording_identity",
      "Participant recording ID does not match its directory",
      { retrySafety: "never" },
    );
  }
  await writeJSON(documentPath(location), validated);
};

export const initializeParticipants = async (
  location: RecordingLocation,
  recordingID: string,
  participants: ParticipantSnapshot[],
): Promise<void> => {
  const unique = new Map(
    participants.map((participant) => [participant.userID, participant]),
  );
  await saveParticipants(location, {
    schemaVersion: 1,
    recordingID,
    participants: [...unique.values()].map((participant) => ({
      ...participant,
      sessions: [{ startOffsetMs: 0, endOffsetMs: null }],
    })),
  });
};

export const updateParticipantPresence = async (
  location: RecordingLocation,
  recordingID: string,
  participant: ParticipantSnapshot,
  present: boolean,
  occurredAt = new Date().toISOString(),
): Promise<void> => {
  const manifest = await readManifest(location);
  const occurredOffsetMs = Math.max(
    0,
    Date.parse(occurredAt) - Date.parse(manifest.startedAt),
  );
  const document = (await readParticipants(location)) ?? {
    schemaVersion: 1 as const,
    recordingID,
    participants: [],
  };
  let current = document.participants.find(
    (candidate) => candidate.userID === participant.userID,
  );
  if (!current) {
    current = {
      ...participant,
      sessions: [],
    };
    document.participants.push(current);
  } else {
    current.username = participant.username;
    current.displayName = participant.displayName;
  }
  const openSession = [...current.sessions]
    .reverse()
    .find((session) => session.endOffsetMs === null);
  if (present && !openSession) {
    current.sessions.push({
      startOffsetMs: occurredOffsetMs,
      endOffsetMs: null,
    });
  }
  if (!present && openSession) openSession.endOffsetMs = occurredOffsetMs;
  await saveParticipants(location, document);
};

export const finalizeParticipants = async (
  location: RecordingLocation,
  recordingID: string,
  endedAt: string,
): Promise<void> => {
  const manifest = await readManifest(location);
  const endedOffsetMs = Math.max(
    0,
    Date.parse(endedAt) - Date.parse(manifest.startedAt),
  );
  const document = (await readParticipants(location)) ?? {
    schemaVersion: 1 as const,
    recordingID,
    participants: [],
  };
  for (const participant of document.participants) {
    for (const session of participant.sessions) {
      if (session.endOffsetMs === null) session.endOffsetMs = endedOffsetMs;
    }
  }
  await saveParticipants(location, document);
};

// Recording inventory

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
  recoveredAfterRestart: boolean;
  audioFile: string | null;
  audioFileBytes: number;
  transcriptionStatus: TranscriptionStatus | null;
  transcriptSegmentCount: number;
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
  const audioFile = manifest.status === "complete" ? "audio.mp3" : null;
  const audioFileBytes = audioFile
    ? (files.find(({ relativePath }) => relativePath === audioFile)?.bytes ?? 0)
    : 0;
  const { readTranscriptionState } = await import("./transcription.js");
  const [transcription, participants] = await Promise.all([
    readTranscriptionState(discovered.location),
    readParticipants(discovered.location),
  ]);
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
    recoveredAfterRestart: manifest.recoveredAfterRestart,
    audioFile,
    audioFileBytes,
    transcriptionStatus: transcription?.status ?? null,
    transcriptSegmentCount: transcription?.result?.segments.length ?? 0,
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
      { details: { recordingID }, retrySafety: "never" },
    );
  }
  return matches[0] as DiscoveredRecording;
};

// Live Discord recorder

const SEGMENT_SILENCE_MS = 500;
const CHECKPOINT_MS = 2_000;
const PCM_RATE = PCM_FORMAT.sampleRateHz;
const PCM_CHANNELS = PCM_FORMAT.channels;
const PCM_BYTES_PER_SAMPLE = 2;

interface RecorderDependencies {
  joinVoiceChannel: typeof joinVoiceChannel;
  waitForVoiceState: (
    connection: VoiceConnection,
    status: VoiceConnectionStatus,
    timeoutMs: number,
  ) => Promise<VoiceConnection>;
  createDecoder: () => NodeJS.ReadWriteStream;
  setGraceTimeout: (callback: () => void, durationMs: number) => NodeJS.Timeout;
  clearGraceTimeout: (timer: NodeJS.Timeout) => void;
  invokeHook: typeof invokeHook;
}

type RecordingPublishedHandler = (
  location: RecordingLocation,
  manifest: RecordingManifest,
) => Promise<void>;

const defaultDependencies: RecorderDependencies = {
  joinVoiceChannel,
  waitForVoiceState: (connection, status, timeoutMs) =>
    entersState(connection, status, timeoutMs),
  createDecoder: () =>
    new prism.opus.Decoder({
      rate: PCM_RATE,
      channels: PCM_CHANNELS,
      frameSize: 960,
    }),
  setGraceTimeout: (callback, durationMs) => setTimeout(callback, durationMs),
  clearGraceTimeout: (timer) => clearTimeout(timer),
  invokeHook,
};

interface ActiveRecording {
  location: RecordingLocation;
  manifest: RecordingManifest;
}

interface SpeakingSegment {
  interval: RecordingInterval;
  opusStream: AudioReceiveStream;
  output: WriteStream;
  checkpoint: NodeJS.Timeout;
  filePath: string;
  pipelineEnded: Promise<NodeJS.ErrnoException | null>;
}

interface ConnectionGap {
  interval: RecordingInterval;
  checkpoint: NodeJS.Timeout;
}

const wait = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const copyInterval = (interval: RecordingInterval): RecordingInterval => ({
  ...interval,
});

export const recoverRecordings = async (
  paths: GuildscribePaths,
  config: GuildscribeConfig,
  onRecordingPublished: RecordingPublishedHandler = async () => undefined,
): Promise<void> => {
  for (const location of await listInProgress(paths)) {
    let manifest: RecordingManifest;
    try {
      manifest = await readManifest(location);
    } catch (error) {
      diagnostic("error", "recording.recoverySkipped", {
        directory: location.directory,
        error: sanitizeError(error),
      });
      continue;
    }
    try {
      if (manifest.status === "complete") {
        const published = await publishRecording(paths, location, manifest);
        void invokeHook(
          paths,
          config,
          "recording.completed",
          published,
          manifest,
        );
        await onRecordingPublished(published, manifest).catch((error) => {
          diagnostic("error", "transcription.enqueueFailed", {
            recordingID: manifest.recordingID,
            error: sanitizeError(error),
          });
        });
        continue;
      }
      const intervals = await loadIntervals(location);
      const capturedDuration = await capturedDurationMs(location, intervals);
      manifest.status = "finalizing";
      manifest.recoveredAfterRestart = true;
      manifest.durationMs = Math.max(
        manifest.durationMs ?? 0,
        capturedDuration,
      );
      manifest.endedAt = new Date(
        Date.parse(manifest.startedAt) + manifest.durationMs,
      ).toISOString();
      manifest.error = null;
      await finalizeParticipants(
        location,
        manifest.recordingID,
        manifest.endedAt,
      );
      await saveManifest(location, manifest);
      await renderMaster(location, manifest.durationMs, intervals);
      manifest.status = "complete";
      await saveManifest(location, manifest);
      const published = await publishRecording(paths, location, manifest);
      diagnostic("info", "recording.recovered", {
        recordingID: manifest.recordingID,
        directory: published.directory,
      });
      void invokeHook(
        paths,
        config,
        "recording.completed",
        published,
        manifest,
      );
      await onRecordingPublished(published, manifest).catch((error) => {
        diagnostic("error", "transcription.enqueueFailed", {
          recordingID: manifest.recordingID,
          error: sanitizeError(error),
        });
      });
    } catch (error) {
      manifest.status = "failed";
      manifest.recoveredAfterRestart = true;
      manifest.error = sanitizeError(error, [config.discordToken]);
      await saveManifest(location, manifest).catch(() => undefined);
      diagnostic("error", "recording.recoveryFailed", {
        recordingID: manifest.recordingID,
        error: manifest.error,
      });
      void invokeHook(paths, config, "recording.failed", location, manifest);
    }
  }
};

export class GuildscribeRecorder {
  private readonly client: Client;
  private readonly config: GuildscribeConfig;
  private readonly paths: GuildscribePaths;
  private readonly dependencies: RecorderDependencies;
  private readonly onRecordingPublished: RecordingPublishedHandler;
  private recording: ActiveRecording | null = null;
  private connection: VoiceConnection | null = null;
  private connectionAnnounced = false;
  private speakingSegments = new Map<string, SpeakingSegment>();
  private connectionGap: ConnectionGap | null = null;
  private emptyTimer: NodeJS.Timeout | null = null;
  private emptySince: Date | null = null;
  private operation: Promise<void> = Promise.resolve();
  private recovery: Promise<void> | null = null;
  private pendingWrites = new Set<Promise<void>>();
  private shuttingDown = false;

  public constructor(options: {
    client: Client;
    config: GuildscribeConfig;
    paths: GuildscribePaths;
    dependencies?: Partial<RecorderDependencies>;
    onRecordingPublished?: RecordingPublishedHandler;
  }) {
    this.client = options.client;
    this.config = options.config;
    this.paths = options.paths;
    this.dependencies = { ...defaultDependencies, ...options.dependencies };
    this.onRecordingPublished =
      options.onRecordingPublished ?? (async () => undefined);
  }

  public async initialize(): Promise<void> {
    await this.enqueue(() => this.reconcile());
  }

  public handleVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
  ): Promise<void> {
    const configured = new Set(this.config.voiceChannelIDs);
    const preferredChannelID = configured.has(newState.channelId ?? "")
      ? newState.channelId
      : configured.has(oldState.channelId ?? "")
        ? oldState.channelId
        : null;
    if (!preferredChannelID) return Promise.resolve();
    return this.enqueue(async () => {
      await this.recordParticipantTransition(oldState, newState);
      await this.reconcile(preferredChannelID);
    });
  }

  public handleGatewayResume(): Promise<void> {
    return this.enqueue(() => this.reconcile());
  }

  public waitForIdle(): Promise<void> {
    return this.operation;
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.emptyTimer) this.dependencies.clearGraceTimeout(this.emptyTimer);
    this.emptyTimer = null;
    this.emptySince = null;
    await this.stopSpeakingSegments();
    await this.closeConnectionGap(true);
    await Promise.allSettled([...this.pendingWrites]);
    if (this.recording) {
      await saveManifest(
        this.recording.location,
        this.recording.manifest,
      ).catch(() => undefined);
    }
    this.destroyVoiceConnection();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.operation.then(operation, operation);
    this.operation = queued.catch((error: unknown) => {
      diagnostic("error", "recorder.operationFailed", {
        error: sanitizeError(error, [this.config.discordToken]),
      });
    });
    return queued;
  }

  private trackWrite(write: Promise<void>): void {
    this.pendingWrites.add(write);
    void write
      .catch((error: unknown) => {
        diagnostic("error", "recording.checkpointFailed", {
          error: sanitizeError(error),
        });
      })
      .finally(() => this.pendingWrites.delete(write));
  }

  private async getChannel(channelID: string): Promise<VoiceChannel> {
    const channel = await this.client.channels.fetch(channelID);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new Error(
        `Configured channel ${channelID} is not a guild voice channel`,
      );
    }
    return channel;
  }

  private async findOccupiedChannel(
    preferredChannelID?: string | null,
  ): Promise<VoiceChannel | null> {
    const orderedIDs = [
      ...(preferredChannelID ? [preferredChannelID] : []),
      ...this.config.voiceChannelIDs,
    ].filter((channelID, index, values) => values.indexOf(channelID) === index);
    for (const channelID of orderedIDs) {
      const channel = await this.getChannel(channelID);
      if (channel.members.some((member) => !member.user.bot)) return channel;
    }
    return null;
  }

  private participantSnapshot(state: VoiceState): ParticipantSnapshot | null {
    const member = state.member;
    if (!member || member.user.bot) return null;
    return {
      userID: member.user.id,
      username: member.user.username,
      displayName: member.displayName,
    };
  }

  private async recordParticipantTransition(
    oldState: VoiceState,
    newState: VoiceState,
  ): Promise<void> {
    const active = this.recording;
    if (!active) return;
    const oldParticipant = this.participantSnapshot(oldState);
    const newParticipant = this.participantSnapshot(newState);
    const channelID = active.manifest.channelID;
    const occurredAt = new Date().toISOString();
    if (
      oldParticipant &&
      oldState.channelId === channelID &&
      newState.channelId !== channelID
    ) {
      await updateParticipantPresence(
        active.location,
        active.manifest.recordingID,
        oldParticipant,
        false,
        occurredAt,
      );
    }
    if (newParticipant && newState.channelId === channelID) {
      await updateParticipantPresence(
        active.location,
        active.manifest.recordingID,
        newParticipant,
        true,
        occurredAt,
      );
    }
  }

  private async reconcile(preferredChannelID?: string | null): Promise<void> {
    if (this.shuttingDown) return;
    const channel = this.recording
      ? await this.getChannel(this.recording.manifest.channelID)
      : await this.findOccupiedChannel(preferredChannelID);
    if (!channel) {
      this.destroyVoiceConnection();
      return;
    }
    const humanCount = channel.members.filter(
      (member) => !member.user.bot,
    ).size;

    if (humanCount > 0) {
      if (this.emptyTimer) this.dependencies.clearGraceTimeout(this.emptyTimer);
      this.emptyTimer = null;
      this.emptySince = null;
      if (!this.recording) {
        const created = await createRecording(
          this.paths,
          channel.guild.id,
          channel.id,
          new Date(),
          { guildName: channel.guild.name, channelName: channel.name },
        );
        await initializeParticipants(
          created.location,
          created.manifest.recordingID,
          channel.members
            .filter((member) => !member.user.bot)
            .map((member) => ({
              userID: member.user.id,
              username: member.user.username,
              displayName: member.displayName,
            })),
        );
        this.recording = created;
        diagnostic("info", "recording.started", {
          recordingID: created.manifest.recordingID,
          channelID: channel.id,
        });
        void this.dependencies.invokeHook(
          this.paths,
          this.config,
          "recording.started",
          created.location,
          created.manifest,
        );
      }
      await this.ensureVoiceConnection(channel);
      return;
    }

    if (!this.recording) {
      this.destroyVoiceConnection();
      return;
    }
    if (this.emptyTimer) return;

    this.emptySince = new Date();
    this.emptyTimer = this.dependencies.setGraceTimeout(() => {
      this.emptyTimer = null;
      void this.enqueue(async () => {
        const currentChannel = await this.getChannel(channel.id);
        const currentHumans = currentChannel.members.filter(
          (member) => !member.user.bot,
        ).size;
        const endedAt = this.emptySince;
        if (currentHumans > 0 || !this.recording || !endedAt) return;
        await this.finalizeRecording(endedAt);
      });
    }, this.config.emptyGraceMs);
    this.emptyTimer.unref();
  }

  private async ensureVoiceConnection(channel: VoiceChannel): Promise<void> {
    if (
      this.connection &&
      this.connection.joinConfig.channelId !== channel.id
    ) {
      this.destroyVoiceConnection();
    }
    if (
      this.connection &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      if (this.connection.state.status === VoiceConnectionStatus.Ready) {
        this.announceVoiceJoined(channel);
        return;
      }
      try {
        await this.dependencies.waitForVoiceState(
          this.connection,
          VoiceConnectionStatus.Ready,
          15_000,
        );
        this.announceVoiceJoined(channel);
        return;
      } catch {
        this.connection.rejoin({
          channelId: channel.id,
          selfDeaf: false,
          selfMute: true,
        });
        await this.dependencies.waitForVoiceState(
          this.connection,
          VoiceConnectionStatus.Ready,
          15_000,
        );
        this.announceVoiceJoined(channel);
        return;
      }
    }

    const connection = this.dependencies.joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    this.connection = connection;
    connection.receiver.speaking.on("start", (userID) => {
      void this.enqueue(() => this.startSpeakingSegment(userID));
    });
    connection.on("error", (error) => {
      diagnostic("error", "discord.voiceError", {
        error: sanitizeError(error),
      });
    });
    connection.on("stateChange", (oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Ready) {
        void this.closeConnectionGap(false);
      } else if (newState.status === VoiceConnectionStatus.Disconnected) {
        diagnostic("warn", "discord.voiceDisconnected", {
          channelID: channel.id,
          previousStatus: oldState.status,
          reason: VoiceConnectionDisconnectReason[newState.reason],
          closeCode: "closeCode" in newState ? newState.closeCode : null,
        });
        void this.openConnectionGap();
        this.beginRecovery(connection);
      }
    });
    await this.dependencies.waitForVoiceState(
      connection,
      VoiceConnectionStatus.Ready,
      20_000,
    );
    await this.closeConnectionGap(false);
    this.announceVoiceJoined(channel);
  }

  private announceVoiceJoined(channel: VoiceChannel): void {
    const active = this.recording;
    if (this.connectionAnnounced || !active) return;
    this.connectionAnnounced = true;
    diagnostic("info", "discord.voiceJoined", {
      channelID: channel.id,
      recordingID: active.manifest.recordingID,
    });
    void this.dependencies.invokeHook(
      this.paths,
      this.config,
      "channel.joined",
      active.location,
      active.manifest,
    );
  }

  private beginRecovery(connection: VoiceConnection): void {
    if (this.recovery || this.shuttingDown) return;
    // Install the guard before rejoin can synchronously emit Disconnected.
    this.recovery = Promise.resolve().then(async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (
          this.shuttingDown ||
          !this.recording ||
          connection !== this.connection
        ) {
          return;
        }
        try {
          connection.rejoin({
            channelId: this.recording.manifest.channelID,
            selfDeaf: false,
            selfMute: true,
          });
          await this.dependencies.waitForVoiceState(
            connection,
            VoiceConnectionStatus.Ready,
            15_000,
          );
          await this.closeConnectionGap(false);
          return;
        } catch (error) {
          diagnostic("warn", "discord.voiceRejoinFailed", {
            attempt: attempt + 1,
            error: sanitizeError(error),
          });
          await wait(Math.min(10_000, 500 * 2 ** attempt));
        }
      }
      if (this.connection === connection) this.destroyVoiceConnection();
      else if (connection.state.status !== VoiceConnectionStatus.Destroyed)
        connection.destroy();
      await this.enqueue(() => this.reconcile());
    }).finally(() => {
      this.recovery = null;
    });
  }

  private async startSpeakingSegment(userID: string): Promise<void> {
    const active = this.recording;
    const connection = this.connection;
    if (
      !active ||
      active.manifest.status !== "recording" ||
      !connection ||
      connection.state.status !== VoiceConnectionStatus.Ready ||
      this.speakingSegments.has(userID)
    ) {
      return;
    }
    const channel = await this.getChannel(active.manifest.channelID);
    const member = channel.members.get(userID);
    if (!member || member.user.bot) return;

    const intervalID = randomUUID();
    const startedAt = Date.parse(active.manifest.startedAt);
    const startOffsetMs = Math.max(0, Date.now() - startedAt);
    const pcmFile = `${intervalID}.pcm`;
    const interval: RecordingInterval = {
      schemaVersion: 1,
      intervalID,
      recordingID: active.manifest.recordingID,
      kind: "speaking",
      userID,
      startOffsetMs,
      endOffsetMs: startOffsetMs,
      incomplete: true,
    };
    const filePath = path.join(active.location.intervalsDirectory, pcmFile);
    const opusStream = connection.receiver.subscribe(userID, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: SEGMENT_SILENCE_MS,
      },
    });
    const decoder = this.dependencies.createDecoder();
    const output = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
    let resolvePipeline: (error: NodeJS.ErrnoException | null) => void = () =>
      undefined;
    const pipelineEnded = new Promise<NodeJS.ErrnoException | null>(
      (resolve) => {
        resolvePipeline = resolve;
      },
    );
    const checkpoint = setInterval(() => {
      interval.endOffsetMs = Math.max(
        interval.startOffsetMs,
        Date.now() - startedAt,
      );
      this.trackWrite(saveInterval(active.location, copyInterval(interval)));
    }, CHECKPOINT_MS);
    checkpoint.unref();
    this.speakingSegments.set(userID, {
      interval,
      opusStream,
      output,
      checkpoint,
      filePath,
      pipelineEnded,
    });
    this.trackWrite(saveInterval(active.location, copyInterval(interval)));
    pipeline(opusStream, decoder, output, (error) => {
      resolvePipeline(error ?? null);
      void this.enqueue(() =>
        this.finishSpeakingSegment(userID, error ?? null),
      );
    });
  }

  private async stopSpeakingSegments(): Promise<void> {
    const segments = [...this.speakingSegments.entries()];
    for (const [, segment] of segments) {
      clearInterval(segment.checkpoint);
      segment.opusStream.destroy();
    }
    const errors = await Promise.all(
      segments.map(([, segment]) => segment.pipelineEnded),
    );
    for (const [index, [userID]] of segments.entries()) {
      await this.finishSpeakingSegment(userID, errors[index] ?? null);
    }
  }

  private async finishSpeakingSegment(
    userID: string,
    error: NodeJS.ErrnoException | null,
  ): Promise<void> {
    const segment = this.speakingSegments.get(userID);
    if (!segment) return;
    this.speakingSegments.delete(userID);
    clearInterval(segment.checkpoint);
    let bytes = 0;
    try {
      bytes = (await stat(segment.filePath)).size;
    } catch {
      // The interval remains incomplete when its PCM file cannot be read.
    }
    const audioDurationMs = Math.floor(
      (bytes * 1_000) / (PCM_RATE * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE),
    );
    segment.interval.endOffsetMs =
      segment.interval.startOffsetMs + Math.max(0, audioDurationMs);
    segment.interval.incomplete = Boolean(error);
    const active = this.recording;
    if (active) await saveInterval(active.location, segment.interval);
    if (error && !this.shuttingDown) {
      diagnostic("warn", "recording.intervalFailed", {
        intervalID: segment.interval.intervalID,
        error: sanitizeError(error),
      });
    }
  }

  private async openConnectionGap(): Promise<void> {
    const active = this.recording;
    if (!active || this.connectionGap || active.manifest.status !== "recording")
      return;
    const startedAt = Date.parse(active.manifest.startedAt);
    const startOffsetMs = Math.max(0, Date.now() - startedAt);
    const interval: RecordingInterval = {
      schemaVersion: 1,
      intervalID: randomUUID(),
      recordingID: active.manifest.recordingID,
      kind: "connectionGap",
      startOffsetMs,
      endOffsetMs: startOffsetMs,
      incomplete: true,
      reason: "voiceDisconnected",
    };
    const checkpoint = setInterval(() => {
      interval.endOffsetMs = Math.max(
        interval.startOffsetMs,
        Date.now() - startedAt,
      );
      this.trackWrite(saveInterval(active.location, copyInterval(interval)));
    }, CHECKPOINT_MS);
    checkpoint.unref();
    this.connectionGap = { interval, checkpoint };
    this.trackWrite(saveInterval(active.location, copyInterval(interval)));
  }

  private async closeConnectionGap(interrupted: boolean): Promise<void> {
    const gap = this.connectionGap;
    const active = this.recording;
    if (!gap || !active) return;
    this.connectionGap = null;
    clearInterval(gap.checkpoint);
    gap.interval.endOffsetMs = Math.max(
      gap.interval.startOffsetMs,
      Date.now() - Date.parse(active.manifest.startedAt),
    );
    gap.interval.incomplete = interrupted;
    await saveInterval(active.location, gap.interval);
  }

  private async finalizeRecording(endedAt: Date): Promise<void> {
    const active = this.recording;
    if (!active) return;
    if (this.emptyTimer) this.dependencies.clearGraceTimeout(this.emptyTimer);
    this.emptyTimer = null;
    this.emptySince = null;
    active.manifest.status = "finalizing";
    active.manifest.endedAt = endedAt.toISOString();
    active.manifest.durationMs = Math.max(
      100,
      endedAt.getTime() - Date.parse(active.manifest.startedAt),
    );
    await saveManifest(active.location, active.manifest);
    this.destroyVoiceConnection();
    await this.stopSpeakingSegments();
    await this.closeConnectionGap(false);
    await Promise.allSettled([...this.pendingWrites]);

    try {
      const intervals = await loadIntervals(active.location);
      await finalizeParticipants(
        active.location,
        active.manifest.recordingID,
        active.manifest.endedAt,
      );
      await renderMaster(
        active.location,
        active.manifest.durationMs,
        intervals,
      );
      active.manifest.status = "complete";
      active.manifest.error = null;
      await saveManifest(active.location, active.manifest);
      const published = await publishRecording(
        this.paths,
        active.location,
        active.manifest,
      );
      this.recording = null;
      diagnostic("info", "recording.completed", {
        recordingID: active.manifest.recordingID,
        directory: published.directory,
        durationMs: active.manifest.durationMs,
      });
      void this.dependencies.invokeHook(
        this.paths,
        this.config,
        "recording.completed",
        published,
        active.manifest,
      );
      await this.onRecordingPublished(published, active.manifest).catch(
        (error: unknown) => {
          diagnostic("error", "transcription.enqueueFailed", {
            recordingID: active.manifest.recordingID,
            error: sanitizeError(error),
          });
        },
      );
    } catch (error) {
      active.manifest.status = "failed";
      active.manifest.error = sanitizeError(error, [this.config.discordToken]);
      await saveManifest(active.location, active.manifest).catch(
        () => undefined,
      );
      this.recording = null;
      diagnostic("error", "recording.failed", {
        recordingID: active.manifest.recordingID,
        error: active.manifest.error,
      });
      void this.dependencies.invokeHook(
        this.paths,
        this.config,
        "recording.failed",
        active.location,
        active.manifest,
      );
    }

    if (!this.shuttingDown) await this.reconcile();
  }

  private destroyVoiceConnection(): void {
    const active = this.recording;
    const shouldAnnounce = this.connectionAnnounced && Boolean(active);
    if (
      this.connection &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      this.connection.destroy();
    }
    this.connection = null;
    this.connectionAnnounced = false;
    if (shouldAnnounce && active) {
      diagnostic("info", "discord.voiceLeft", {
        channelID: active.manifest.channelID,
        recordingID: active.manifest.recordingID,
      });
      void this.dependencies.invokeHook(
        this.paths,
        this.config,
        "channel.left",
        active.location,
        active.manifest,
      );
    }
  }
}
