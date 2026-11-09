import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, rm, link } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { GuildscribePaths } from "./config.js";
import { loadConfig } from "./config.js";
import { databaseCall, databasePathFor } from "./storage.js";
import {
  GuildscribeError,
  messageResultSchema,
  segmentResultSchema,
  transcriptMetadataSchema,
} from "./protocol.js";

type Row = Record<string, unknown>;
export const transcriptExportSchema = transcriptMetadataSchema
  .extend({
    version: z.literal(1),
    segments: z.array(segmentResultSchema),
  })
  .strict();

export interface HistoryOptions {
  channel?: string;
  author?: string;
  speaker?: string;
  after?: string;
  before?: string;
  limit?: string;
  cursor?: string;
  includeThreads?: boolean;
  includeSegments?: boolean;
}
const invalid = (message: string): never => {
  throw new GuildscribeError("invalid_history_request", message);
};
export const requireDatabase = async (
  paths: GuildscribePaths,
): Promise<string> => {
  const file = databasePathFor(paths.home);
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new GuildscribeError(
        "database_not_found",
        "No Guildscribe database exists; start the daemon to initialize or migrate it",
      );
    throw error;
  }
  return file;
};
const validateID = (value: string, recording = false): string => {
  if (
    !(recording ? z.uuid() : z.string().regex(/^\d{15,22}$/)).safeParse(value)
      .success
  )
    invalid("Invalid " + (recording ? "recording" : "Discord") + " ID");
  return value;
};
const settings = (options: HistoryOptions) => {
  const limit = Number(options.limit ?? "50");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    invalid("limit must be an integer from 1 to 200");
  for (const value of [options.channel, options.author, options.speaker])
    if (value !== undefined) validateID(value);
  const date = (value: string | undefined) => {
    if (value === undefined) return null;
    if (!z.iso.datetime({ offset: true }).safeParse(value).success)
      invalid("Dates must be ISO 8601 timestamps with a timezone");
    return Date.parse(value);
  };
  const after = date(options.after),
    before = date(options.before);
  if (after !== null && before !== null && after >= before)
    invalid("after must precede before");
  return { limit, after, before };
};
export const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string(),
    key: z
      .array(z.union([z.string(), z.number()]))
      .min(1)
      .max(3),
  })
  .strict();
const scopeFor = (
  kind: string,
  query: string | undefined,
  options: HistoryOptions,
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        query ?? null,
        options.channel ?? null,
        options.author ?? null,
        options.speaker ?? null,
        options.after ?? null,
        options.before ?? null,
        Boolean(options.includeThreads),
      ]),
    )
    .digest("hex");
const decode = (
  cursor: string | undefined,
  scope: string,
): Array<string | number> | null => {
  if (!cursor) return null;
  try {
    if (cursor.length > 2048) throw new Error();
    const data = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (data.scope !== scope) throw new Error();
    return data.key;
  } catch {
    return invalid("Cursor is malformed or belongs to different filters");
  }
};
const encode = (scope: string, key: Array<string | number>) =>
  Buffer.from(JSON.stringify({ version: 1, scope, key })).toString("base64url");
const queryRows = async (db: string, sql: string, params: unknown[]) => {
  try {
    const [rows] = await databaseCall(db, [{ sql, params, mode: "all" }]);
    return rows as Row[];
  } catch (error) {
    if (
      error instanceof Error &&
      /fts5:|unterminated string|no such column|syntax error/.test(
        error.message,
      )
    )
      throw new GuildscribeError(
        "invalid_search_query",
        "Invalid FTS5 search expression",
      );
    throw error;
  }
};
const message = (r: Row) =>
  messageResultSchema.parse({
    messageID: r.message_id,
    guildID: r.guild_id,
    channelID: r.channel_id,
    parentChannelID: r.parent_channel_id,
    channelName: r.channel_name,
    authorID: r.author_id,
    authorUsername: r.author_username,
    authorDisplayName: r.author_display_name,
    authorIsBot: Boolean(r.author_is_bot),
    webhookID: r.webhook_id,
    messageType: r.message_type,
    content: r.content,
    replyToMessageID: r.reply_to_message_id,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    observedAt: r.observed_at,
    attachments: JSON.parse(String(r.attachments_json)),
    embeds: JSON.parse(String(r.embeds_json)),
  });
