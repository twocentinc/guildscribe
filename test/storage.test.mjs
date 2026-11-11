import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  stat,
  rename,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getPaths } from "../dist/config.js";
import {
  createRecording,
  saveManifest,
  saveInterval,
  initializeParticipants,
  readManifest,
  locationForDirectory,
} from "../dist/recording.js";
import {
  writeTranscriptDocument,
  readTranscript,
  migrateLegacyStorage,
} from "../dist/transcription.js";
import { databaseCall, databasePathFor } from "../dist/storage.js";
import { MessageLogger, discordIntents } from "../dist/messages.js";
import { GatewayIntentBits } from "discord.js";

const guildID = "111111111111111111",
  channelID = "222222222222222222",
  userID = "333333333333333333";
const intervalID = "11111111-1111-4111-8111-111111111111";
const temp = () => mkdtemp(path.join(tmpdir(), "guildscribe-storage-"));
const message = (overrides = {}) => ({
  id: "444444444444444444",
  guildId: guildID,
  channelId: channelID,
  channel: { isThread: () => false, name: "meeting" },
  author: {
    id: userID,
    username: "speaker",
    bot: false,
    globalName: "Speaker",
  },
  member: null,
  webhookId: null,
  type: 0,
  content: "project budget",
  reference: null,
  createdTimestamp: 1000,
  editedTimestamp: null,
  attachments: new Map(),
  embeds: [],
  partial: false,
  ...overrides,
});

