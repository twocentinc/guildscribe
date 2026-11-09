import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cliContract,
  documentContracts,
  sqliteContract,
  assertUnchangedVersion,
} from "./contractCatalog.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const snapshots = path.join(root, "test", "snapshots");
const versions = path.join(snapshots, "versions");
const cli = cliContract(),
  documents = documentContracts(),
  sqlite = await sqliteContract();
const archives = [
  [`cli-v${cli.schemaVersion}.json`, cli],
  [`sqlite-v${sqlite.schemaVersion}.json`, sqlite],
  ...Object.entries(documents).map(([name, contract]) => [
    `document-${name}-v${contract.contractVersion}.json`,
    contract,
  ]),
];
// Preflight the entire set before writing anything. A normal refresh cannot
// silently bless same-version drift in previously accepted contracts.
for (const [name, value] of archives) {
  try {
    assertUnchangedVersion(
      JSON.parse(await readFile(path.join(versions, name), "utf8")),
      value,
      name,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
await mkdir(versions, { recursive: true });
for (const [name, value] of archives) {
  try {
    await writeFile(
      path.join(versions, name),
      JSON.stringify(value, null, 2) + "\n",
      { flag: "wx" },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
for (const [name, value] of [
  [
    "command-catalog.json",
    { commands: cli.commands, globalOptions: cli.globalOptions },
  ],
  [
    "schemas.json",
    {
      protocolVersion: cli.protocolVersion,
      schemaVersion: cli.schemaVersion,
      schemas: cli.schemas,
    },
  ],
  ["documents.json", documents],
  ["sqlite-schema.json", sqlite],
])
  await writeFile(
    path.join(snapshots, name),
    JSON.stringify(value, null, 2) + "\n",
  );
process.stdout.write(
  "Updated reviewed contract snapshots; existing version archives remain immutable.\n",
);
