import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getPaths } from "../dist/config.js";
import {
  capturedDurationMs,
  createRecording,
  loadIntervals,
  publishRecording,
  saveInterval,
  saveManifest,
} from "../dist/recording.js";
import { renderMaster } from "../dist/renderer.js";
import { recoverRecordings } from "../dist/recording.js";

test("recording manifests retain speaker metadata and publish validated audio", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-recording-"));
  const paths = getPaths(root);
  const started = new Date("2026-11-05T12:00:00.000Z");
  try {
    const active = await createRecording(
      paths,
      "111111111111111111",
      "222222222222222222",
      started,
    );
    const interval = {
      version: 1,
      intervalID: "interval-one",
      recordingID: active.manifest.recordingID,
      kind: "speaking",
      userID: "333333333333333333",
      username: "speaker",
      displayName: "Speaker Name",
      startOffsetMs: 0,
      endOffsetMs: 0,
      incomplete: false,
      reason: null,
      pcmFile: "interval-one.pcm",
      updatedAt: started.toISOString(),
    };
    const pcm = Buffer.alloc((48_000 * 2 * 2) / 5);
    await writeFile(
      path.join(active.location.intervalsDirectory, interval.pcmFile),
      pcm,
    );
    await saveInterval(active.location, interval);
    const intervals = await loadIntervals(active.location);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].displayName, "Speaker Name");
    assert.equal(await capturedDurationMs(active.location, intervals), 200);

    active.manifest.status = "finalizing";
    active.manifest.durationMs = 200;
    active.manifest.endedAt = new Date(started.getTime() + 200).toISOString();
    await saveManifest(active.location, active.manifest);
    const rendered = await renderMaster(active.location, 200, intervals);
    assert.equal(rendered.audioFile, "audio.mp3");
    assert.ok(
      (await stat(path.join(active.location.directory, "audio.mp3"))).size > 0,
    );

    active.manifest.status = "complete";
    active.manifest.audioFile = "audio.mp3";
    active.manifest.intervalCount = intervals.length;
    await saveManifest(active.location, active.manifest);
    const published = await publishRecording(
      paths,
      active.location,
      active.manifest,
    );
    assert.match(published.directory, /recordings\/2026\/11\//);
    const finalManifest = JSON.parse(
      await readFile(published.manifestPath, "utf8"),
    );
    assert.equal(finalManifest.status, "complete");
    assert.equal(
      (await stat(path.join(published.intervalsDirectory, "interval-one.pcm")))
        .size,
      pcm.length,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon recovery renders an interrupted capture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-recovery-"));
  const paths = getPaths(root);
  const started = new Date("2026-11-05T13:00:00.000Z");
  try {
    const active = await createRecording(
      paths,
      "111111111111111111",
      "222222222222222222",
      started,
    );
    const interval = {
      version: 1,
      intervalID: "recovered-interval",
      recordingID: active.manifest.recordingID,
      kind: "speaking",
      userID: "333333333333333333",
      username: "speaker",
      displayName: "Speaker",
      startOffsetMs: 0,
      endOffsetMs: 100,
      incomplete: true,
      reason: null,
      pcmFile: "recovered-interval.pcm",
      updatedAt: started.toISOString(),
    };
    await writeFile(
      path.join(active.location.intervalsDirectory, interval.pcmFile),
      Buffer.alloc((48_000 * 2 * 2) / 10),
    );
    await saveInterval(active.location, interval);
    await recoverRecordings(paths, {
      discordToken: "not-used",
      voiceChannelIDs: ["222222222222222222"],
      emptyGraceMs: 30_000,
      hookTimeoutMs: 30_000,
      hooks: {},
    });
    const published = path.join(
      paths.recordings,
      "2026",
      "11",
      active.manifest.recordingID,
    );
    const recovered = JSON.parse(
      await readFile(path.join(published, "recording.json"), "utf8"),
    );
    assert.equal(recovered.status, "complete");
    assert.equal(recovered.interrupted, true);
    assert.ok((await stat(path.join(published, "audio.mp3"))).size > 0);
    assert.ok(
      (await stat(path.join(published, "intervals", "recovered-interval.pcm")))
        .size > 0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
