import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";
import { getPaths, initializeHome } from "../dist/config.js";
import { createRecording, saveManifest } from "../dist/recording.js";
import {
  writeTranscriptDocument,
  TranscriptionWorker,
} from "../dist/transcription.js";
import { databaseCall, databasePathFor } from "../dist/storage.js";
import { MessageLogger } from "../dist/messages.js";
const exec = promisify(execFile),
  cli = path.resolve("dist/index.js");
const channelID = "222222222222222222",
  userID = "333333333333333333";
const run = async (home, args, input) => {
  const result = await exec(process.execPath, [cli, "--home", home, ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.stdout.trim().split("\n").length, 1);
  return JSON.parse(result.stdout).result;
};
const fixture = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "guildscribe-cli-history-")),
    paths = getPaths(home);
  const hook = path.join(home, "hook.mjs");
  await writeFile(
    hook,
    '#!/usr/bin/env node\nimport {writeFile} from "node:fs/promises"; await writeFile(".transcript-result.json.pending",JSON.stringify({language:null,segments:[]}));\n',
  );
  await chmod(hook, 0o700);
  await initializeHome(
    paths,
    {
      discordToken: "never-log-this",
      voiceChannelIDs: [channelID],
      transcriptionHook: hook,
    },
    false,
  );
  const active = await createRecording(
    paths,
    "111111111111111111",
    channelID,
    new Date("2026-01-01T00:00:00Z"),
  );
  Object.assign(active.manifest, {
    status: "complete",
    endedAt: "2026-01-01T00:00:02.000Z",
    durationMs: 2000,
  });
  await saveManifest(active.location, active.manifest);
  await writeFile(
    path.join(active.location.directory, "audio.mp3"),
    "hook only checks file",
  );
  const recordingID = active.manifest.recordingID;
  await writeTranscriptDocument(active.location, {
    schemaVersion: 1,
    recordingID,
    status: "complete",
    attempts: 1,
    queuedAt: "2026-01-01T00:00:02.000Z",
    startedAt: "2026-01-01T00:00:03.000Z",
    finishedAt: "2026-01-01T00:00:04.000Z",
    error: null,
    result: {
      language: "en",
      segments: [
        { startOffsetMs: 0, endOffsetMs: 1000, text: "budget & <review>" },
        { startOffsetMs: 1000, endOffsetMs: 2000, text: "next budget" },
      ],
    },
  });
  await databaseCall(
    databasePathFor(home),
    [
      {
        sql: "UPDATE transcript_segments SET speaker_user_id=?,speaker_display_name=?",
        params: [userID, "Speaker"],
      },
    ],
    true,
  );
  const logger = new MessageLogger(home, [channelID]);
  for (let i = 0; i < 3; i++)
    logger.capture({
      id: String(444444444444444440n + BigInt(i)),
      guildId: "111111111111111111",
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
      content: "budget " + i,
      reference: null,
      createdTimestamp: 1767225600000,
      editedTimestamp: null,
      attachments: new Map(),
      embeds: [],
      partial: false,
    });
  await logger.shutdown();
  return { home, paths, active, recordingID };
};

