import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = await mkdtemp(path.join(tmpdir(), "guildscribe-package-"));
const cache = path.join(temporary, "npm-cache");
const environment = { ...process.env, npm_config_cache: cache };
try {
  const packed = spawnSync(
    "npm",
    ["pack", "--json", "--pack-destination", temporary],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (packed.status !== 0) process.exit(packed.status ?? 1);
  const filename = JSON.parse(packed.stdout)[0]?.filename;
  if (!filename) throw new Error("npm pack did not return an artifact filename");
  const prefix = path.join(temporary, "install");
  const installed = spawnSync(
    "npm",
    ["install", "--prefix", prefix, path.join(temporary, filename)],
    { cwd: root, encoding: "utf8", env: environment, stdio: "inherit" },
  );
  if (installed.status !== 0) process.exit(installed.status ?? 1);
  const executable = path.join(prefix, "node_modules", ".bin", "guildscribe");
  const smoke = spawnSync(executable, ["version"], {
    cwd: temporary,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (smoke.status !== 0) process.exit(smoke.status ?? 1);
  const envelope = JSON.parse(smoke.stdout);
  if (envelope.ok !== true || envelope.result?.version === undefined) {
    throw new Error("Packed guildscribe executable returned an invalid envelope");
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
