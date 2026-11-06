import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
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
} from "../dist/manifests.js";
import {
  readTranscriptionState,
  TranscriptionWorker,
} from "../dist/transcription.js";
import { showRecording } from "../dist/recordings.js";

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
  const pcmFile = "speaker.pcm";
  await writeFile(
    path.join(active.location.intervalsDirectory, pcmFile),
    Buffer.alloc(128, 1),
  );
  await saveInterval(active.location, {
    version: 1,
    intervalID: "speaker-interval",
    recordingID: active.manifest.recordingID,
    kind: "speaking",
    userID: "333333333333333333",
    username: "speaker",
    displayName: "Speaker",
    startOffsetMs: 0,
    endOffsetMs: 100,
    incomplete: false,
    reason: null,
    pcmFile,
    updatedAt: active.manifest.startedAt,
  });
  await writeFile(
    path.join(active.location.directory, "audio.mp3"),
    Buffer.alloc(64, 2),
  );
  active.manifest.status = "complete";
  active.manifest.endedAt = "2026-11-05T12:00:01.000Z";
  active.manifest.durationMs = 1_000;
  active.manifest.audioFile = "audio.mp3";
  active.manifest.intervalCount = 1;
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
  return { active, config, home, hook, location, paths, pcmFile };
};

const successHook = `
import { writeFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
await writeFile("hook-request.json", JSON.stringify({ argument: process.argv[2], request }));
await writeFile(request.output.transcriptJSONPath, JSON.stringify({
  version: 1,
  language: "en",
  text: "hello world",
  segments: [
    { startOffsetMs: 0, endOffsetMs: 500, text: "hello" },
    {
      startOffsetMs: 500,
      endOffsetMs: 1000,
      text: "world",
      speaker: { userID: "333333333333333333", username: "speaker", displayName: "Speaker" }
    }
  ]
}));
`;

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
      await readFile(path.join(fixture.location.directory, "transcript.json"), "utf8"),
    );
    assert.equal(transcript.version, 1);
    assert.equal(transcript.recordingID, fixture.active.manifest.recordingID);
    assert.equal(transcript.segments[0].speaker, undefined);
    assert.equal(transcript.segments[1].speaker.displayName, "Speaker");
    assert.equal(
      await readFile(path.join(fixture.location.directory, "transcript.txt"), "utf8"),
      "hello world\n",
    );
    assert.equal(
      (await stat(path.join(fixture.location.intervalsDirectory, fixture.pcmFile)))
        .size,
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
      await readFile(path.join(fixture.location.directory, "hook-request.json"), "utf8"),
    );
    assert.equal(captured.argument, "transcribe");
    assert.equal(captured.request.version, 1);
    assert.equal(captured.request.recording.intervals.length, 1);
    assert.equal(captured.request.recording.intervals[0].pcm.sampleRateHz, 48_000);
    assert.doesNotMatch(JSON.stringify(captured), /must-not-be-exposed/);
    await assert.rejects(
      stat(path.join(fixture.location.directory, ".transcription-staging")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("failed transcription remains inspectable without deleting audio", async () => {
  const fixture = await prepareRecording(`process.stderr.write("model unavailable\\n"); process.exitCode = 3;`);
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
      (await stat(path.join(fixture.location.intervalsDirectory, fixture.pcmFile)))
        .size,
      128,
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("invalid staged transcript is rejected", async () => {
  const fixture = await prepareRecording(`
import { writeFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
await writeFile(request.output.transcriptJSONPath, JSON.stringify({ version: 1, text: "missing fields" }));
`);
  try {
    const worker = new TranscriptionWorker(fixture.paths, fixture.config);
    await worker.enqueue(fixture.location, fixture.active.manifest);
    await worker.waitForIdle();

    const state = await readTranscriptionState(fixture.location);
    assert.equal(state.status, "failed");
    await assert.rejects(
      stat(path.join(fixture.location.directory, "transcript.json")),
      { code: "ENOENT" },
    );
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

test("daemon recovery requeues a transcription interrupted while running", async () => {
  const fixture = await prepareRecording(successHook);
  try {
    const timestamp = new Date().toISOString();
    await writeFile(
      path.join(fixture.location.directory, "transcription.json"),
      `${JSON.stringify({
        version: 1,
        recordingID: fixture.active.manifest.recordingID,
        status: "running",
        attempts: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        completedAt: null,
        error: null,
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
