import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { getPaths } from "../dist/config.js";
import {
  createRecording,
  publishRecording,
  saveInterval,
  saveManifest,
} from "../dist/manifests.js";
import { listRecordings, showRecording } from "../dist/recordings.js";

const execFileAsync = promisify(execFile);

const addPCMInterval = async (active, intervalID, bytes) => {
  const pcmFile = `${intervalID}.pcm`;
  await writeFile(
    path.join(active.location.intervalsDirectory, pcmFile),
    Buffer.alloc(bytes, 1),
  );
  await saveInterval(active.location, {
    version: 1,
    intervalID,
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
};

const createInventory = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "guildscribe-inventory-"));
  const paths = getPaths(home);
  await Promise.all(
    [paths.inProgress, paths.recordings, paths.logs].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );

  const published = await createRecording(
    paths,
    "111111111111111111",
    "222222222222222222",
    new Date("2026-11-05T12:00:00.000Z"),
  );
  await addPCMInterval(published, "published-interval", 100);
  await writeFile(path.join(published.location.directory, "audio.mp3"), Buffer.alloc(50));
  published.manifest.status = "complete";
  published.manifest.endedAt = "2026-11-05T12:01:00.000Z";
  published.manifest.durationMs = 60_000;
  published.manifest.audioFile = "audio.mp3";
  published.manifest.intervalCount = 1;
  await saveManifest(published.location, published.manifest);
  const publishedLocation = await publishRecording(
    paths,
    published.location,
    published.manifest,
  );

  const inProgress = await createRecording(
    paths,
    "111111111111111111",
    "444444444444444444",
    new Date("2026-11-06T12:00:00.000Z"),
  );
  await addPCMInterval(inProgress, "active-interval", 25);

  return { home, inProgress, paths, published, publishedLocation };
};

test("recording inventory reports audio, PCM, and aggregate byte usage", async () => {
  const inventory = await createInventory();
  try {
    const result = await listRecordings(inventory.paths);
    assert.equal(result.recordings.length, 2);
    assert.equal(
      result.recordings[0].recordingID,
      inventory.inProgress.manifest.recordingID,
    );
    assert.equal(result.recordings[0].storage, "inProgress");
    assert.equal(result.recordings[0].pcmFileCount, 1);
    assert.equal(result.recordings[0].pcmFileBytes, 25);
    assert.equal(result.recordings[0].audioFileBytes, 0);

    const completed = result.recordings[1];
    assert.equal(completed.recordingID, inventory.published.manifest.recordingID);
    assert.equal(completed.storage, "published");
    assert.equal(completed.pcmFileCount, 1);
    assert.equal(completed.pcmFileBytes, 100);
    assert.equal(completed.audioFileBytes, 50);
    assert.equal(completed.transcriptionStatus, null);
    assert.equal(completed.transcriptJSONBytes, 0);
    assert.equal(completed.transcriptTextBytes, 0);
    assert.ok(completed.totalBytes > 150);

    assert.equal(result.totals.recordingCount, 2);
    assert.equal(result.totals.audioFileBytes, 50);
    assert.equal(result.totals.pcmFileCount, 2);
    assert.equal(result.totals.pcmFileBytes, 125);
    assert.equal(
      result.totals.totalBytes,
      result.recordings.reduce(
        (total, recording) => total + recording.totalBytes,
        0,
      ),
    );

    const shown = await showRecording(
      inventory.paths,
      inventory.published.manifest.recordingID,
    );
    assert.deepEqual(shown, completed);
    await assert.rejects(
      showRecording(inventory.paths, "missing"),
      (error) => error?.code === "recording_not_found",
    );
  } finally {
    await rm(inventory.home, { recursive: true, force: true });
  }
});

test("recordings list emits the stable JSON CLI envelope", async () => {
  const inventory = await createInventory();
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        path.resolve("dist/index.js"),
        "--home",
        inventory.home,
        "--request-id",
        "inventory-test",
        "recordings",
        "list",
      ],
      { cwd: path.resolve(".") },
    );
    assert.equal(stderr, "");
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, "recordings list");
    assert.equal(envelope.requestID, "inventory-test");
    assert.equal(envelope.result.totals.recordingCount, 2);
    assert.equal(envelope.result.totals.pcmFileCount, 2);
    assert.equal(envelope.result.totals.pcmFileBytes, 125);
  } finally {
    await rm(inventory.home, { recursive: true, force: true });
  }
});

test("recordings show emits one recording in the stable JSON CLI envelope", async () => {
  const inventory = await createInventory();
  try {
    const recordingID = inventory.published.manifest.recordingID;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        path.resolve("dist/index.js"),
        "--home",
        inventory.home,
        "--request-id",
        "show-test",
        "recordings",
        "show",
        recordingID,
      ],
      { cwd: path.resolve(".") },
    );
    assert.equal(stderr, "");
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, "recordings show");
    assert.equal(envelope.requestID, "show-test");
    assert.equal(envelope.result.recordingID, recordingID);
    assert.equal(envelope.result.pcmFileCount, 1);
    assert.equal(envelope.result.pcmFileBytes, 100);
    assert.equal(envelope.result.audioFileBytes, 50);
  } finally {
    await rm(inventory.home, { recursive: true, force: true });
  }
});
