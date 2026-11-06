import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifacts = path.join(root, "artifacts");
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
const cache = await mkdtemp(path.join(tmpdir(), "guildscribe-npm-cache-"));

try {
  const packed = spawnSync(
    "npm",
    ["pack", "--json", "--pack-destination", artifacts],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: cache },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (packed.status !== 0) {
    throw new Error(`npm pack failed with exit code ${String(packed.status)}`);
  }
  const result = JSON.parse(packed.stdout);
  const filename = result[0]?.filename;
  if (!filename) throw new Error("npm pack did not return an artifact filename");
  const artifact = path.join(artifacts, filename);
  const sha256 = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  await writeFile(
    `${artifact}.sha256`,
    `${sha256}  ${path.basename(artifact)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ artifact, sha256, checksum: `${artifact}.sha256` })}\n`,
  );
} finally {
  await rm(cache, { recursive: true, force: true });
}
