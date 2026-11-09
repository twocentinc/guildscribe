import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { GuildscribeConfig, GuildscribePaths } from "./config.js";
import { invokeHook } from "./hooks.js";
import {
  loadIntervals,
  locationForDirectory,
  readManifest,
  recordingIDSchema,
  writeJSON,
  type RecordingLocation,
  type RecordingManifest,
  type RecordingInterval,
} from "./recording.js";
import { diagnostic, sanitizeError } from "./protocol.js";

export type TranscriptionStatus = "pending" | "running" | "complete" | "failed";

const languageTagSchema = z
  .string()
  .min(1)
  .refine((language) => {
    try {
      Intl.getCanonicalLocales(language);
      return true;
    } catch {
      return false;
    }
  }, "language must be a valid BCP 47 tag");

const transcriptSegmentSchema = z
  .object({
    startOffsetMs: z.number().int().min(0),
    endOffsetMs: z.number().int().min(0),
    text: z.string().refine((text) => text.trim().length > 0, {
      message: "segment text must not be empty",
    }),
    sourceIntervalID: z.uuid().optional(),
  })
  .strict()
  .refine((segment) => segment.endOffsetMs > segment.startOffsetMs, {
    message: "endOffsetMs must be greater than startOffsetMs",
    path: ["endOffsetMs"],
  });

export const transcriptResultSchema = z
  .object({
    language: languageTagSchema.nullable(),
    segments: z.array(transcriptSegmentSchema),
  })
  .strict()
  .superRefine((result, context) => {
    for (let index = 1; index < result.segments.length; index += 1) {
      const previous = result.segments[index - 1];
      const current = result.segments[index];
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
  });

export type TranscriptResult = z.infer<typeof transcriptResultSchema>;

export const transcriptDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordingID: recordingIDSchema,
    status: z.enum(["pending", "running", "complete", "failed"]),
    attempts: z.number().int().min(0),
    queuedAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    error: z.string().min(1).nullable(),
    result: transcriptResultSchema.nullable(),
  })
  .strict()
  .superRefine((document, context) => {
    const issue = (property: keyof typeof document, message: string): void =>
      context.addIssue({
        code: "custom",
        path: [property],
        message,
        input: document[property],
      });
    const queuedAt = Date.parse(document.queuedAt);
    if (document.startedAt && Date.parse(document.startedAt) < queuedAt) {
      issue("startedAt", "startedAt must not precede queuedAt");
    }
    if (
      document.finishedAt &&
      (!document.startedAt ||
        Date.parse(document.finishedAt) < Date.parse(document.startedAt))
    ) {
      issue("finishedAt", "finishedAt must not precede startedAt");
    }
    if (document.status === "pending") {
      if (document.startedAt !== null)
        issue("startedAt", "pending must not have startedAt");
      if (document.finishedAt !== null)
        issue("finishedAt", "pending must not have finishedAt");
      if (document.error !== null)
        issue("error", "pending must not have error");
      if (document.result !== null)
        issue("result", "pending must not have a result");
    }
    if (document.status === "running") {
      if (document.attempts < 1)
        issue("attempts", "running requires an attempt");
      if (document.startedAt === null)
        issue("startedAt", "running requires startedAt");
      if (document.finishedAt !== null)
        issue("finishedAt", "running must not have finishedAt");
      if (document.error !== null)
        issue("error", "running must not have error");
      if (document.result !== null)
        issue("result", "running must not have a result");
    }
    if (document.status === "complete") {
      if (document.attempts < 1)
        issue("attempts", "complete requires an attempt");
      if (document.startedAt === null)
        issue("startedAt", "complete requires startedAt");
      if (document.finishedAt === null)
        issue("finishedAt", "complete requires finishedAt");
      if (document.error !== null)
        issue("error", "complete must not have error");
      if (document.result === null)
        issue("result", "complete requires a result");
    }
    if (document.status === "failed") {
      if (document.attempts < 1)
        issue("attempts", "failed requires an attempt");
      if (document.startedAt === null)
        issue("startedAt", "failed requires startedAt");
      if (document.finishedAt === null)
        issue("finishedAt", "failed requires finishedAt");
      if (document.error === null) issue("error", "failed requires error");
      if (document.result !== null)
        issue("result", "failed must not have a result");
    }
  });

export type TranscriptDocument = z.infer<typeof transcriptDocumentSchema>;
export type TranscriptionState = TranscriptDocument;

const legacyTranscriptionStateSchema = z
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
  .strict();

