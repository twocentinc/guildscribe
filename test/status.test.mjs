import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getPaths,
  initializeHome,
} from "../dist/config.js";
import { createRecording, saveManifest } from "../dist/recording.js";
import {
  classifyDaemonHealth,
  daemonLockText,
  getRuntimeStatus,
  parseDaemonLock,
  writeDaemonRuntimeState,
} from "../dist/status.js";

test("runtime status reports daemon, active recording, grace, and storage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-status-"));
  const paths = getPaths(path.join(root, "home"));
  try {
    await initializeHome(
      paths,
      {
        discordToken: "secret-token",
        voiceChannelIDs: ["111111111111111111"],
        emptyGraceMs: 30_000,
      },
      false,
    );
    const startedAt = new Date(Date.now() - 10_000);
    const active = await createRecording(
      paths,
      "222222222222222222",
      "111111111111111111",
      startedAt,
      { guildName: "Guild", channelName: "Meeting" },
    );
    active.manifest.emptySince = new Date(Date.now() - 1_000).toISOString();
    await saveManifest(active.location, active.manifest);
    await mkdir(path.dirname(paths.lock), { recursive: true });
    await writeFile(
      paths.lock,
      daemonLockText(process.pid, new Date(Date.now() - 20_000)),
    );
    const runtimeStartedAt = new Date(Date.now() - 20_000).toISOString();
    await writeDaemonRuntimeState(paths, {
      version: 1,
      pid: process.pid,
      startedAt: runtimeStartedAt,
      updatedAt: new Date().toISOString(),
      state: "ready",
      discordReady: true,
      lastError: null,
    });

    const result = await getRuntimeStatus(paths);
    assert.equal(result.daemon.health, "recording");
    assert.equal(result.daemon.running, true);
    assert.equal(result.daemon.pid, process.pid);
    assert.ok(result.daemon.uptimeMs >= 20_000);
    assert.equal(result.daemon.discordReady, true);
    assert.ok(result.daemon.heartbeatAt);
    assert.equal((await stat(paths.runtimeState)).mode & 0o077, 0);
    assert.equal(result.recording.recordingID, active.manifest.recordingID);
    assert.equal(result.recording.guildName, "Guild");
    assert.equal(result.recording.channelName, "Meeting");
    assert.ok(result.recording.graceRemainingMs > 0);
    assert.equal(result.storage.recordingCount, 1);
    assert.equal(result.latestRecording, null);
    assert.doesNotMatch(JSON.stringify(result), /secret-token/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon health distinguishes stopped, stale, and degraded states", () => {
  const now = new Date("2026-11-06T12:00:00.000Z");
  const lock = {
    version: 1,
    pid: process.pid,
    startedAt: "2026-11-06T11:00:00.000Z",
  };
  const runtime = {
    version: 1,
    pid: process.pid,
    startedAt: lock.startedAt,
    updatedAt: now.toISOString(),
    state: "degraded",
    discordReady: false,
    lastError: "gateway disconnected",
  };
  assert.equal(
    classifyDaemonHealth({
      running: false,
      lock,
      runtime,
      recording: null,
      now,
    }),
    "stopped",
  );
  assert.equal(
    classifyDaemonHealth({
      running: true,
      lock,
      runtime: {
        ...runtime,
        updatedAt: "2026-11-06T11:59:00.000Z",
      },
      recording: null,
      now,
    }),
    "stale",
  );
  assert.equal(
    classifyDaemonHealth({
      running: true,
      lock,
      runtime,
      recording: null,
      now,
    }),
    "degraded",
  );
});

test("daemon lock parser accepts legacy PID locks", () => {
  const parsed = parseDaemonLock("12345\n");
  assert.equal(parsed.pid, 12345);
  assert.equal(parsed.startedAt, new Date(0).toISOString());
});
