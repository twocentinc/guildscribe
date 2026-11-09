import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getPaths } from "../dist/config.js";
import { invokeHook } from "../dist/hooks.js";

test("channel hooks receive active channel and recording identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-hook-"));
  const paths = getPaths(root);
  const directory = path.join(root, "recording");
  const executable = path.join(root, "capture-hook.mjs");
  const output = path.join(directory, "hook-output.json");
  await mkdir(path.join(directory, "intervals"), { recursive: true });
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
await writeFile("hook-output.json", JSON.stringify({ argument: process.argv[2], payload: JSON.parse(input) }));
`,
  );
  await chmod(executable, 0o700);

  const manifest = {
    schemaVersion: 1,
    recordingID: "recording-1",
    guildID: "111111111111111111",
    guildName: null,
    channelID: "222222222222222222",
    channelName: null,
    status: "recording",
    startedAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    endedAt: null,
    durationMs: null,
    recoveredAfterRestart: false,
    error: null,
  };
  const location = {
    directory,
    intervalsDirectory: path.join(directory, "intervals"),
    manifestPath: path.join(directory, "recording.json"),
  };
  const config = {
    discordToken: "not-exposed",
    voiceChannelIDs: [manifest.channelID],
    emptyGraceMs: 30_000,
    hookTimeoutMs: 30_000,
    hooks: { channelJoined: executable },
  };

  try {
    await invokeHook(paths, config, "channel.joined", location, manifest);
    const captured = JSON.parse(await readFile(output, "utf8"));
    assert.equal(captured.argument, "channel.joined");
    assert.equal(captured.payload.event, "channel.joined");
    assert.equal(captured.payload.recordingID, manifest.recordingID);
    assert.equal(captured.payload.guildID, manifest.guildID);
    assert.equal(captured.payload.channelID, manifest.channelID);
    assert.doesNotMatch(JSON.stringify(captured), /not-exposed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