test("messages capture scope, edits, FTS, stale revisions, partial fetches and shutdown", async () => {
  const home = await temp();
  try {
    assert.ok(!discordIntents([]).includes(GatewayIntentBits.MessageContent));
    assert.ok(
      discordIntents([channelID]).includes(GatewayIntentBits.MessageContent),
    );
    const logger = new MessageLogger(home, [channelID]);
    logger.capture(message());
    await logger.waitForIdle();
    const db = databasePathFor(home);
    const [[initial]] = await databaseCall(db, [
      { sql: "SELECT * FROM messages", mode: "all" },
    ]);
    logger.capture(message({ content: "new schedule", editedTimestamp: 2000 }));
    logger.capture(message({ content: "stale budget", editedTimestamp: 1500 }));
    logger.capture(
      message({ id: "555555555555555555", channelId: "666666666666666666" }),
    );
    logger.capture(message({ id: "777777777777777777", guildId: null }));
    const thread = message({
      id: "888888888888888888",
      channelId: "999999999999999999",
      channel: { isThread: () => true, parentId: channelID, name: "thread" },
      author: { id: userID, username: "bot", bot: true, globalName: null },
    });
    logger.capture({ ...thread, partial: true, fetch: async () => thread });
    await logger.shutdown();
    logger.capture(message({ id: "101010101010101010" }));
    const [rows, oldHits, newHits] = await databaseCall(db, [
      { sql: "SELECT * FROM messages ORDER BY message_id", mode: "all" },
      {
        sql: "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'budget'",
        mode: "all",
      },
      {
        sql: "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'schedule'",
        mode: "all",
      },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].content, "new schedule");
    assert.equal(rows[0].message_row_id, initial.message_row_id);
    assert.equal(rows[1].parent_channel_id, channelID);
    assert.equal(rows[1].author_is_bot, 1);
    assert.equal(oldHits.length, 1);
    assert.equal(newHits.length, 1);
    assert.equal((await stat(db)).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("transcript segments snapshot speakers, search and atomically replace text", async () => {
  const home = await temp();
  try {
    const paths = getPaths(home);
    const active = await createRecording(paths, guildID, channelID);
    await initializeParticipants(
      active.location,
      active.manifest.recordingID,
      [{ userID, username: "speaker", displayName: "Speaker" }],
      active.manifest.startedAt,
    );
    await saveInterval(active.location, {
      schemaVersion: 1,
      recordingID: active.manifest.recordingID,
      intervalID,
      kind: "speaking",
      userID,
      startOffsetMs: 0,
      endOffsetMs: 1000,
      incomplete: false,
    });
    Object.assign(active.manifest, {
      status: "complete",
      endedAt: new Date(
        Date.parse(active.manifest.startedAt) + 1000,
      ).toISOString(),
      durationMs: 1000,
    });
    await saveManifest(active.location, active.manifest);
    const time = new Date().toISOString();
    const document = {
      schemaVersion: 1,
      recordingID: active.manifest.recordingID,
      status: "complete",
      attempts: 1,
      queuedAt: time,
      startedAt: time,
      finishedAt: time,
      error: null,
      result: {
        language: "en",
        segments: [
          {
            startOffsetMs: 0,
            endOffsetMs: 1000,
            text: "budget discussion",
            sourceIntervalID: intervalID,
          },
          { startOffsetMs: 0, endOffsetMs: 1000, text: "unknown speaker" },
        ],
      },
    };
    await writeTranscriptDocument(active.location, document);
    const db = databasePathFor(home);
    const [rows, hits] = await databaseCall(db, [
      {
        sql: "SELECT * FROM transcript_segments ORDER BY segment_index",
        mode: "all",
      },
      {
        sql: "SELECT s.speaker_display_name FROM transcript_segments_fts f JOIN transcript_segments s ON s.segment_id=f.rowid WHERE transcript_segments_fts MATCH 'budget'",
        mode: "all",
      },
    ]);
    assert.equal(rows[0].speaker_user_id, userID);
    assert.equal(rows[1].speaker_user_id, null);
    assert.equal(hits[0].speaker_display_name, "Speaker");
    document.result.segments = [];
    await writeTranscriptDocument(active.location, document);
    assert.deepEqual(
      (await readTranscript(active.location)).result.segments,
      [],
    );
    const [remaining] = await databaseCall(db, [
      {
        sql: "SELECT rowid FROM transcript_segments_fts WHERE transcript_segments_fts MATCH 'budget'",
        mode: "all",
      },
    ]);
    assert.equal(remaining.length, 0);
    await assert.rejects(stat(active.location.manifestPath), {
      code: "ENOENT",
    });
    await assert.rejects(
      stat(path.join(active.location.directory, "transcript.json")),
      { code: "ENOENT" },
    );
    // A failed multi-statement write rolls back metadata and its FTS triggers.
    await assert.rejects(
      databaseCall(
        db,
        [
          { sql: "UPDATE recordings SET guild_name='should rollback'" },
          {
            sql: "INSERT INTO transcripts(recording_id) VALUES (?)",
            params: ["missing"],
          },
        ],
        true,
      ),
    );
    assert.equal((await readManifest(active.location)).guildName, null);
    const backup = path.join(home, "backup.sqlite");
    await databaseCall(db, [], false, backup);
    const [[row]] = await databaseCall(backup, [
      { sql: "SELECT count(*) AS count FROM recordings", mode: "all" },
    ]);
    assert.equal(row.count, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy import is verified, restartable, and reconciles a completed directory move", async () => {
  const home = await temp();
  try {
    const paths = getPaths(home);
    const active = await createRecording(paths, guildID, channelID);
    await writeFile(
      active.location.manifestPath,
      JSON.stringify(active.manifest),
    );
    const db = databasePathFor(home);
    await databaseCall(db, [{ sql: "DELETE FROM recordings" }], true);
    await migrateLegacyStorage(paths);
    assert.equal(
      (await readManifest(active.location)).recordingID,
      active.manifest.recordingID,
    );
    await assert.rejects(stat(active.location.manifestPath), {
      code: "ENOENT",
    });
    const names = await readdir(home);
    const backupName = names.find((n) =>
      n.startsWith("legacy-storage-backup-"),
    );
    const bundle = JSON.parse(
      await readFile(path.join(home, backupName), "utf8"),
    );
    assert.equal(bundle.committed, true);
    // Simulate a crash after commit but before all legacy originals were removed.
    for (const file of bundle.files)
      await writeFile(path.join(home, file.path), file.contents);
    await migrateLegacyStorage(paths);
    await assert.rejects(stat(active.location.manifestPath), {
      code: "ENOENT",
    });
    active.manifest.status = "complete";
    active.manifest.durationMs = 1000;
    active.manifest.endedAt = new Date(
      Date.parse(active.manifest.startedAt) + 1000,
    ).toISOString();
    await saveManifest(active.location, active.manifest);
    const destination = path.join(
      paths.recordings,
      "2026",
      "11",
      active.manifest.recordingID,
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(active.location.directory, destination);
    await migrateLegacyStorage(paths);
    const [[row]] = await databaseCall(db, [
      { sql: "SELECT directory_path FROM recordings", mode: "all" },
    ]);
    assert.equal(row.directory_path, path.relative(home, destination));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("migration fails before changing originals when legacy metadata conflicts", async () => {
  const home = await temp();
  try {
    const paths = getPaths(home);
    const active = await createRecording(paths, guildID, channelID);
    const changed = { ...active.manifest, channelName: "conflicting source" };
    const source = JSON.stringify(changed);
    await writeFile(active.location.manifestPath, source);
    await assert.rejects(migrateLegacyStorage(paths), /conflicts/);
    assert.equal(await readFile(active.location.manifestPath, "utf8"), source);
    assert.equal((await readManifest(active.location)).channelName, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("message configuration round-trips and invalid channel lists are rejected", async () => {
  const { initializeHome, loadConfig, updateConfiguration } =
    await import("../dist/config.js");
  const home = await temp();
  try {
    const paths = getPaths(home);
    await initializeHome(
      paths,
      { discordToken: "test", voiceChannelIDs: [channelID] },
      false,
    );
    assert.deepEqual((await loadConfig(paths)).messageChannelIDs, []);
    await updateConfiguration(paths, { messageChannelIDs: [channelID] }, false);
    assert.deepEqual((await loadConfig(paths)).messageChannelIDs, [channelID]);
    await updateConfiguration(paths, { emptyGraceMs: 4000 }, false);
    assert.deepEqual((await loadConfig(paths)).messageChannelIDs, [channelID]);
    await updateConfiguration(paths, { messageChannelIDs: [] }, false);
    assert.deepEqual((await loadConfig(paths)).messageChannelIDs, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});


test("database worker ignores parent process-only Node flags", async () => {
  const home = await temp();
  try {
    const moduleURL = new URL("../dist/storage.js", import.meta.url).href;
    const script = `
      const { databaseCall } = await import(${JSON.stringify(moduleURL)});
      const result = await databaseCall(process.argv[1], [{ sql: "SELECT 1 AS ok", mode: "all" }], true);
      console.log(JSON.stringify(result));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--stack-trace-limit=10", "--input-type=module", "-e", script, databasePathFor(home),
    ]);
    assert.deepEqual(JSON.parse(stdout), [[{ ok: 1 }]]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
