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

import {
  getPaths,
  initializeHome,
  loadConfig,
  redactedConfiguration,
  updateConfiguration,
} from "../dist/config.js";

test("initialization writes owner-only configuration and refuses overwrite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-config-"));
  const home = path.join(root, "home");
  const paths = getPaths(home);
  const request = {
    discordToken: "test-token-value",
    ownerUserID: "157904074535206912",
    voiceChannelIDs: ["123456789012345678", "223456789012345678"],
    emptyGraceMs: 42_000,
    transcriptionHook: "/usr/bin/true",
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
    assert.equal(config.ownerUserID, request.ownerUserID);
    assert.deepEqual(config.voiceChannelIDs, request.voiceChannelIDs);
    assert.equal(config.emptyGraceMs, 42_000);
    assert.equal(config.transcriptionHook, "/usr/bin/true");
    assert.equal(config.hooks.channelJoined, "/usr/bin/true");
    assert.equal(config.hooks.channelLeft, "/usr/bin/true");
    assert.equal(config.hooks.recordingCompleted, "/usr/bin/true");
    assert.match(
      await readFile(paths.env, "utf8"),
      /GUILDSCRIBE_DISCORD_TOKEN/,
    );
    assert.match(
      await readFile(paths.env, "utf8"),
      /GUILDSCRIBE_OWNER_USER_ID/,
    );
    assert.match(
      await readFile(paths.env, "utf8"),
      /GUILDSCRIBE_VOICE_CHANNEL_IDS/,
    );
    assert.match(
      await readFile(paths.env, "utf8"),
      /GUILDSCRIBE_TRANSCRIPTION_HOOK/,
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
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(
      paths.env,
      [
        'GUILDSCRIBE_DISCORD_TOKEN="token"',
        'GUILDSCRIBE_VOICE_CHANNEL_ID="123456789012345678"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const config = await loadConfig(paths);
    assert.deepEqual(config.voiceChannelIDs, ["123456789012345678"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration loading rejects permissive and symbolic-link secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-secure-config-"));
  const paths = getPaths(path.join(root, "home"));
  const linked = path.join(root, "linked.env");
  try {
    await initializeHome(
      paths,
      {
        discordToken: "secret",
        voiceChannelIDs: ["123456789012345678"],
      },
      false,
    );
    await chmod(paths.env, 0o644);
    await assert.rejects(
      loadConfig(paths),
      (error) => error?.code === "configuration_unsafe",
    );
    await chmod(paths.env, 0o600);
    await writeFile(linked, await readFile(paths.env), { mode: 0o600 });
    await rm(paths.env);
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(linked, paths.env),
    );
    await assert.rejects(
      loadConfig(paths),
      (error) => error?.code === "configuration_unsafe",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initialization refuses an unsafe pre-existing runtime home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-unsafe-home-"));
  const home = path.join(root, "home");
  try {
    await mkdir(home, { mode: 0o755 });
    await assert.rejects(
      initializeHome(
        getPaths(home),
        {
          discordToken: "secret",
          voiceChannelIDs: ["123456789012345678"],
        },
        false,
      ),
      (error) => error?.code === "configuration_unsafe",
    );
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

test("configuration updates are atomic, redacted, and support clearing hooks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-update-config-"));
  const paths = getPaths(path.join(root, "home"));
  try {
    await initializeHome(
      paths,
      {
        discordToken: "original-secret",
        ownerUserID: "157904074535206912",
        voiceChannelIDs: ["123456789012345678"],
        transcriptionHook: "/usr/bin/true",
        hooks: { channelJoined: "/usr/bin/true" },
      },
      false,
    );
    const before = await readFile(paths.env, "utf8");
    const dryRun = await updateConfiguration(
      paths,
      {
        voiceChannelIDs: ["223456789012345678", "123456789012345678"],
        ownerUserID: null,
        transcriptionHook: null,
        hooks: { channelJoined: null, channelLeft: "/usr/bin/false" },
      },
      true,
    );
    assert.equal(dryRun.changed, false);
    assert.equal(dryRun.configuration.discordToken, "[redacted]");
    assert.equal(dryRun.configuration.ownerUserID, null);
    assert.equal(dryRun.configuration.transcriptionHook, null);
    assert.deepEqual(dryRun.configuration.voiceChannelIDs, [
      "223456789012345678",
      "123456789012345678",
    ]);
    assert.equal(await readFile(paths.env, "utf8"), before);

    const applied = await updateConfiguration(
      paths,
      {
        discordToken: "replacement-secret",
        ownerUserID: "257904074535206912",
        voiceChannelIDs: ["223456789012345678", "123456789012345678"],
        transcriptionHook: null,
        hooks: { channelJoined: null, channelLeft: "/usr/bin/false" },
      },
      false,
    );
    assert.equal(applied.changed, true);
    assert.equal(applied.restartRequired, true);
    assert.doesNotMatch(JSON.stringify(applied), /replacement-secret/);
    const config = await loadConfig(paths);
    assert.equal(config.discordToken, "replacement-secret");
    assert.equal(config.ownerUserID, "257904074535206912");
    assert.equal(config.transcriptionHook, undefined);
    assert.equal(config.hooks.channelJoined, undefined);
    assert.equal(config.hooks.channelLeft, "/usr/bin/false");
    assert.deepEqual(
      redactedConfiguration(config).voiceChannelIDs,
      ["223456789012345678", "123456789012345678"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
