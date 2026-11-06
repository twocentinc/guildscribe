import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = await mkdtemp(path.join(tmpdir(), "guildscribe-package-"));
const environment = {
  ...process.env,
  npm_config_cache: path.join(temporary, "npm-cache"),
};
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
  const report = JSON.parse(packed.stdout)[0];
  const filename = report?.filename;
  if (!filename) throw new Error("npm pack did not return an artifact filename");
  const files = report.files.map(({ path: filePath }) => filePath).sort();
  const required = [
    "LICENSE",
    "README.md",
    "dist/commands.js",
    "dist/index.js",
    "dist/protocol.js",
    "docs/spec.md",
    "package.json",
    "scripts/daemon",
  ];
  for (const requiredPath of required) {
    if (!files.includes(requiredPath)) {
      throw new Error(`packed artifact is missing ${requiredPath}`);
    }
  }
  const forbidden = files.filter(
    (filePath) =>
      filePath.startsWith("src/") ||
      filePath.startsWith("test/") ||
      filePath.startsWith(".github/") ||
      filePath.startsWith("artifacts/") ||
      [
        "scripts/packageRelease.mjs",
        "scripts/testPackage.mjs",
        "scripts/updateContractSnapshots.mjs",
      ].includes(filePath),
  );
  if (forbidden.length > 0) {
    throw new Error(`packed artifact contains forbidden files: ${forbidden.join(", ")}`);
  }
  const prefix = path.join(temporary, "install");
  const installed = spawnSync(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--prefer-offline",
      path.join(temporary, filename),
    ],
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
  const help = spawnSync(executable, ["help"], {
    cwd: temporary,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (help.status !== 0) process.exit(help.status ?? 1);
  const helpEnvelope = JSON.parse(help.stdout);
  if (helpEnvelope.ok !== true || !Array.isArray(helpEnvelope.result?.commands)) {
    throw new Error("Packed guildscribe executable returned invalid JSON help");
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
