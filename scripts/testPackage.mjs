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
  if (!filename)
    throw new Error("npm pack did not return an artifact filename");
  const files = report.files.map(({ path: filePath }) => filePath).sort();
  const required = [
    "LICENSE",
    "README.md",
    "dist/commands.js",
    "dist/index.js",
    "dist/protocol.js",
    "dist/storage.js",
    "dist/databaseWorker.js",
    "dist/messages.js",
    "dist/history.js",
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
        "scripts/contractCatalog.mjs",
      ].includes(filePath),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `packed artifact contains forbidden files: ${forbidden.join(", ")}`,
    );
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
  // Install the artifact with lifecycle scripts disabled, then explicitly build
  // only the approved native SQLite dependency before exercising its worker.
  const native = spawnSync(
    "npm",
    ["rebuild", "better-sqlite3", "--prefix", prefix],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      stdio: "inherit",
    },
  );
  if (native.status !== 0) process.exit(native.status ?? 1);
  const databaseSmoke = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { pathToFileURL } from 'node:url';
    const { databaseCall } = await import(pathToFileURL(process.argv[1]).href);
    const [rows] = await databaseCall(process.argv[2], [{sql:"SELECT name FROM sqlite_master WHERE type='table'",mode:"all"}], true);
    for (const name of ['recordings','transcripts','transcript_segments','messages','messages_fts','transcript_segments_fts']) {
      if (!rows.some(row => row.name === name)) throw new Error('Missing packed table: '+name);
    }
  `,
      path.join(prefix, "node_modules", "guildscribe", "dist", "storage.js"),
      path.join(temporary, "guildscribe.sqlite"),
    ],
    {
      cwd: temporary,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (databaseSmoke.status !== 0) process.exit(databaseSmoke.status ?? 1);
  const executable = path.join(prefix, "node_modules", ".bin", "guildscribe");
  const smoke = spawnSync(executable, ["version"], {
    cwd: temporary,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (smoke.status !== 0) process.exit(smoke.status ?? 1);
  const envelope = JSON.parse(smoke.stdout);
  if (envelope.ok !== true || envelope.result?.version === undefined) {
    throw new Error(
      "Packed guildscribe executable returned an invalid envelope",
    );
  }
  const help = spawnSync(executable, ["help"], {
    cwd: temporary,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (help.status !== 0) process.exit(help.status ?? 1);
  const helpEnvelope = JSON.parse(help.stdout);
  if (
    helpEnvelope.ok !== true ||
    !Array.isArray(helpEnvelope.result?.commands)
  ) {
    throw new Error("Packed guildscribe executable returned invalid JSON help");
  }
  for (const args of [
    ["messages", "list"],
    ["messages", "search", "example"],
    ["transcript", "search", "example"],
    ["database", "status"],
    ["database", "verify"],
  ]) {
    const result = spawnSync(executable, ["--home", temporary, ...args], {
      cwd: temporary,
      encoding: "utf8",
    });
    // Smoke database is a valid empty home for read-only commands.
    if (result.status !== 0)
      throw new Error(
        `Packed command failed: ${args.join(" ")}: ${result.stdout}`,
      );
    if (!JSON.parse(result.stdout).ok)
      throw new Error("Packed history result failed");
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
