import assert from "node:assert/strict";
import {
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
} from "../dist/recording.js";
import {
  exportRecording,
  verifyRecording,
} from "../dist/recordingArtifacts.js";
import {
  finalizeParticipants,
  initializeParticipants,
} from "../dist/recording.js";
import { renderMaster } from "../dist/renderer.js";

const createVerifiedRecording = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "guildscribe-artifacts-"));
  const paths = getPaths(home);
  const active = await createRecording(
    paths,
    "111111111111111111",
    "222222222222222222",
    new Date("2026-11-05T12:00:00.000Z"),
    { guildName: "Guild", channelName: "Meeting" },
  );
  const speaker = {
    userID: "333333333333333333",
    username: "speaker",
    displayName: "Speaker",
  };
  await initializeParticipants(
    active.location,
    active.manifest.recordingID,
    [speaker],
    active.manifest.startedAt,
  );
  const interval = {
    version: 1,
    intervalID: "33333333-3333-4333-8333-333333333333",
    recordingID: active.manifest.recordingID,
    kind: "speaking",
    ...speaker,
    startOffsetMs: 0,
    endOffsetMs: 200,
    incomplete: false,
    reason: null,
    pcmFile: "33333333-3333-4333-8333-333333333333.pcm",
    updatedAt: active.manifest.startedAt,
  };
  await writeFile(
    path.join(active.location.intervalsDirectory, interval.pcmFile),
    Buffer.alloc((48_000 * 2 * 2) / 5),
  );
  await saveInterval(active.location, interval);
  active.manifest.status = "finalizing";
  active.manifest.endedAt = "2026-11-05T12:00:00.200Z";
  active.manifest.durationMs = 200;
  active.manifest.intervalCount = 1;
  await finalizeParticipants(
    active.location,
    active.manifest.recordingID,
    [interval],
    active.manifest.endedAt,
  );
  const rendered = await renderMaster(active.location, 200, [interval]);
  active.manifest.status = "complete";
  active.manifest.audioFile = rendered.audioFile;
  await saveManifest(active.location, active.manifest);
  const location = await publishRecording(
    paths,
    active.location,
    active.manifest,
  );
  return { active, home, interval, location, paths };
};

test("recording verification checks media, PCM, metadata, and checksums", async () => {
  const fixture = await createVerifiedRecording();
  try {
    const result = await verifyRecording(
      fixture.paths,
      fixture.active.manifest.recordingID,
    );
    assert.equal(result.passed, true);
    assert.ok(result.checks.every(({ status }) => status !== "fail"));
    assert.ok(
      result.files.some(
        ({ relativePath, sha256 }) =>
          relativePath === "audio.mp3" && /^[a-f0-9]{64}$/.test(sha256),
      ),
    );
    assert.ok(
      result.files.some(
        ({ relativePath }) => relativePath === "participants.json",
      ),
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("recording verification applies the canonical transcript schema and text projection", async () => {
  const fixture = await createVerifiedRecording();
  try {
    await writeFile(
      path.join(fixture.location.directory, "transcription.json"),
      `${JSON.stringify({
        version: 1,
        recordingID: fixture.active.manifest.recordingID,
        status: "complete",
        attempts: 1,
        createdAt: "2026-11-05T12:00:00.200Z",
        updatedAt: "2026-11-05T12:00:00.400Z",
        startedAt: "2026-11-05T12:00:00.300Z",
        completedAt: "2026-11-05T12:00:00.400Z",
        error: null,
      })}\n`,
    );
    await writeFile(
      path.join(fixture.location.directory, "transcript.json"),
      `${JSON.stringify({
        version: 1,
        recordingID: fixture.active.manifest.recordingID,
        createdAt: "2026-11-05T12:00:00.400Z",
        language: "en",
        text: "hello",
        segments: [
          {
            startOffsetMs: 0,
            endOffsetMs: 200,
            text: "hello",
            sourceIntervalIDs: [fixture.interval.intervalID],
            speaker: {
              userID: fixture.interval.userID,
              username: fixture.interval.username,
              displayName: fixture.interval.displayName,
            },
          },
        ],
      })}\n`,
    );
    await writeFile(
      path.join(fixture.location.directory, "transcript.txt"),
      "hello\n",
    );

    const valid = await verifyRecording(
      fixture.paths,
      fixture.active.manifest.recordingID,
    );
    assert.equal(
      valid.checks.find(({ name }) => name === "transcription")?.status,
      "pass",
    );

    await writeFile(
      path.join(fixture.location.directory, "transcript.txt"),
      "different\n",
    );
    const inconsistent = await verifyRecording(
      fixture.paths,
      fixture.active.manifest.recordingID,
    );
    assert.equal(
      inconsistent.checks.find(({ name }) => name === "transcription")
        ?.status,
      "fail",
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("recording export creates a portable checksummed directory and optional WAV", async () => {
  const fixture = await createVerifiedRecording();
  const destination = path.join(fixture.home, "exported-recording");
  try {
    const dryRun = await exportRecording(
      fixture.paths,
      fixture.active.manifest.recordingID,
      destination,
      { dryRun: true, wav: true, timeoutMs: 60_000 },
    );
    assert.equal(dryRun.changed, false);
    await assert.rejects(stat(destination), { code: "ENOENT" });

    const result = await exportRecording(
      fixture.paths,
      fixture.active.manifest.recordingID,
      destination,
      { dryRun: false, wav: true, timeoutMs: 60_000 },
    );
    assert.equal(result.changed, true);
    assert.equal(result.wavFile, "audio.wav");
    assert.ok((await stat(path.join(destination, "audio.mp3"))).size > 0);
    assert.ok((await stat(path.join(destination, "audio.wav"))).size > 0);
    assert.ok(
      (await stat(path.join(destination, "intervals", "33333333-3333-4333-8333-333333333333.pcm")))
        .size > 0,
    );
    const checksums = await readFile(
      path.join(destination, "checksums.sha256"),
      "utf8",
    );
    assert.match(checksums, /audio\.mp3/);
    assert.match(checksums, /audio\.wav/);
    assert.match(checksums, /participants\.json/);
    await assert.rejects(
      stat(path.join(fixture.location.directory, "audio.wav")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});
