import assert from "node:assert/strict";
import {
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

import { getPaths, initializeHome, loadConfig } from "../dist/config.js";

test("initialization writes owner-only configuration and refuses overwrite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-config-"));
  const home = path.join(root, "home");
  const paths = getPaths(home);
  const request = {
    discordToken: "test-token-value",
    voiceChannelIDs: ["123456789012345678", "223456789012345678"],
    emptyGraceMs: 42_000,
    hooks: {
      channelJoined: "/usr/bin/true",
      channelLeft: "/usr/bin/true",
      recordingCompleted: "/usr/bin/true",
    },
  };
  try {
    const initialized = await initializeHome(paths, request, false);
    assert.equal(initialized.created, true);
    assert.equal((await stat(home)).mode & 0o077, 0);
    assert.equal((await stat(paths.env)).mode & 0o077, 0);
    assert.ok((await stat(paths.logs)).isDirectory());
    const config = await loadConfig(paths);
    assert.equal(config.discordToken, request.discordToken);
    assert.deepEqual(config.voiceChannelIDs, request.voiceChannelIDs);
    assert.equal(config.emptyGraceMs, 42_000);
    assert.equal(config.hooks.channelJoined, "/usr/bin/true");
    assert.equal(config.hooks.channelLeft, "/usr/bin/true");
    assert.equal(config.hooks.recordingCompleted, "/usr/bin/true");
    assert.match(
      await readFile(paths.env, "utf8"),
      /GUILDSCRIBE_DISCORD_TOKEN/,
    );
    assert.match(
      await readFile(paths.env, "utf8"),
      /GUILDSCRIBE_VOICE_CHANNEL_IDS/,
    );

    await assert.rejects(
      initializeHome(paths, request, false),
      (error) => error?.code === "configuration_exists",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration reads the legacy singular channel key as a fallback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-legacy-config-"));
  const home = path.join(root, "home");
  const paths = getPaths(home);
  try {
    await mkdir(home, { recursive: true });
    await writeFile(
      paths.env,
      [
        'GUILDSCRIBE_DISCORD_TOKEN="token"',
        'GUILDSCRIBE_VOICE_CHANNEL_ID="123456789012345678"',
        "",
      ].join("\n"),
    );
    const config = await loadConfig(paths);
    assert.deepEqual(config.voiceChannelIDs, ["123456789012345678"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dry-run initialization creates nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-dry-run-"));
  const home = path.join(root, "home");
  try {
    const result = await initializeHome(
      getPaths(home),
      {
        discordToken: "token",
        voiceChannelIDs: ["123456789012345678"],
      },
      true,
    );
    assert.equal(result.created, false);
    await assert.rejects(stat(home), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
