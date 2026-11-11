import { Worker } from "node:worker_threads";
import path from "node:path";
import type { Statement } from "./databaseWorker.js";
import type { RecordingManifest, RecordingLocation } from "./recording.js";
import type { TranscriptDocument } from "./transcription.js";

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (value: unknown[]) => void; reject: (error: Error) => void }
>();
export const databasePathFor = (home: string): string =>
  path.join(home, "guildscribe.sqlite");
export const homeForRecording = (location: RecordingLocation): string => {
  const directory = path.resolve(location.directory);
  const parent = path.dirname(directory);
  if (path.basename(parent) === "in-progress") return path.dirname(parent);
  const root = path.dirname(path.dirname(parent));
  if (path.basename(root) === "recordings") return path.dirname(root);
  throw new Error(
    "Recording directory must be under in-progress or recordings/year/month",
  );
};
export const databaseForRecording = (location: RecordingLocation): string =>
  databasePathFor(homeForRecording(location));
export const databaseCall = (
  databasePath: string,
  statements: Statement[],
  write = false,
  backupPath?: string,
  verify = false,
): Promise<unknown[]> => {
  if (!worker) {
    worker = new Worker(new URL("./databaseWorker.js", import.meta.url), {
      // This worker runs compiled JavaScript and needs no parent CLI flags.
      // Explicitly inherited V8/process-only flags can make Worker reject startup.
      execArgv: [],
    });
    const activeWorker = worker;
    worker.on(
      "message",
      (response: { id: number; result: unknown[]; error?: string }) => {
        const task = pending.get(response.id);
        pending.delete(response.id);
        if (response.error) task?.reject(new Error(response.error));
        else task?.resolve(response.result);
        if (!pending.size) worker?.unref();
      },
    );
    const fail = (error: Error) => {
      if (worker !== activeWorker) return;
      for (const task of pending.values()) task.reject(error);
      pending.clear();
      worker = undefined;
    };
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (worker !== activeWorker) return;
      if (pending.size) fail(new Error(`Database worker exited (${code})`));
      else worker = undefined;
    });
  }
  worker.ref();
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    worker!.postMessage({
      id,
      databasePath,
      statements,
      write,
      ...(backupPath ? { backupPath } : {}),
      verify,
    });
  });
};
export const upsert = (
  table: string,
  row: Record<string, unknown>,
  key: string,
  suffix = "",
): Statement => {
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((c) => `@${c}`).join(",")}) ON CONFLICT(${key}) DO UPDATE SET ${columns
      .filter((c) => c !== key)
      .map((c) => `${c}=excluded.${c}`)
      .join(",")} ${suffix}`,
    params: row,
  };
};
const ms = (value: string | null) =>
  value === null ? null : Date.parse(value);
const iso = (value: unknown) =>
  value === null ? null : new Date(Number(value)).toISOString();
export const recordingStatement = (
  location: RecordingLocation,
  m: RecordingManifest,
): Statement =>
  upsert(
    "recordings",
    {
      recording_id: m.recordingID,
      guild_id: m.guildID,
      guild_name: m.guildName,
      channel_id: m.channelID,
      channel_name: m.channelName,
      status: m.status,
      started_at: ms(m.startedAt),
      updated_at: ms(m.updatedAt),
      ended_at: ms(m.endedAt),
      duration_ms: m.durationMs,
      recovered_after_restart: Number(m.recoveredAfterRestart),
      error: m.error,
      directory_path: path
        .relative(homeForRecording(location), location.directory)
        .split(path.sep)
        .join("/"),
    },
    "recording_id",
  );
export const storeRecording = async (
  location: RecordingLocation,
  manifest: RecordingManifest,
): Promise<void> => {
  await databaseCall(
    databaseForRecording(location),
    [recordingStatement(location, manifest)],
    true,
  );
};
export const loadRecording = async (
  location: RecordingLocation,
): Promise<unknown | null> => {
  const [value] = await databaseCall(databaseForRecording(location), [
    {
      sql: "SELECT * FROM recordings WHERE recording_id = ?",
      params: [path.basename(location.directory)],
      mode: "get",
    },
  ]);
  if (!value) return null;
  const r = value as Record<string, unknown>;
  return {
    schemaVersion: 1,
    recordingID: r.recording_id,
    guildID: r.guild_id,
    guildName: r.guild_name,
    channelID: r.channel_id,
    channelName: r.channel_name,
    status: r.status,
    startedAt: iso(r.started_at),
    updatedAt: iso(r.updated_at),
    endedAt: iso(r.ended_at),
    durationMs: r.duration_ms,
    recoveredAfterRestart: Boolean(r.recovered_after_restart),
    error: r.error,
  };
};
export interface SegmentSpeaker {
  userID: string | null;
  username: string | null;
  displayName: string | null;
}
export const transcriptStatements = (
  document: TranscriptDocument,
  speakers: SegmentSpeaker[],
): Statement[] => [
  upsert(
    "transcripts",
    {
      recording_id: document.recordingID,
      status: document.status,
      attempts: document.attempts,
      queued_at: ms(document.queuedAt),
      started_at: ms(document.startedAt),
      finished_at: ms(document.finishedAt),
      error: document.error,
      language: document.result?.language ?? null,
    },
    "recording_id",
  ),
  {
    sql: "DELETE FROM transcript_segments WHERE recording_id = ?",
    params: [document.recordingID],
  },
  ...(document.result?.segments ?? []).map((s, index) => ({
    sql: "INSERT INTO transcript_segments (recording_id,segment_index,start_offset_ms,end_offset_ms,text,source_interval_id,speaker_user_id,speaker_username,speaker_display_name) VALUES (?,?,?,?,?,?,?,?,?)",
    params: [
      document.recordingID,
      index,
      s.startOffsetMs,
      s.endOffsetMs,
      s.text,
      s.sourceIntervalID ?? null,
      speakers[index]?.userID ?? null,
      speakers[index]?.username ?? null,
      speakers[index]?.displayName ?? null,
    ],
  })),
];
export const loadTranscript = async (
  location: RecordingLocation,
): Promise<unknown | null> => {
  const [value, segments] = await databaseCall(databaseForRecording(location), [
    {
      sql: "SELECT * FROM transcripts WHERE recording_id = ?",
      params: [path.basename(location.directory)],
      mode: "get",
    },
    {
      sql: "SELECT * FROM transcript_segments WHERE recording_id = ? ORDER BY segment_index",
      params: [path.basename(location.directory)],
      mode: "all",
    },
  ]);
  if (!value) return null;
  const r = value as Record<string, unknown>;
  return {
    schemaVersion: 1,
    recordingID: r.recording_id,
    status: r.status,
    attempts: r.attempts,
    queuedAt: iso(r.queued_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    error: r.error,
    result:
      r.status === "complete"
        ? {
            language: r.language,
            segments: (segments as Record<string, unknown>[]).map((s) => ({
              startOffsetMs: s.start_offset_ms,
              endOffsetMs: s.end_offset_ms,
              text: s.text,
              ...(s.source_interval_id
                ? { sourceIntervalID: s.source_interval_id }
                : {}),
            })),
          }
        : null,
  };
};
