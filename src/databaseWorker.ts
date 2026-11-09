import { parentPort } from "node:worker_threads";
import { chmodSync, existsSync, lstatSync, openSync, closeSync } from "node:fs";
import Database from "better-sqlite3";

// All synchronous SQLite work stays off the Discord/audio event loop.
export const schemaSQL = `
CREATE TABLE recordings (
 recording_id TEXT PRIMARY KEY NOT NULL, guild_id TEXT NOT NULL, guild_name TEXT,
 channel_id TEXT NOT NULL, channel_name TEXT, status TEXT NOT NULL,
 started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER,
 duration_ms INTEGER, recovered_after_restart INTEGER NOT NULL DEFAULT 0, error TEXT,
 directory_path TEXT NOT NULL UNIQUE);
CREATE INDEX recordings_channel_started_idx ON recordings(channel_id, started_at);
CREATE TABLE transcripts (
 recording_id TEXT PRIMARY KEY NOT NULL REFERENCES recordings(recording_id),
 status TEXT NOT NULL, attempts INTEGER NOT NULL, queued_at INTEGER NOT NULL,
 started_at INTEGER, finished_at INTEGER, error TEXT, language TEXT);
CREATE TABLE transcript_segments (
 segment_id INTEGER PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES transcripts(recording_id),
 segment_index INTEGER NOT NULL, start_offset_ms INTEGER NOT NULL, end_offset_ms INTEGER NOT NULL,
 text TEXT NOT NULL, source_interval_id TEXT, speaker_user_id TEXT, speaker_username TEXT,
 speaker_display_name TEXT, UNIQUE(recording_id, segment_index));
CREATE TABLE messages (
 message_row_id INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE,
 guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, parent_channel_id TEXT, channel_name TEXT,
 author_id TEXT NOT NULL, author_username TEXT NOT NULL, author_display_name TEXT,
 author_is_bot INTEGER NOT NULL, webhook_id TEXT, message_type INTEGER NOT NULL,
 content TEXT NOT NULL, reply_to_message_id TEXT, created_at INTEGER NOT NULL,
 edited_at INTEGER, observed_at INTEGER NOT NULL,
 attachments_json TEXT NOT NULL DEFAULT '[]', embeds_json TEXT NOT NULL DEFAULT '[]');
CREATE INDEX messages_channel_created_idx ON messages(channel_id, created_at, message_id);
`;

export interface Statement {
  sql: string;
  params?: Record<string, unknown> | unknown[];
  mode?: "get" | "all";
}