const legacyTranscriptDocumentSchema = z
  .object({
    version: z.literal(1),
    recordingID: recordingIDSchema,
    createdAt: z.iso.datetime(),
    language: z.string().min(1).nullable(),
    text: z.string(),
    segments: z.array(
      z
        .object({
          startOffsetMs: z.number().int().min(0),
          endOffsetMs: z.number().int().min(0),
          text: z.string().min(1),
          sourceIntervalIDs: z.array(z.uuid()).min(1).optional(),
          speaker: z.unknown().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const transcriptPathFor = (location: RecordingLocation): string =>
  path.join(location.directory, "transcript.json");
const legacyStatePathFor = (location: RecordingLocation): string =>
  path.join(location.directory, "transcription.json");
const pendingResultPathFor = (location: RecordingLocation): string =>
  path.join(location.directory, ".transcript-result.json.pending");
const readJSON = async (candidate: string): Promise<unknown> =>
  JSON.parse(await readFile(candidate, "utf8")) as unknown;

const validateTranscriptContext = (
  result: TranscriptResult,
  manifest: RecordingManifest,
  intervals: RecordingInterval[],
): TranscriptResult => {
  const intervalByID = new Map(
    intervals.map((interval) => [interval.intervalID, interval]),
  );
  for (const segment of result.segments) {
    if (
      manifest.durationMs !== null &&
      segment.endOffsetMs > manifest.durationMs
    ) {
      throw new Error("Transcript segment exceeds the recording duration");
    }
    if (!segment.sourceIntervalID) continue;
    const interval = intervalByID.get(segment.sourceIntervalID);
    if (!interval) {
      throw new Error(
        `Transcript references unknown interval ${segment.sourceIntervalID}`,
      );
    }
    if (interval.kind !== "speaking") {
      throw new Error(
        `Transcript source interval ${segment.sourceIntervalID} is not speaking audio`,
      );
    }
    if (
      !(
        interval.startOffsetMs < segment.endOffsetMs &&
        interval.endOffsetMs > segment.startOffsetMs
      )
    ) {
      throw new Error(
        `Transcript source interval ${segment.sourceIntervalID} does not overlap its segment`,
      );
    }
  }
  return result;
};

const legacyResult = (input: unknown): TranscriptResult => {
  const legacy = legacyTranscriptDocumentSchema.parse(input);
  return transcriptResultSchema.parse({
    language: legacy.language,
    segments: legacy.segments.map((segment) => ({
      startOffsetMs: segment.startOffsetMs,
      endOffsetMs: segment.endOffsetMs,
      text: segment.text,
      ...(segment.sourceIntervalIDs?.length === 1
        ? { sourceIntervalID: segment.sourceIntervalIDs[0] }
        : {}),
    })),
  });
};

const readLegacyState = async (
  location: RecordingLocation,
): Promise<z.infer<typeof legacyTranscriptionStateSchema> | null> => {
  try {
    return legacyTranscriptionStateSchema.parse(
      await readJSON(legacyStatePathFor(location)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export const readTranscriptionState = async (
  location: RecordingLocation,
): Promise<TranscriptDocument | null> => {
  try {
    const input = await readJSON(transcriptPathFor(location));
    const canonical = transcriptDocumentSchema.safeParse(input);
    if (canonical.success) {
      if (canonical.data.recordingID !== path.basename(location.directory)) {
        throw new Error("Transcript recordingID does not match its directory");
      }
      return canonical.data;
    }
    const legacy = legacyTranscriptDocumentSchema.parse(input);
    const state = await readLegacyState(location);
    if (!state || state.status !== "complete") {
      throw new Error("Legacy transcript has no complete transcription state");
    }
    return transcriptDocumentSchema.parse({
      schemaVersion: 1,
      recordingID: legacy.recordingID,
      status: "complete",
      attempts: state.attempts,
      queuedAt: state.createdAt,
      startedAt: state.startedAt,
      finishedAt: state.completedAt,
      error: null,
      result: legacyResult(input),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const state = await readLegacyState(location);
  if (!state) return null;
  return transcriptDocumentSchema.parse({
    schemaVersion: 1,
    recordingID: state.recordingID,
    status: state.status,
    attempts: state.attempts,
    queuedAt: state.createdAt,
    startedAt: state.startedAt,
    finishedAt: state.status === "failed" ? state.updatedAt : state.completedAt,
    error: state.error,
    result: null,
  });
};

export const readTranscript = async (
  location: RecordingLocation,
): Promise<TranscriptDocument> => {
  const [manifest, intervals, document] = await Promise.all([
    readManifest(location),
    loadIntervals(location),
    readTranscriptionState(location),
  ]);
  if (!document || document.status !== "complete" || !document.result) {
    throw new Error("Transcript is not complete");
  }
  validateTranscriptContext(document.result, manifest, intervals);
  return document;
};

const writeTranscriptDocument = async (
  location: RecordingLocation,
  document: TranscriptDocument,
): Promise<void> => {
  const validated = transcriptDocumentSchema.parse(document);
  if (validated.recordingID !== path.basename(location.directory)) {
    throw new Error("Transcript recordingID does not match its directory");
  }
  Object.assign(document, validated);
  await writeJSON(transcriptPathFor(location), validated);
};

export const renderTranscriptText = (result: TranscriptResult): string =>
  result.segments.length === 0
    ? ""
    : `${result.segments.map((segment) => segment.text.trim()).join("\n")}\n`;

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
        const document = await readTranscriptionState(location);
        if (
          !document ||
          (document.status !== "pending" && document.status !== "running")
        )
          continue;
        if (document.status === "running") {
          document.status = "pending";
          document.startedAt = null;
          document.finishedAt = null;
          document.error = null;
          document.result = null;
          await writeTranscriptDocument(location, document);
        }
        this.schedule(location, await readManifest(location));
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
      if (existing.status === "pending" || existing.status === "running")
        this.schedule(location, manifest);
      return false;
    }
    const timestamp = new Date().toISOString();
    await writeTranscriptDocument(location, {
      schemaVersion: 1,
      recordingID: manifest.recordingID,
      status: "pending",
      attempts: 0,
      queuedAt: timestamp,
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
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
    const document = await readTranscriptionState(location);
    if (!document || document.status !== "pending") return;

    document.status = "running";
    document.attempts += 1;
    document.startedAt = new Date().toISOString();
    document.finishedAt = null;
    document.error = null;
    document.result = null;
    await writeTranscriptDocument(location, document);

    const pendingResult = pendingResultPathFor(location);
    await rm(pendingResult, { force: true });
    try {
      const audio = await stat(path.join(location.directory, "audio.mp3"));
      if (!audio.isFile()) throw new Error("Recording has no audio.mp3 file");
      const hook = await this.runHook(location);
      diagnostic(
        hook.code === 0 ? "debug" : "warn",
        "transcription.hookFinished",
        {
          recordingID: manifest.recordingID,
          exitCode: hook.code,
          signal: hook.signal,
          stdout: hook.stdout,
          stderr: hook.stderr,
        },
      );
      if (hook.code !== 0) {
        throw new Error(
          hook.stderr.trim() ||
            `Transcription hook exited with code ${String(hook.code)}${hook.signal ? ` (${hook.signal})` : ""}`,
        );
      }
      const result = validateTranscriptContext(
        transcriptResultSchema.parse(await readJSON(pendingResult)),
        manifest,
        await loadIntervals(location),
      );
      await atomicWriteText(
        path.join(location.directory, "transcript.txt"),
        renderTranscriptText(result),
      );
      document.status = "complete";
      document.finishedAt = new Date().toISOString();
      document.error = null;
      document.result = result;
      await writeTranscriptDocument(location, document);
      await rm(pendingResult, { force: true }).catch(() => undefined);
      diagnostic("info", "transcription.completed", {
        recordingID: manifest.recordingID,
        segmentCount: result.segments.length,
      });
      void invokeHook(
        this.paths,
        this.config,
        "transcription.completed",
        location,
        manifest,
        {
          transcription: {
            status: document.status,
            transcriptJSON: "transcript.json",
            transcriptText: "transcript.txt",
          },
        },
      );
    } catch (error) {
      if (this.stopping) {
        document.status = "pending";
        document.startedAt = null;
        document.finishedAt = null;
        document.error = null;
        document.result = null;
        await writeTranscriptDocument(location, document);
        return;
      }
      document.status = "failed";
      document.finishedAt = new Date().toISOString();
      document.error = sanitizeError(error);
      document.result = null;
      await writeTranscriptDocument(location, document);
      diagnostic("error", "transcription.failed", {
        recordingID: manifest.recordingID,
        error: document.error,
      });
      void invokeHook(
        this.paths,
        this.config,
        "transcription.failed",
        location,
        manifest,
        {
          transcription: { status: document.status, error: document.error },
        },
      );
    }
  }

  private runHook(location: RecordingLocation): Promise<HookRunResult> {
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
