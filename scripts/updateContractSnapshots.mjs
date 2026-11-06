import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandCatalog } from "../dist/commands.js";
import { schemaCatalog } from "../dist/protocol.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const snapshots = path.join(root, "test", "snapshots");
await mkdir(snapshots, { recursive: true });
await writeFile(
  path.join(snapshots, "command-catalog.json"),
  `${JSON.stringify(commandCatalog(), null, 2)}\n`,
);
await writeFile(
  path.join(snapshots, "schemas.json"),
  `${JSON.stringify(schemaCatalog(), null, 2)}\n`,
);
