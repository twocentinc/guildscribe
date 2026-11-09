import {
  cliContract,
  documentContracts,
  sqliteContract,
  assertUnchangedVersion,
  documentDefinitions,
} from "../scripts/contractCatalog.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { commandCatalog, GLOBAL_OPTIONS } from "../dist/commands.js";
import {
  schemaCatalog,
  SCHEMA_VERSION,
  PROTOCOL_VERSION,
} from "../dist/protocol.js";

const readSnapshot = async (name) =>
  JSON.parse(await readFile(new URL(`./snapshots/${name}`, import.meta.url)));

test("command catalog matches its reviewed snapshot", async () => {
  assert.deepEqual(
    { commands: commandCatalog(), globalOptions: [...GLOBAL_OPTIONS] },
    await readSnapshot("command-catalog.json"),
  );
});

test("published JSON schemas match their reviewed snapshot", async () => {
  assert.deepEqual(
    {
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: SCHEMA_VERSION,
      schemas: schemaCatalog(),
    },
    await readSnapshot("schemas.json"),
  );
});

test("help and version are JSON-native discovery commands", () => {
  for (const arguments_ of [
    ["help"],
    ["recordings", "--help"],
    ["--version"],
  ]) {
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
    ["dist/index.js", "recordings", "--help", "--request-id", "discovery-test"],
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

test("CLI and document contracts match their immutable version archives", async () => {
  const cli = cliContract();
  assert.deepEqual(
    cli,
    await readSnapshot(`versions/cli-v${cli.schemaVersion}.json`),
  );
  const documents = documentContracts();
  assert.deepEqual(documents, await readSnapshot("documents.json"));
  for (const [name, contract] of Object.entries(documents)) {
    assert.deepEqual(
      contract,
      await readSnapshot(
        `versions/document-${name}-v${contract.contractVersion}.json`,
      ),
    );
    const properties = contract.schema.properties;
    const wireVersion =
      properties?.schemaVersion?.const ?? properties?.version?.const;
    if (wireVersion !== undefined)
      assert.equal(
        contract.contractVersion,
        wireVersion,
        `${name} must track its wire version`,
      );
  }
});

test("SQLite layout and FTS triggers match their reviewed migration version", async () => {
  const contract = await sqliteContract();
  assert.deepEqual(contract, await readSnapshot("sqlite-schema.json"));
  assert.deepEqual(
    contract,
    await readSnapshot(`versions/sqlite-v${contract.schemaVersion}.json`),
  );
  assert.equal(contract.objects.filter((o) => o.type === "table").length, 6);
  assert.equal(contract.objects.filter((o) => o.type === "trigger").length, 6);
});

test("same-version contract drift cannot be silently refreshed", () => {
  const contract = { contractVersion: 1, schema: { type: "string" } };
  assert.doesNotThrow(() =>
    assertUnchangedVersion(contract, structuredClone(contract), "fixture"),
  );
  assert.throws(
    () =>
      assertUnchangedVersion(
        contract,
        { ...contract, schema: { type: "integer" } },
        "fixture",
      ),
    /frozen/,
  );
});

test("document fixtures remain accepted by the real validators", async () => {
  const fixtures = await readSnapshot("document-fixtures.json");
  assert.deepEqual(
    Object.keys(fixtures).sort(),
    Object.keys(documentDefinitions).sort(),
  );
  for (const [name, value] of Object.entries(fixtures)) {
    assert.equal(
      documentDefinitions[name].schema.safeParse(value).success,
      true,
      name,
    );
    assert.equal(
      documentDefinitions[name].schema.safeParse({
        ...value,
        unexpectedField: true,
      }).success,
      false,
      `${name} rejects unknown fields`,
    );
  }
  const bad = structuredClone(fixtures.interval);
  bad.endOffsetMs = -1;
  assert.equal(
    documentDefinitions.interval.schema.safeParse(bad).success,
    false,
  );
  const unordered = structuredClone(fixtures.participants);
  unordered.participants[0].sessions.push({
    startOffsetMs: 0,
    endOffsetMs: 100,
  });
  assert.equal(
    documentDefinitions.participants.schema.safeParse(unordered).success,
    false,
  );
});
