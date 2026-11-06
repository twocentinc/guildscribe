import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getPaths,
  initializeHome,
} from "../dist/config.js";
import { createRecording, saveManifest } from "../dist/manifests.js";
import {
  daemonLockText,
  getRuntimeStatus,
  parseDaemonLock,
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

    const result = await getRuntimeStatus(paths);
    assert.equal(result.daemon.running, true);
    assert.equal(result.daemon.pid, process.pid);
    assert.ok(result.daemon.uptimeMs >= 20_000);
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

test("daemon lock parser accepts legacy PID locks", () => {
  const parsed = parseDaemonLock("12345\n");
  assert.equal(parsed.pid, 12345);
  assert.equal(parsed.startedAt, new Date(0).toISOString());
});
