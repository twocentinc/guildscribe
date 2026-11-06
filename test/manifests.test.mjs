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
  readManifest,
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
      intervalID: "11111111-1111-4111-8111-111111111111",
      recordingID: active.manifest.recordingID,
      kind: "speaking",
      userID: "333333333333333333",
      username: "speaker",
      displayName: "Speaker Name",
      startOffsetMs: 0,
      endOffsetMs: 0,
      incomplete: false,
      reason: null,
      pcmFile: "11111111-1111-4111-8111-111111111111.pcm",
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
    assert.deepEqual(finalManifest.pcmFormat, {
      encoding: "s16le",
      sampleRateHz: 48_000,
      channels: 2,
    });
    assert.equal(
      (await stat(path.join(published.intervalsDirectory, interval.pcmFile)))
        .size,
      pcm.length,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recording schemas normalize legacy PCM metadata and reject unsafe identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-schema-"));
  const paths = getPaths(root);
  try {
    const active = await createRecording(
      paths,
      "111111111111111111",
      "222222222222222222",
      new Date("2026-11-05T12:00:00.000Z"),
    );
    const legacy = JSON.parse(
      await readFile(active.location.manifestPath, "utf8"),
    );
    delete legacy.pcmFormat;
    await writeFile(active.location.manifestPath, JSON.stringify(legacy));
    const normalized = await readManifest(active.location);
    assert.deepEqual(normalized.pcmFormat, {
      encoding: "s16le",
      sampleRateHz: 48_000,
      channels: 2,
    });
    await assert.rejects(
      saveManifest(active.location, {
        ...normalized,
        status: "complete",
      }),
    );

    legacy.recordingID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await writeFile(active.location.manifestPath, JSON.stringify(legacy));
    await assert.rejects(readManifest(active.location), {
      code: "invalid_recording_manifest",
    });

    await assert.rejects(
      saveInterval(active.location, {
        version: 1,
        intervalID: "../escape",
        recordingID: active.manifest.recordingID,
        kind: "speaking",
        userID: "333333333333333333",
        username: "speaker",
        displayName: "Speaker",
        startOffsetMs: 0,
        endOffsetMs: 100,
        incomplete: false,
        reason: null,
        pcmFile: "../escape.pcm",
        updatedAt: active.manifest.startedAt,
      }),
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
      intervalID: "22222222-2222-4222-8222-222222222222",
      recordingID: active.manifest.recordingID,
      kind: "speaking",
      userID: "333333333333333333",
      username: "speaker",
      displayName: "Speaker",
      startOffsetMs: 0,
      endOffsetMs: 100,
      incomplete: true,
      reason: null,
      pcmFile: "22222222-2222-4222-8222-222222222222.pcm",
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
      (await stat(path.join(published, "intervals", interval.pcmFile)))
        .size > 0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