const segment = (r: Row) =>
  segmentResultSchema.parse({
    segmentID: r.segment_id,
    recordingID: r.recording_id,
    segmentIndex: r.segment_index,
    startOffsetMs: r.start_offset_ms,
    endOffsetMs: r.end_offset_ms,
    text: r.text,
    sourceIntervalID: r.source_interval_id,
    speakerUserID: r.speaker_user_id,
    speakerUsername: r.speaker_username,
    speakerDisplayName: r.speaker_display_name,
  });
const metadata = (r: Row) =>
  transcriptMetadataSchema.parse({
    recordingID: r.recording_id,
    status: r.status,
    attempts: r.attempts,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    error: r.error,
    language: r.language,
    segmentCount: r.segment_count,
  });
export const getMessage = async (paths: GuildscribePaths, id: string) => {
  const rows = await queryRows(
    await requireDatabase(paths),
    "SELECT * FROM messages WHERE message_id = ?",
    [validateID(id)],
  );
  if (!rows[0])
    throw new GuildscribeError(
      "message_not_found",
      "Message is not stored locally",
    );
  return message(rows[0]);
};
export const listHistory = async (
  paths: GuildscribePaths,
  kind: "messages" | "transcript",
  options: HistoryOptions,
  query?: string,
) => {
  const { limit, after, before } = settings(options);
  if (query !== undefined && (!query.trim() || query.length > 1000))
    invalid("Search query must contain 1 to 1000 characters");
  if (options.includeThreads && !options.channel)
    invalid("include-threads requires channel");
  const db = await requireDatabase(paths),
    scope = scopeFor(kind, query, options),
    cursor = decode(options.cursor, scope);
  const clauses: string[] = [],
    params: unknown[] = [];
  const add = (sql: string, ...values: unknown[]) => {
    clauses.push(sql);
    params.push(...values);
  };
  const messages = kind === "messages";
  const time = messages ? "m.created_at" : "r.started_at";
  if (query !== undefined)
    add(
      `${messages ? "messages_fts" : "transcript_segments_fts"} MATCH ?`,
      query,
    );
  if (options.channel) {
    if (messages && options.includeThreads)
      add(
        "(m.channel_id = ? OR m.parent_channel_id = ?)",
        options.channel,
        options.channel,
      );
    else add(`${messages ? "m" : "r"}.channel_id = ?`, options.channel);
  }
  if (options.author) add("m.author_id = ?", options.author);
  if (options.speaker) add("s.speaker_user_id = ?", options.speaker);
  if (after !== null) add(`${time} >= ?`, after);
  if (before !== null) add(`${time} < ?`, before);
  if (cursor) {
    const count = messages ? 2 : 3;
    if (
      cursor.length !== count ||
      typeof cursor[0] !== "number" ||
      typeof cursor[1] !== "string" ||
      (!messages && typeof cursor[2] !== "number")
    )
      invalid("Invalid cursor key");
    add(
      messages
        ? "(m.created_at,m.message_id) > (?,?)"
        : "(r.started_at,s.recording_id,s.segment_index) > (?,?,?)",
      ...cursor,
    );
  }
  const from = messages
    ? `messages m ${query !== undefined ? "JOIN messages_fts ON messages_fts.rowid = m.message_row_id" : ""}`
    : `transcript_segments s JOIN recordings r ON r.recording_id=s.recording_id ${query !== undefined ? "JOIN transcript_segments_fts ON transcript_segments_fts.rowid=s.segment_id" : ""}`;
  const rows = await queryRows(
    db,
    `SELECT ${messages ? "m.*" : "s.*,r.channel_id,r.channel_name,r.started_at AS recording_started_at"} FROM ${from} ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY ${messages ? "m.created_at,m.message_id" : "r.started_at,s.recording_id,s.segment_index"} LIMIT ?`,
    [...params, limit + 1],
  );
  const selected = rows.slice(0, limit),
    last = selected.at(-1);
  return {
    items: selected.map((r) =>
      messages
        ? message(r)
        : {
            ...segment(r),
            channelID: r.channel_id,
            channelName: r.channel_name,
            recordingStartedAt: r.recording_started_at,
          },
    ),
    nextCursor:
      rows.length > limit && last
        ? encode(
            scope,
            messages
              ? [Number(last.created_at), String(last.message_id)]
              : [
                  Number(last.recording_started_at),
                  String(last.recording_id),
                  Number(last.segment_index),
                ],
          )
        : null,
  };
};
export const getTranscript = async (
  paths: GuildscribePaths,
  id: string,
  options: HistoryOptions = {},
) => {
  validateID(id, true);
  const { limit } = settings(options);
  const scope = scopeFor("segments:" + id, undefined, {});
  const cursor = decode(options.cursor, scope);
  if (options.cursor && !options.includeSegments)
    invalid("cursor requires include-segments");
  if (
    cursor &&
    (cursor.length !== 1 ||
      !Number.isInteger(cursor[0]) ||
      Number(cursor[0]) < 0)
  )
    invalid("Invalid segment cursor");
  const [heads, rows] = await databaseCall(await requireDatabase(paths), [
    {
      sql: "SELECT t.*, (SELECT count(*) FROM transcript_segments s WHERE s.recording_id=t.recording_id) AS segment_count FROM transcripts t WHERE recording_id=?",
      params: [id],
      mode: "all",
    },
    {
      sql: "SELECT * FROM transcript_segments WHERE recording_id=? AND segment_index>? ORDER BY segment_index LIMIT ?",
      params: [id, cursor?.[0] ?? -1, options.includeSegments ? limit + 1 : 0],
      mode: "all",
    },
  ]);
  const header = (heads as Row[])[0];
  if (!header)
    throw new GuildscribeError(
      "transcript_not_found",
      "No transcription has been queued for this recording",
    );
  const segments = (rows as Row[]).slice(0, limit).map(segment);
  return {
    ...metadata(header),
    ...(options.includeSegments ? { segments } : {}),
    nextCursor:
      (rows as Row[]).length > limit
        ? encode(scope, [segments.at(-1)!.segmentIndex])
        : null,
  };
};
export const newDestination = async (destination: string) => {
  if (!path.isAbsolute(destination))
    invalid("destination must be an absolute path");
  try {
    await lstat(destination);
    throw new GuildscribeError(
      "invalid_destination_exists",
      "Destination already exists",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = await lstat(path.dirname(destination));
  if (!parent.isDirectory()) invalid("Destination parent must be a directory");
};
const digest = async (file: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
export const exportTranscript = async (
  paths: GuildscribePaths,
  id: string,
  destination: string,
  format: string,
  dryRun: boolean,
) => {
  validateID(id, true);
  if (!["txt", "json", "srt", "vtt"].includes(format))
    invalid("format must be txt, json, srt, or vtt");
  await newDestination(destination);
  const [heads, rows] = await databaseCall(await requireDatabase(paths), [
    {
      sql: "SELECT t.*, (SELECT count(*) FROM transcript_segments s WHERE s.recording_id=t.recording_id) AS segment_count FROM transcripts t WHERE recording_id=?",
      params: [id],
      mode: "all",
    },
    {
      sql: "SELECT * FROM transcript_segments WHERE recording_id=? ORDER BY segment_index",
      params: [id],
      mode: "all",
    },
  ]);
  const header = (heads as Row[])[0];
  if (!header)
    throw new GuildscribeError("transcript_not_found", "Transcript not found");
  if (header.status !== "complete")
    throw new GuildscribeError(
      "invalid_transcript_state",
      "Only completed transcripts can be exported",
    );
  const segments = (rows as Row[]).map(segment);
  const timestamp = (ms: number) => {
    const hour = Math.floor(ms / 3600000),
      minute = Math.floor(ms / 60000) % 60,
      second = Math.floor(ms / 1000) % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${format === "srt" ? "," : "."}${String(ms % 1000).padStart(3, "0")}`;
  };
  const text =
    format === "json"
      ? JSON.stringify(
          transcriptExportSchema.parse({
            version: 1,
            ...metadata(header),
            segments,
          }),
          null,
          2,
        ) + "\n"
      : format === "txt"
        ? segments.map((s) => s.text.trim()).join("\n") +
          (segments.length ? "\n" : "")
        : (format === "vtt" ? "WEBVTT\n\n" : "") +
          segments
            .map(
              (s, index) =>
                `${format === "srt" ? String(index + 1) + "\n" : ""}${timestamp(s.startOffsetMs)} --> ${timestamp(s.endOffsetMs)}\n${s.text
                  .replace(/[\r\n]+/g, " ")
                  .replace(/&/g, "&amp;")
                  .replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;")}\n\n`,
            )
            .join("");
  const bytes = Buffer.byteLength(text),
    sha256 = createHash("sha256").update(text).digest("hex");
  if (!dryRun) {
    const handle = await open(destination, "wx", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(destination, { force: true });
      throw error;
    }
    await handle.close();
  }
  return {
    recordingID: id,
    format,
    destination,
    changed: !dryRun,
    dryRun,
    bytes,
    sha256,
  };
};
export const retryTranscript = async (
  paths: GuildscribePaths,
  id: string,
  dryRun: boolean,
) => {
  validateID(id, true);
  const db = await requireDatabase(paths);
  const config = await loadConfig(paths);
  if (!config.transcriptionHook)
    throw new GuildscribeError(
      "configuration_transcription_disabled",
      "No transcription hook is configured",
    );
  const rows = await queryRows(
    db,
    "SELECT t.*,r.status AS recording_status FROM transcripts t JOIN recordings r USING(recording_id) WHERE recording_id=?",
    [id],
  );
  const row = rows[0];
  if (!row)
    throw new GuildscribeError("transcript_not_found", "Transcript not found");
  if (row.recording_status !== "complete")
    invalid("Recording audio is not complete");
  if (row.status === "complete")
    invalid("Completed transcription cannot be retried");
  if (!["failed", "pending", "running"].includes(String(row.status)))
    invalid("Unsupported transcription state");
  let changed = false;
  if (row.status === "failed" && !dryRun) {
    const [result] = await databaseCall(
      db,
      [
        {
          sql: "UPDATE transcripts SET status='pending',queued_at=?,started_at=NULL,finished_at=NULL,error=NULL,language=NULL WHERE recording_id=? AND status='failed' AND attempts=?",
          params: [Date.now(), id, row.attempts],
        },
      ],
      true,
    );
    changed = Number((result as Row).changes) === 1;
  }
  const current = await getTranscript(paths, id);
  return {
    recordingID: id,
    changed,
    dryRun,
    status: dryRun && row.status === "failed" ? "pending" : current.status,
    attempts: current.attempts,
  };
};
export const databaseStatus = async (paths: GuildscribePaths) => {
  const db = await requireDatabase(paths);
  const [version, counts] = await databaseCall(db, [
    { sql: "PRAGMA user_version", mode: "get" },
    {
      sql: "SELECT (SELECT count(*) FROM messages) AS messages,(SELECT count(*) FROM recordings) AS recordings,(SELECT count(*) FROM transcripts) AS transcripts,(SELECT count(*) FROM transcript_segments) AS transcriptSegments",
      mode: "get",
    },
  ]);
  let walBytes = 0;
  try {
    walBytes = (await lstat(db + "-wal")).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    databasePath: db,
    schemaVersion: (version as Row).user_version,
    databaseBytes: (await lstat(db)).size,
    walBytes,
    counts,
  };
};
export const backupDatabase = async (
  paths: GuildscribePaths,
  destination: string,
  dryRun: boolean,
) => {
  const db = await requireDatabase(paths);
  await newDestination(destination);
  if (dryRun)
    return { destination, changed: false, dryRun, bytes: null, sha256: null };
  const temporary = path.join(
    path.dirname(destination),
    `.guildscribe-backup-${randomUUID()}.sqlite`,
  );
  try {
    await databaseCall(db, [], false, temporary);
    const bytes = (await lstat(temporary)).size,
      sha256 = await digest(temporary);
    await link(temporary, destination);
    return { destination, changed: true, dryRun, bytes, sha256 };
  } finally {
    await rm(temporary, { force: true });
  }
};
export const verifyDatabase = async (paths: GuildscribePaths) => {
  const [result] = await databaseCall(
    await requireDatabase(paths),
    [],
    false,
    undefined,
    true,
  );
  return result as {
    passed: boolean;
    checks: Array<{ name: string; passed: boolean; detail: string }>;
  };
};