test("message CLI pagination, filters, search, get and malformed cursors", async () => {
  const f = await fixture();
  try {
    const first = await run(f.home, ["messages", "list", "--limit", "2"]);
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = await run(f.home, [
      "messages",
      "list",
      "--limit",
      "2",
      "--cursor",
      first.nextCursor,
    ]);
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.notEqual(second.items[0].messageID, first.items[1].messageID);
    const found = await run(f.home, [
      "messages",
      "search",
      "budget",
      "--author",
      userID,
      "--after",
      "2026-01-01T00:00:00Z",
      "--before",
      "2026-01-02T00:00:00Z",
    ]);
    assert.equal(found.items.length, 3);
    assert.equal(
      (await run(f.home, ["messages", "get", first.items[0].messageID]))
        .content,
      "budget 0",
    );
    await assert.rejects(
      run(f.home, [
        "messages",
        "list",
        "--channel",
        channelID,
        "--cursor",
        first.nextCursor,
      ]),
      (e) => JSON.parse(e.stdout).error.code === "invalid_history_request",
    );
    await assert.rejects(run(f.home, ["messages", "list", "--limit", "0"]));
    await assert.rejects(
      run(f.home, ["messages", "search", '"']),
      (e) => JSON.parse(e.stdout).error.code === "invalid_search_query",
    );
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("transcript CLI metadata, segment pages, speaker search and all export formats", async () => {
  const f = await fixture();
  try {
    const head = await run(f.home, ["transcript", "get", f.recordingID]);
    assert.equal(head.segmentCount, 2);
    assert.equal(head.segments, undefined);
    const first = await run(f.home, [
      "transcript",
      "get",
      f.recordingID,
      "--include-segments",
      "--limit",
      "1",
    ]);
    assert.equal(first.segments[0].segmentIndex, 0);
    const next = await run(f.home, [
      "transcript",
      "get",
      f.recordingID,
      "--include-segments",
      "--cursor",
      first.nextCursor,
    ]);
    assert.equal(next.segments[0].segmentIndex, 1);
    const found = await run(f.home, [
      "transcript",
      "search",
      "budget",
      "--speaker",
      userID,
      "--channel",
      channelID,
    ]);
    assert.equal(found.items.length, 2);
    assert.equal(found.items[0].speakerDisplayName, "Speaker");
    assert.equal(found.items[0].recordingID, f.recordingID);
    for (const format of ["txt", "json", "srt", "vtt"]) {
      const destination = path.join(f.home, "export." + format);
      const preview = await run(f.home, [
        "transcript",
        "export",
        f.recordingID,
        "--destination",
        destination,
        "--format",
        format,
        "--dry-run",
      ]);
      assert.equal(preview.changed, false);
      await assert.rejects(stat(destination));
      const result = await run(f.home, [
        "transcript",
        "export",
        f.recordingID,
        "--destination",
        destination,
        "--format",
        format,
      ]);
      assert.match(result.sha256, /^[a-f0-9]{64}$/);
      const text = await readFile(destination, "utf8");
      if (format === "json") assert.equal(JSON.parse(text).segments.length, 2);
      if (format === "srt") assert.match(text, /00:00:00,000 --> 00:00:01,000/);
      if (format === "vtt") assert.match(text, /^WEBVTT/);
      await assert.rejects(
        run(f.home, [
          "transcript",
          "export",
          f.recordingID,
          "--destination",
          destination,
        ]),
      );
    }
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("database CLI verifies FTS without repairing it and backs up committed WAL data", async () => {
  const f = await fixture();
  let writer;
  try {
    const status = await run(f.home, ["database", "status"]);
    assert.equal(status.counts.messages, 3);
    assert.equal(status.counts.transcriptSegments, 2);
    const verified = await run(f.home, ["database", "verify"]);
    assert.equal(verified.passed, true);
    writer = new Database(databasePathFor(f.home));
    writer.pragma("wal_autocheckpoint=0");
    writer.prepare("UPDATE messages SET content='committed WAL'").run();
    const destination = path.join(f.home, "backup.sqlite");
    await run(f.home, [
      "database",
      "backup",
      "--destination",
      destination,
      "--dry-run",
    ]);
    await assert.rejects(stat(destination));
    await run(f.home, ["database", "backup", "--destination", destination]);
    const copy = new Database(destination, { readonly: true });
    assert.equal(
      copy.prepare("SELECT content FROM messages LIMIT 1").get().content,
      "committed WAL",
    );
    copy.close();
    await assert.rejects(
      run(f.home, ["database", "backup", "--destination", destination]),
    );
    writer.exec(
      "DROP TRIGGER messages_fts_update; UPDATE messages SET content='deliberately inconsistent';",
    );
    await assert.rejects(run(f.home, ["database", "verify"]), (error) => {
      const result = JSON.parse(error.stdout).result;
      return (
        result.passed === false &&
        result.checks.find((c) => c.name === "messages_fts").passed === false
      );
    });
    assert.equal(
      writer
        .prepare(
          "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'committed'",
        )
        .get().n,
      3,
    );
  } finally {
    writer?.close();
    await rm(f.home, { recursive: true, force: true });
  }
});

test("retry is a dry-runnable idempotent queue request consumed by the transcription worker", async () => {
  const f = await fixture();
  try {
    const db = databasePathFor(f.home),
      request = path.join(f.home, "retry.json");
    await writeFile(request, JSON.stringify({ recordingID: f.recordingID }));
    await assert.rejects(
      run(f.home, ["transcript", "retry", "--request", request]),
    );
    await databaseCall(
      db,
      [
        { sql: "DELETE FROM transcript_segments" },
        {
          sql: "UPDATE transcripts SET status='failed',language=NULL,error='test failure'",
        },
      ],
      true,
    );
    assert.equal(
      (
        await run(f.home, [
          "transcript",
          "retry",
          "--request",
          request,
          "--dry-run",
        ])
      ).changed,
      false,
    );
    assert.equal(
      (await run(f.home, ["transcript", "get", f.recordingID])).status,
      "failed",
    );
    assert.equal(
      (await run(f.home, ["transcript", "retry", "--request", request]))
        .changed,
      true,
    );
    assert.equal(
      (await run(f.home, ["transcript", "retry", "--request", request]))
        .changed,
      false,
    );
    const { loadConfig } = await import("../dist/config.js");
    const worker = new TranscriptionWorker(f.paths, await loadConfig(f.paths));
    await worker.pollPending();
    await worker.waitForIdle();
    const head = await run(f.home, ["transcript", "get", f.recordingID]);
    assert.equal(head.status, "complete");
    assert.equal(head.attempts, 2);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});
