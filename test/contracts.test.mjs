import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { commandCatalog, GLOBAL_OPTIONS } from "../dist/commands.js";
import { schemaCatalog } from "../dist/protocol.js";

const readSnapshot = async (name) =>
  JSON.parse(await readFile(new URL(`./snapshots/${name}`, import.meta.url)));

test("command catalog matches its reviewed snapshot", async () => {
  assert.deepEqual(
    { commands: commandCatalog(), globalOptions: [...GLOBAL_OPTIONS] },
    await readSnapshot("command-catalog.json"),
  );
});

test("published JSON schemas match their reviewed snapshot", async () => {
  assert.deepEqual(schemaCatalog(), await readSnapshot("schemas.json"));
});

test("help and version are JSON-native discovery commands", () => {
  for (const arguments_ of [["help"], ["recordings", "--help"], ["--version"]]) {
    const output = execFileSync(
      process.execPath,
      ["dist/index.js", ...arguments_],
      { encoding: "utf8" },
    );
    const envelope = JSON.parse(output);
    assert.equal(envelope.ok, true);
  }
});

test("discovery aliases preserve global controls", () => {
  const output = execFileSync(
    process.execPath,
    [
      "dist/index.js",
      "recordings",
      "--help",
      "--request-id",
      "discovery-test",
    ],
    { encoding: "utf8" },
  );
  const envelope = JSON.parse(output);
  assert.equal(envelope.requestID, "discovery-test");
  assert.deepEqual(envelope.result.scope, ["recordings"]);
  assert.equal(output.trim().split("\n").length, 1);
});

test("invalid CLI input emits one JSON error with a stable exit class", () => {
  const command = spawnSync(
    process.execPath,
    ["dist/index.js", "definitely-not-a-command"],
    { encoding: "utf8" },
  );
  assert.equal(command.status, 2);
  assert.equal(command.stderr, "");
  const envelope = JSON.parse(command.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.retrySafety, "never");
  assert.equal(command.stdout.trim().split("\n").length, 1);
});

test("global duration and verbosity controls are validated", () => {
  for (const arguments_ of [
    ["--timeout", "30", "help"],
    ["--quiet", "--verbose", "help"],
  ]) {
    const command = spawnSync(
      process.execPath,
      ["dist/index.js", ...arguments_],
      { encoding: "utf8" },
    );
    assert.equal(command.status, 2);
    assert.equal(JSON.parse(command.stdout).ok, false);
  }
});
