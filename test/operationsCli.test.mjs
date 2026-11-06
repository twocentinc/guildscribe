import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getPaths, initializeHome } from "../dist/config.js";

const runCLI = (arguments_) =>
  JSON.parse(
    execFileSync(process.execPath, ["dist/index.js", ...arguments_], {
      cwd: process.cwd(),
      encoding: "utf8",
    }),
  );

test("status and configuration commands emit redacted JSON envelopes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "guildscribe-operations-cli-"));
  const home = path.join(root, "home");
  const paths = getPaths(home);
  try {
    await initializeHome(
      paths,
      {
        discordToken: "secret-token",
        voiceChannelIDs: ["111111111111111111"],
      },
      false,
    );
    const status = runCLI(["--home", home, "status"]);
    assert.equal(status.ok, true);
    assert.equal(status.result.daemon.running, false);
    assert.deepEqual(status.result.configuration.voiceChannelIDs, [
      "111111111111111111",
    ]);

    const shown = runCLI(["--home", home, "config", "show"]);
    assert.equal(shown.ok, true);
    assert.equal(shown.result.discordToken, "[redacted]");

    const request = path.join(root, "update.json");
    await writeFile(
      request,
      JSON.stringify({
        voiceChannelIDs: ["222222222222222222", "111111111111111111"],
      }),
    );
    const updated = runCLI([
      "--home",
      home,
      "config",
      "update",
      "--request",
      request,
    ]);
    assert.equal(updated.ok, true);
    assert.equal(updated.result.restartRequired, true);
    assert.deepEqual(updated.result.configuration.voiceChannelIDs, [
      "222222222222222222",
      "111111111111111111",
    ]);
    assert.doesNotMatch(JSON.stringify(updated), /secret-token/);
    assert.doesNotMatch(await readFile(paths.env, "utf8"), /\[redacted\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
