import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import {
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { GuildscribeConfig, GuildscribePaths } from "./config.js";
import { invokeHook } from "./hooks.js";
import {
  loadIntervals,
  locationForDirectory,
  readManifest,
  recordingIDSchema,
  discordIDSchema,
  writeJSON,
  type RecordingLocation,
  type RecordingManifest,
  type RecordingInterval,
} from "./recording.js";
import { diagnostic, sanitizeError } from "./protocol.js";

export type TranscriptionStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed";

const transcriptionStateSchema = z
  .object({
    version: z.literal(1),
    recordingID: recordingIDSchema,
    status: z.enum(["pending", "running", "complete", "failed"]),
    attempts: z.number().int().min(0),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    error: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((state, context) => {
    const issue = (path: string, message: string): void =>
      context.addIssue({
        code: "custom",
        path: [path],
        message,
        input: state[path as keyof typeof state],
      });
    if (Date.parse(state.updatedAt) < Date.parse(state.createdAt)) {
      issue("updatedAt", "updatedAt must not precede createdAt");
    }
    if (
      state.startedAt &&
      Date.parse(state.startedAt) < Date.parse(state.createdAt)
    ) {
      issue("startedAt", "startedAt must not precede createdAt");
    }
    if (
      state.completedAt &&
      (!state.startedAt ||
        Date.parse(state.completedAt) < Date.parse(state.startedAt))
    ) {
      issue("completedAt", "completedAt must not precede startedAt");
    }
    if (state.status === "pending") {
      if (state.startedAt !== null)
        issue("startedAt", "pending must not have startedAt");
      if (state.completedAt !== null)
        issue("completedAt", "pending must not have completedAt");
      if (state.error !== null) issue("error", "pending must not have error");
    }
    if (state.status === "running") {
      if (state.attempts < 1) issue("attempts", "running requires an attempt");
      if (state.startedAt === null)
        issue("startedAt", "running requires startedAt");
      if (state.completedAt !== null)
        issue("completedAt", "running must not have completedAt");
      if (state.error !== null) issue("error", "running must not have error");
    }
    if (state.status === "complete") {
      if (state.attempts < 1) issue("attempts", "complete requires an attempt");
      if (state.startedAt === null)
        issue("startedAt", "complete requires startedAt");
      if (state.completedAt === null)
        issue("completedAt", "complete requires completedAt");
      if (state.error !== null) issue("error", "complete must not have error");
    }
    if (state.status === "failed") {
      if (state.attempts < 1) issue("attempts", "failed requires an attempt");
      if (state.startedAt === null)
        issue("startedAt", "failed requires startedAt");
      if (state.completedAt !== null)
        issue("completedAt", "failed must not have completedAt");
      if (state.error === null) issue("error", "failed requires error");
    }
  });

export type TranscriptionState = z.infer<typeof transcriptionStateSchema>;

const transcriptSpeakerSchema = z
  .object({
    userID: discordIDSchema.nullable(),
    username: z.string().min(1).nullable(),
    displayName: z.string().min(1).nullable(),
  })
  .strict()
  .refine(
    (speaker) =>
      speaker.userID !== null ||
      speaker.username !== null ||
      speaker.displayName !== null,
    { message: "speaker must contain at least one identity field" },
  );

const transcriptSegmentSchema = z
  .object({
    startOffsetMs: z.number().int().min(0),
    endOffsetMs: z.number().int().min(0),
    text: z.string().refine((text) => text.trim().length > 0, {
      message: "segment text must not be empty",
    }),
    sourceIntervalIDs: z.array(z.uuid()).min(1).optional(),
    speaker: transcriptSpeakerSchema.optional(),
  })
  .strict()
  .refine((segment) => segment.endOffsetMs >= segment.startOffsetMs, {
    message: "endOffsetMs must be greater than or equal to startOffsetMs",
  });

export const transcriptDocumentSchema = z
  .object({
    version: z.literal(1),
    recordingID: recordingIDSchema,
    createdAt: z.iso.datetime(),
    language: z.string().min(1).nullable(),
    text: z.string(),
    segments: z.array(transcriptSegmentSchema),
  })
  .strict()
  .superRefine((output, context) => {
    if (output.segments.length > 0 && output.text.trim().length === 0) {
      context.addIssue({
        code: "custom",
        message: "text must not be empty when segments are present",
        path: ["text"],
        input: output.text,
      });
    }
    for (let index = 1; index < output.segments.length; index += 1) {
      const previous = output.segments[index - 1];
      const current = output.segments[index];
      if (
        previous &&
        current &&
        current.startOffsetMs < previous.startOffsetMs
      ) {
        context.addIssue({
          code: "custom",
          message: "segments must be ordered by startOffsetMs",
          path: ["segments", index, "startOffsetMs"],
        });
      }
    }
    for (const [index, segment] of output.segments.entries()) {
      if (
        segment.sourceIntervalIDs &&
        new Set(segment.sourceIntervalIDs).size !==
          segment.sourceIntervalIDs.length
      ) {
        context.addIssue({
          code: "custom",
          message: "sourceIntervalIDs must be unique",
          path: ["segments", index, "sourceIntervalIDs"],
          input: segment.sourceIntervalIDs,
        });
      }
    }
  });

export type TranscriptDocument = z.infer<typeof transcriptDocumentSchema>;

const statePathFor = (location: RecordingLocation): string =>
  path.join(location.directory, "transcription.json");

const pendingTranscriptPathFor = (location: RecordingLocation): string =>
  path.join(location.directory, ".transcript.json.pending");

const readJSON = async (candidate: string): Promise<unknown> =>
  JSON.parse(await readFile(candidate, "utf8")) as unknown;

const validateTranscriptContext = (
  transcript: TranscriptDocument,
  manifest: RecordingManifest,
  intervals: RecordingInterval[],
): TranscriptDocument => {
  if (transcript.recordingID !== manifest.recordingID) {
    throw new Error("Transcript recordingID does not match recording.json");
  }
  const intervalByID = new Map(
    intervals.map((interval) => [interval.intervalID, interval]),
  );
  for (const segment of transcript.segments) {
    if (
      manifest.durationMs !== null &&
      segment.endOffsetMs > manifest.durationMs
    ) {
      throw new Error("Transcript segment exceeds the recording duration");
    }
    for (const intervalID of segment.sourceIntervalIDs ?? []) {
      const interval = intervalByID.get(intervalID);
      if (!interval) {
        throw new Error(`Transcript references unknown interval ${intervalID}`);
      }
      if (interval.kind !== "speaking") {
        throw new Error(
          `Transcript source interval ${intervalID} is not speaking audio`,
        );
      }
      const overlaps =
        segment.startOffsetMs === segment.endOffsetMs
          ? interval.startOffsetMs <= segment.startOffsetMs &&
            interval.endOffsetMs >= segment.endOffsetMs
          : interval.startOffsetMs < segment.endOffsetMs &&
            interval.endOffsetMs > segment.startOffsetMs;
      if (!overlaps) {
        throw new Error(
          `Transcript source interval ${intervalID} does not overlap its segment`,
        );
      }
      if (
        segment.speaker?.userID &&
        interval.userID !== segment.speaker.userID
      ) {
        throw new Error(
          `Transcript speaker does not match source interval ${intervalID}`,
        );
      }
    }
  }
  return transcript;
};

export const readTranscript = async (
  location: RecordingLocation,
): Promise<TranscriptDocument> => {
  const [manifest, intervals, document] = await Promise.all([
    readManifest(location),
    loadIntervals(location),
    readJSON(path.join(location.directory, "transcript.json")),
  ]);
  return validateTranscriptContext(
    transcriptDocumentSchema.parse(document),
    manifest,
    intervals,
  );
};

export const readTranscriptionState = async (
  location: RecordingLocation,
): Promise<TranscriptionState | null> => {
  try {
    const state = transcriptionStateSchema.parse(
      await readJSON(statePathFor(location)),
    );
    if (state.recordingID !== path.basename(location.directory)) {
      throw new Error("Transcription recordingID does not match its directory");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const writeTranscriptionState = async (
  location: RecordingLocation,
  state: TranscriptionState,
): Promise<void> => {
  state.updatedAt = new Date().toISOString();
  const validated = transcriptionStateSchema.parse(state);
  if (validated.recordingID !== path.basename(location.directory)) {
    throw new Error("Transcription recordingID does not match its directory");
  }
  Object.assign(state, validated);
  await writeJSON(statePathFor(location), validated);
};

const atomicWriteText = async (
  destination: string,
  contents: string,
): Promise<void> => {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
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

const directoryEntries = async (directory: string) => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const publishedLocations = async (
  paths: GuildscribePaths,
): Promise<RecordingLocation[]> => {
  const locations: RecordingLocation[] = [];
  for (const year of await directoryEntries(paths.recordings)) {
    if (!year.isDirectory()) continue;
    const yearDirectory = path.join(paths.recordings, year.name);
    for (const month of await directoryEntries(yearDirectory)) {
      if (!month.isDirectory()) continue;
      const monthDirectory = path.join(yearDirectory, month.name);
      for (const recording of await directoryEntries(monthDirectory)) {
        if (!recording.isDirectory()) continue;
        locations.push(
          locationForDirectory(path.join(monthDirectory, recording.name)),
        );
      }
    }
  }
  return locations.sort((left, right) =>
    left.directory.localeCompare(right.directory),
  );
};

interface HookRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export class TranscriptionWorker {
  private readonly paths: GuildscribePaths;
  private readonly config: GuildscribeConfig;
  private operation: Promise<void> = Promise.resolve();
  private readonly scheduled = new Set<string>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;

  public constructor(paths: GuildscribePaths, config: GuildscribeConfig) {
    this.paths = paths;
    this.config = config;
  }

  public async recover(): Promise<void> {
    if (!this.config.transcriptionHook) return;
    for (const location of await publishedLocations(this.paths)) {
      try {
        const state = await readTranscriptionState(location);
        if (
          !state ||
          (state.status !== "pending" && state.status !== "running")
        )
          continue;
        if (state.status === "running") {
          state.status = "pending";
          state.startedAt = null;
          state.error = null;
          await writeTranscriptionState(location, state);
        }
        const manifest = await readManifest(location);
        this.schedule(location, manifest);
      } catch (error) {
        diagnostic("error", "transcription.recoverySkipped", {
          directory: location.directory,
          error: sanitizeError(error),
        });
      }
    }
  }

  public async enqueue(
    location: RecordingLocation,
    manifest: RecordingManifest,
  ): Promise<boolean> {
    if (!this.config.transcriptionHook) return false;
    const existing = await readTranscriptionState(location);
    if (existing) {
      if (existing.status === "pending" || existing.status === "running") {
        this.schedule(location, manifest);
      }
      return false;
    }
    const timestamp = new Date().toISOString();
    await writeTranscriptionState(location, {
      version: 1,
      recordingID: manifest.recordingID,
      status: "pending",
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null,
      error: null,
    });
    this.schedule(location, manifest);
    return true;
  }

  public waitForIdle(): Promise<void> {
    return this.operation;
  }

  public async shutdown(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    child?.kill("SIGTERM");
    const force = child
      ? setTimeout(() => {
          if (this.child === child) child.kill("SIGKILL");
        }, 5_000)
      : null;
    force?.unref();
    try {
      await this.operation;
    } finally {
      if (force) clearTimeout(force);
    }
  }

  private schedule(
    location: RecordingLocation,
    manifest: RecordingManifest,
  ): void {
    if (this.stopping || this.scheduled.has(manifest.recordingID)) return;
    this.scheduled.add(manifest.recordingID);
    const run = this.operation.then(() => this.process(location, manifest));
    this.operation = run
      .catch((error: unknown) => {
        diagnostic("error", "transcription.workerFailed", {
          recordingID: manifest.recordingID,
          error: sanitizeError(error),
        });
      })
      .finally(() => this.scheduled.delete(manifest.recordingID));
  }

  private async process(
    location: RecordingLocation,
    manifest: RecordingManifest,
  ): Promise<void> {
    if (this.stopping || !this.config.transcriptionHook) return;
    const state = await readTranscriptionState(location);
    if (!state || state.status !== "pending") return;

    state.status = "running";
    state.attempts += 1;
    state.startedAt = new Date().toISOString();
    state.completedAt = null;
    state.error = null;
    await writeTranscriptionState(location, state);

    const pendingTranscript = pendingTranscriptPathFor(location);
    await rm(pendingTranscript, { force: true });

    try {
      if (!manifest.audioFile) throw new Error("Recording has no audio file");
      const result = await this.runHook(location);
      diagnostic(
        result.code === 0 ? "debug" : "warn",
        "transcription.hookFinished",
        {
          recordingID: manifest.recordingID,
          exitCode: result.code,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      );
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() ||
            `Transcription hook exited with code ${String(result.code)}${result.signal ? ` (${result.signal})` : ""}`,
        );
      }
      const transcript = validateTranscriptContext(
        transcriptDocumentSchema.parse(await readJSON(pendingTranscript)),
        manifest,
        await loadIntervals(location),
      );
      await rename(
        pendingTranscript,
        path.join(location.directory, "transcript.json"),
      );
      await atomicWriteText(
        path.join(location.directory, "transcript.txt"),
        `${transcript.text.replace(/\s+$/, "")}\n`,
      );

      state.status = "complete";
      state.completedAt = new Date().toISOString();
      state.error = null;
      await writeTranscriptionState(location, state);
      diagnostic("info", "transcription.completed", {
        recordingID: manifest.recordingID,
        segmentCount: transcript.segments.length,
      });
      void invokeHook(
        this.paths,
        this.config,
        "transcription.completed",
        location,
        manifest,
        {
          transcription: {
            status: state.status,
            transcriptJSON: "transcript.json",
            transcriptText: "transcript.txt",
          },
        },
      );
    } catch (error) {
      if (this.stopping) {
        state.status = "pending";
        state.startedAt = null;
        state.error = null;
        await writeTranscriptionState(location, state);
        return;
      }
      state.status = "failed";
      state.completedAt = null;
      state.error = sanitizeError(error);
      await writeTranscriptionState(location, state);
      diagnostic("error", "transcription.failed", {
        recordingID: manifest.recordingID,
        error: state.error,
      });
      void invokeHook(
        this.paths,
        this.config,
        "transcription.failed",
        location,
        manifest,
        { transcription: { status: state.status, error: state.error } },
      );
    }
  }

  private runHook(
    location: RecordingLocation,
  ): Promise<HookRunResult> {
    const executable = this.config.transcriptionHook;
    if (!executable) throw new Error("Transcription hook is not configured");
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [location.directory], {
        cwd: location.directory,
        env: {
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < 16_384) stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 16_384) stderr += chunk;
      });
      child.once("error", (error) => {
        if (this.child === child) this.child = null;
        reject(error);
      });
      child.once("close", (code, signal) => {
        if (this.child === child) this.child = null;
        resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() });
      });
      child.stdin.end();
    });
  }
}
