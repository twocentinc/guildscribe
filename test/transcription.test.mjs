import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getPaths } from "../dist/config.js";
import {
  createRecording,
  publishRecording,
  saveInterval,
  saveManifest,
} from "../dist/recording.js";
import {
  readTranscriptionState,
  readTranscript,
  transcriptDocumentSchema,
  transcriptResultSchema,
  TranscriptionWorker,
} from "../dist/transcription.js";
import { showRecording } from "../dist/recording.js";

const prepareRecording = async (hookSource) => {
  const home = await mkdtemp(path.join(tmpdir(), "guildscribe-transcription-"));
  const paths = getPaths(home);
  await Promise.all(
    [paths.inProgress, paths.recordings, paths.logs].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  const hook = path.join(home, "transcription-hook.mjs");
  await writeFile(hook, `#!/usr/bin/env node\n${hookSource}\n`);
  await chmod(hook, 0o700);

  const active = await createRecording(
    paths,
    "111111111111111111",
    "222222222222222222",
    new Date("2026-11-05T12:00:00.000Z"),
  );
  const intervalID = "55555555-5555-4555-8555-555555555555";
  const pcmFile = `${intervalID}.pcm`;
  await writeFile(
    path.join(active.location.intervalsDirectory, pcmFile),
    Buffer.alloc(128, 1),
  );
  await saveInterval(active.location, {
    schemaVersion: 1,
    intervalID,
    recordingID: active.manifest.recordingID,
    kind: "speaking",
    userID: "333333333333333333",
    startOffsetMs: 0,
    endOffsetMs: 100,
    incomplete: false,
  });
  await writeFile(
    path.join(active.location.directory, "audio.mp3"),
    Buffer.alloc(64, 2),
  );
  active.manifest.status = "complete";
  active.manifest.endedAt = "2026-11-05T12:00:01.000Z";
  active.manifest.durationMs = 1_000;
  await saveManifest(active.location, active.manifest);
  const location = await publishRecording(
    paths,
    active.location,
    active.manifest,
  );
  const config = {
    discordToken: "must-not-be-exposed",
    voiceChannelIDs: [active.manifest.channelID],
    emptyGraceMs: 30_000,
    hookTimeoutMs: 30_000,
    transcriptionHook: hook,
    hooks: {},
  };
  return { active, config, home, hook, intervalID, location, paths, pcmFile };
};

const successHook = `
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
const recordingDirectory = process.argv[2];
const recording = JSON.parse(await readFile(path.join(recordingDirectory, "recording.json"), "utf8"));
await writeFile("hook-request.json", JSON.stringify({
  recordingDirectory,
  workingDirectory: process.cwd()
}));
const temporary = path.join(recordingDirectory, ".transcript-result.json.pending.tmp");
await writeFile(temporary, JSON.stringify({
  language: "en",
  segments: [
    {
      startOffsetMs: 0,
      endOffsetMs: 500,
      text: "hello",
      sourceIntervalID: "55555555-5555-4555-8555-555555555555"
    },
    {
      startOffsetMs: 500,
      endOffsetMs: 1000,
      text: "world"
    }
  ]
}));
await rename(temporary, path.join(recordingDirectory, ".transcript-result.json.pending"));
`;

test("transcript schemas reject empty segments and incomplete state", () => {
  assert.equal(
    transcriptResultSchema.safeParse({
      language: "en",
      segments: [
        {
          startOffsetMs: 0,
          endOffsetMs: 100,
          text: " ",
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    transcriptDocumentSchema.safeParse({
      schemaVersion: 1,
      recordingID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "complete",
      attempts: 1,
      queuedAt: "2026-11-05T12:00:00.000Z",
      startedAt: "2026-11-05T12:00:01.000Z",
      finishedAt: null,
      error: null,
      result: { language: "en", segments: [] },
    }).success,
    false,
  );
});

test("transcription hook publishes validated transcripts and retains PCM", async () => {
  const fixture = await prepareRecording(successHook);
  try {
    const worker = new TranscriptionWorker(fixture.paths, fixture.config);
    assert.equal(
      await worker.enqueue(fixture.location, fixture.active.manifest),
      true,
    );
    await worker.waitForIdle();

    const state = await readTranscriptionState(fixture.location);
    assert.equal(state.status, "complete");
    assert.equal(state.attempts, 1);
    const transcript = JSON.parse(
      await readFile(
        path.join(fixture.location.directory, "transcript.json"),
        "utf8",
      ),
    );
    assert.equal(transcript.schemaVersion, 1);
    assert.equal(transcript.recordingID, fixture.active.manifest.recordingID);
    assert.equal(transcript.status, "complete");
    assert.equal(
      transcript.result.segments[0].sourceIntervalID,
      fixture.intervalID,
    );
    assert.equal(transcript.result.segments[1].sourceIntervalID, undefined);
    assert.equal(
      await readFile(
        path.join(fixture.location.directory, "transcript.txt"),
        "utf8",
      ),
      "hello\nworld\n",
    );
    assert.equal(
      (
        await stat(
          path.join(fixture.location.intervalsDirectory, fixture.pcmFile),
        )
      ).size,
      128,
    );
    const inventory = await showRecording(
      fixture.paths,
      fixture.active.manifest.recordingID,
    );
    assert.equal(inventory.transcriptionStatus, "complete");
    assert.ok(inventory.transcriptJSONBytes > 0);
    assert.equal(inventory.transcriptTextBytes, 12);

    const captured = JSON.parse(
      await readFile(
        path.join(fixture.location.directory, "hook-request.json"),
        "utf8",
      ),
    );
    assert.equal(captured.recordingDirectory, fixture.location.directory);
    assert.equal(
      await realpath(captured.workingDirectory),
      await realpath(fixture.location.directory),
    );
    assert.doesNotMatch(JSON.stringify(captured), /must-not-be-exposed/);
    await assert.rejects(
      stat(
        path.join(
          fixture.location.directory,
          ".transcript-result.json.pending",
        ),
      ),
      { code: "ENOENT" },
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("failed transcription remains inspectable without deleting audio", async () => {
  const fixture = await prepareRecording(
    `process.stderr.write("model unavailable\\n"); process.exitCode = 3;`,
  );
  try {
    const worker = new TranscriptionWorker(fixture.paths, fixture.config);
    await worker.enqueue(fixture.location, fixture.active.manifest);
    await worker.waitForIdle();

    const state = await readTranscriptionState(fixture.location);
    assert.equal(state.status, "failed");
    assert.match(state.error, /model unavailable/);
    assert.equal(
      (await stat(path.join(fixture.location.directory, "audio.mp3"))).size,
      64,
    );
    assert.equal(
      (
        await stat(
          path.join(fixture.location.intervalsDirectory, fixture.pcmFile),
        )
      ).size,
      128,
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("invalid pending transcript is rejected", async () => {
  const fixture = await prepareRecording(`
import { writeFile } from "node:fs/promises";
import path from "node:path";
const recordingDirectory = process.argv[2];
await writeFile(path.join(recordingDirectory, ".transcript-result.json.pending"), JSON.stringify({ text: "missing fields" }));
`);
  try {
    const worker = new TranscriptionWorker(fixture.paths, fixture.config);
    await worker.enqueue(fixture.location, fixture.active.manifest);
    await worker.waitForIdle();

    const state = await readTranscriptionState(fixture.location);
    assert.equal(state.status, "failed");
    assert.ok(
      (await stat(path.join(fixture.location.directory, "transcript.json")))
        .size > 0,
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("transcript source intervals must exist in the recording", async () => {
  const fixture = await prepareRecording(`
import { writeFile } from "node:fs/promises";
import path from "node:path";
const recordingDirectory = process.argv[2];
await writeFile(path.join(recordingDirectory, ".transcript-result.json.pending"), JSON.stringify({
  language: "en",
  segments: [{
    startOffsetMs: 0,
    endOffsetMs: 100,
    text: "hello",
    sourceIntervalID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  }]
}));
`);
  try {
    const worker = new TranscriptionWorker(fixture.paths, fixture.config);
    await worker.enqueue(fixture.location, fixture.active.manifest);
    await worker.waitForIdle();

    const state = await readTranscriptionState(fixture.location);
    assert.equal(state.status, "failed");
    assert.match(state.error, /unknown interval/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("transcription is a no-op when no hook is configured", async () => {
  const fixture = await prepareRecording(successHook);
  try {
    const worker = new TranscriptionWorker(fixture.paths, {
      ...fixture.config,
      transcriptionHook: undefined,
    });
    assert.equal(
      await worker.enqueue(fixture.location, fixture.active.manifest),
      false,
    );
    await worker.waitForIdle();
    assert.equal(await readTranscriptionState(fixture.location), null);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("legacy transcription state and transcript remain readable", async () => {
  const fixture = await prepareRecording(successHook);
  try {
    await writeFile(
      path.join(fixture.location.directory, "transcription.json"),
      JSON.stringify({
        version: 1,
        recordingID: fixture.active.manifest.recordingID,
        status: "complete",
        attempts: 1,
        createdAt: "2026-11-05T12:00:01.000Z",
        updatedAt: "2026-11-05T12:00:03.000Z",
        startedAt: "2026-11-05T12:00:02.000Z",
        completedAt: "2026-11-05T12:00:03.000Z",
        error: null,
      }),
    );
    await writeFile(
      path.join(fixture.location.directory, "transcript.json"),
      JSON.stringify({
        version: 1,
        recordingID: fixture.active.manifest.recordingID,
        createdAt: "2026-11-05T12:00:03.000Z",
        language: "en",
        text: "hello",
        segments: [
          {
            startOffsetMs: 0,
            endOffsetMs: 100,
            text: "hello",
            sourceIntervalIDs: [fixture.intervalID],
          },
        ],
      }),
    );
    const document = await readTranscript(fixture.location);
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.status, "complete");
    assert.equal(
      document.result.segments[0].sourceIntervalID,
      fixture.intervalID,
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("daemon recovery requeues a transcription interrupted while running", async () => {
  const fixture = await prepareRecording(successHook);
  try {
    const timestamp = new Date().toISOString();
    await writeFile(
      path.join(fixture.location.directory, "transcript.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        recordingID: fixture.active.manifest.recordingID,
        status: "running",
        attempts: 1,
        queuedAt: timestamp,
        startedAt: timestamp,
        finishedAt: null,
        error: null,
        result: null,
      })}\n`,
    );
    const worker = new TranscriptionWorker(fixture.paths, fixture.config);
    await worker.recover();
    await worker.waitForIdle();

    const state = await readTranscriptionState(fixture.location);
    assert.equal(state.status, "complete");
    assert.equal(state.attempts, 2);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});