parentPort?.on(
  "message",
  async (request: {
    id: number;
    databasePath: string;
    write: boolean;
    statements: Statement[];
    backupPath?: string;
    verify?: boolean;
  }) => {
    let db: Database.Database | undefined;
    try {
      if (!existsSync(request.databasePath)) {
        if (!request.write) {
          parentPort!.postMessage({
            id: request.id,
            result: request.statements.map((s) =>
              s.mode === "all" ? [] : null,
            ),
          });
          return;
        }
        closeSync(openSync(request.databasePath, "wx", 0o600));
      }
      const info = lstatSync(request.databasePath);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error("Database must be an owner-only regular file");
      for (const suffix of ["-wal", "-shm"]) {
        const auxiliary = request.databasePath + suffix;
        if (!existsSync(auxiliary)) continue;
        const state = lstatSync(auxiliary);
        if (
          !state.isFile() ||
          state.isSymbolicLink() ||
          (state.mode & 0o077) !== 0 ||
          (process.getuid && state.uid !== process.getuid())
        )
          throw new Error("Unsafe database auxiliary file");
      }
      db = new Database(request.databasePath, {
        readonly: !request.write,
        fileMustExist: true,
        timeout: 5000,
      });
      db.pragma("foreign_keys = ON");
      const version = db.pragma("user_version", { simple: true });
      if (typeof version !== "number" || version > 1)
        throw new Error("Unsupported newer Guildscribe database schema");
      if (version === 0) {
        if (!request.write)
          throw new Error("Database requires initialization by the daemon");
        db.pragma("journal_mode = WAL");
        db.transaction(() => {
          db!.exec(schemaSQL);
          for (const [table, source, column, rowID] of [
            ["messages_fts", "messages", "content", "message_row_id"],
            [
              "transcript_segments_fts",
              "transcript_segments",
              "text",
              "segment_id",
            ],
          ]) {
            db!
              .exec(`CREATE VIRTUAL TABLE ${table} USING fts5(${column}, content='${source}', content_rowid='${rowID}', tokenize='unicode61');
CREATE TRIGGER ${table}_insert AFTER INSERT ON ${source} BEGIN
 INSERT INTO ${table}(rowid, ${column}) VALUES(new.${rowID}, new.${column}); END;
CREATE TRIGGER ${table}_delete AFTER DELETE ON ${source} BEGIN
 INSERT INTO ${table}(${table}, rowid, ${column}) VALUES('delete', old.${rowID}, old.${column}); END;
CREATE TRIGGER ${table}_update AFTER UPDATE OF ${column} ON ${source} BEGIN
 INSERT INTO ${table}(${table}, rowid, ${column}) VALUES('delete', old.${rowID}, old.${column});
 INSERT INTO ${table}(rowid, ${column}) VALUES(new.${rowID}, new.${column}); END;`);
          }
          db!.pragma("user_version = 1");
        })();
      }
      const execute = () =>
        request.statements.map((s) => {
          const statement = db!.prepare(s.sql);
          const args =
            s.params === undefined
              ? []
              : Array.isArray(s.params)
                ? s.params
                : [s.params];
          if (s.mode === "all") return statement.all(...args);
          if (s.mode === "get") return statement.get(...args) ?? null;
          return statement.run(...args);
        });
      let result = request.write
        ? db.transaction(execute)()
        : db.transaction(execute).deferred();
      if (request.verify) {
        // FTS integrity commands require writes. Execute them only on a private
        // in-memory snapshot, preserving the source database and its indexes.
        const serialized = db.serialize();
        // SQLite documents this WAL-to-memory header conversion:
        // https://www.sqlite.org/c3ref/deserialize.html
        serialized[18] = 1;
        serialized[19] = 1;
        const snapshot = new Database(serialized);
        const checks: Array<{ name: string; passed: boolean; detail: string }> =
          [];
        try {
          const integrity = snapshot.pragma("integrity_check") as Array<
            Record<string, unknown>
          >;
          const good = integrity.every((row) => Object.values(row)[0] === "ok");
          checks.push({
            name: "sqlite",
            passed: good,
            detail: good
              ? "SQLite integrity is valid"
              : "SQLite integrity errors detected",
          });
          const foreign = snapshot.pragma("foreign_key_check") as unknown[];
          checks.push({
            name: "foreign_keys",
            passed: foreign.length === 0,
            detail: `${foreign.length} foreign-key violations`,
          });
          for (const table of ["messages_fts", "transcript_segments_fts"]) {
            try {
              snapshot
                .prepare(
                  `INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`,
                )
                .run();
              checks.push({
                name: table,
                passed: true,
                detail: "Search index matches source text",
              });
            } catch {
              checks.push({
                name: table,
                passed: false,
                detail: "Search index is missing, corrupt, or inconsistent",
              });
            }
          }
          result = [{ passed: checks.every((check) => check.passed), checks }];
        } finally {
          snapshot.close();
        }
      }
      if (request.backupPath) {
        if (existsSync(request.backupPath))
          throw new Error("Backup destination already exists");
        closeSync(openSync(request.backupPath, "wx", 0o600));
        await db.backup(request.backupPath);
        chmodSync(request.backupPath, 0o600);
      }
      db.close();
      db = undefined;
      parentPort!.postMessage({ id: request.id, result });
    } catch (error) {
      parentPort!.postMessage({
        id: request.id,
        error:
          error instanceof Error ? error.message : "Database operation failed",
      });
    } finally {
      db?.close();
    }
  },
);
