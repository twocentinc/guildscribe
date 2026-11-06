import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { GuildscribeError, sanitizeError } from "./results.js";

export type LaunchAgentProcessType = "Background" | "Interactive" | "Standard";

export interface LaunchAgentDefinition {
  label: string;
  plistPath: string;
  programArguments: readonly string[];
  workingDirectory?: string;
  standardOutPath: string;
  standardErrorPath: string;
  processType?: LaunchAgentProcessType;
  throttleIntervalSeconds?: number;
  umask?: number;
}

export interface LaunchAgentStatus {
  label: string;
  plistPath: string;
  configured: boolean;
  loaded: boolean;
  running: boolean;
  state: string | null;
  pid: number | null;
  lastExitStatus: number | null;
}

export interface LaunchAgentCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type LaunchAgentCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<LaunchAgentCommandResult>;

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const stringEntry = (key: string, value: string): string =>
  `  <key>${key}</key>\n  <string>${xmlEscape(value)}</string>`;

const integerEntry = (key: string, value: number): string =>
  `  <key>${key}</key>\n  <integer>${value}</integer>`;

export const renderLaunchAgentPlist = (
  definition: LaunchAgentDefinition,
): string => {
  if (!/^[A-Za-z0-9.-]+$/.test(definition.label)) {
    throw new GuildscribeError(
      "invalid_launch_agent",
      "Invalid LaunchAgent label",
    );
  }
  if (definition.programArguments.length === 0) {
    throw new GuildscribeError(
      "invalid_launch_agent",
      "A LaunchAgent requires at least one program argument",
    );
  }
  const argumentsXML = definition.programArguments
    .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
    .join("\n");
  const entries = [
    stringEntry("Label", definition.label),
    `  <key>ProgramArguments</key>\n  <array>\n${argumentsXML}\n  </array>`,
    "  <key>RunAtLoad</key>\n  <true/>",
    "  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>",
    stringEntry("ProcessType", definition.processType ?? "Standard"),
    integerEntry("ThrottleInterval", definition.throttleIntervalSeconds ?? 30),
    integerEntry("Umask", definition.umask ?? 0o077),
    stringEntry("StandardOutPath", definition.standardOutPath),
    stringEntry("StandardErrorPath", definition.standardErrorPath),
  ];
  if (definition.workingDirectory) {
    entries.splice(
      2,
      0,
      stringEntry("WorkingDirectory", definition.workingDirectory),
    );
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...entries,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
};

export const parseLaunchctlPrint = (
  label: string,
  plistPath: string,
  output: string,
  configured = true,
): LaunchAgentStatus => {
  const state = /^\s*state\s*=\s*(.+)$/m.exec(output)?.[1]?.trim() ?? null;
  const pidText = /^\s*pid\s*=\s*(\d+)$/m.exec(output)?.[1];
  const exitText = /^\s*last exit code\s*=\s*(-?\d+)$/m.exec(output)?.[1];
  const pid = pidText === undefined ? null : Number(pidText);
  return {
    label,
    plistPath,
    configured,
    loaded: true,
    running: state === "running" || pid !== null,
    state,
    pid,
    lastExitStatus: exitText === undefined ? null : Number(exitText),
  };
};

const defaultCommandRunner: LaunchAgentCommandRunner = async (
  executable,
  args,
) =>
  new Promise<LaunchAgentCommandResult>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

const fileExists = async (candidate: string): Promise<boolean> => {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const assertSupportedHost = (): number => {
  if (process.platform !== "darwin") {
    throw new GuildscribeError(
      "unsupported_platform",
      "LaunchAgent startup management is available only on macOS",
    );
  }
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) {
    throw new GuildscribeError(
      "invalid_launch_agent_user",
      "LaunchAgents must be managed by a non-root macOS user",
    );
  }
  return uid;
};

const runRequired = async (
  runner: LaunchAgentCommandRunner,
  executable: string,
  args: readonly string[],
): Promise<LaunchAgentCommandResult> => {
  const result = await runner(executable, args);
  if (result.exitCode !== 0) {
    throw new GuildscribeError("launchctl_failed", "launchctl command failed", {
      details: {
        arguments: args,
        exitCode: result.exitCode,
        message: sanitizeError(result.stderr || result.stdout),
      },
      retrySafety: "safe",
    });
  }
  return result;
};

const writePlistAtomically = async (
  definition: LaunchAgentDefinition,
  contents: string,
): Promise<void> => {
  await mkdir(path.dirname(definition.plistPath), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${definition.plistPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, definition.plistPath);
    await chmod(definition.plistPath, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class MacOSLaunchAgent {
  readonly definition: LaunchAgentDefinition;
  readonly #runner: LaunchAgentCommandRunner;

  public constructor(
    definition: LaunchAgentDefinition,
    runner: LaunchAgentCommandRunner = defaultCommandRunner,
  ) {
    this.definition = definition;
    this.#runner = runner;
  }

  public render(): string {
    return renderLaunchAgentPlist(this.definition);
  }

  public async status(): Promise<LaunchAgentStatus> {
    const uid = assertSupportedHost();
    const configured = await fileExists(this.definition.plistPath);
    const target = `gui/${uid}/${this.definition.label}`;
    const result = await this.#runner("/bin/launchctl", ["print", target]);
    if (result.exitCode !== 0) {
      return {
        label: this.definition.label,
        plistPath: this.definition.plistPath,
        configured,
        loaded: false,
        running: false,
        state: null,
        pid: null,
        lastExitStatus: null,
      };
    }
    return parseLaunchctlPrint(
      this.definition.label,
      this.definition.plistPath,
      result.stdout,
      configured,
    );
  }

  public async install(): Promise<LaunchAgentStatus> {
    const uid = assertSupportedHost();
    const domain = `gui/${uid}`;
    const target = `${domain}/${this.definition.label}`;
    await this.#runner("/bin/launchctl", ["bootout", target]);
    await writePlistAtomically(this.definition, this.render());
    await runRequired(this.#runner, "/bin/launchctl", [
      "bootstrap",
      domain,
      this.definition.plistPath,
    ]);
    await runRequired(this.#runner, "/bin/launchctl", ["enable", target]);
    return this.status();
  }

  public async uninstall(): Promise<LaunchAgentStatus> {
    const uid = assertSupportedHost();
    const target = `gui/${uid}/${this.definition.label}`;
    await this.#runner("/bin/launchctl", ["bootout", target]);
    await unlink(this.definition.plistPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    return this.status();
  }

  async #ensureLoaded(uid: number): Promise<void> {
    const current = await this.status();
    if (current.loaded) return;
    if (!current.configured) {
      throw new GuildscribeError(
        "launch_agent_not_installed",
        "The LaunchAgent is not installed; run startup install first",
      );
    }
    const domain = `gui/${uid}`;
    await runRequired(this.#runner, "/bin/launchctl", [
      "bootstrap",
      domain,
      this.definition.plistPath,
    ]);
    await runRequired(this.#runner, "/bin/launchctl", [
      "enable",
      `${domain}/${this.definition.label}`,
    ]);
  }

  public async start(): Promise<LaunchAgentStatus> {
    const uid = assertSupportedHost();
    await this.#ensureLoaded(uid);
    await runRequired(this.#runner, "/bin/launchctl", [
      "kickstart",
      `gui/${uid}/${this.definition.label}`,
    ]);
    return this.status();
  }

  public async stop(): Promise<LaunchAgentStatus> {
    const uid = assertSupportedHost();
    const current = await this.status();
    if (!current.loaded || !current.running) return current;
    await runRequired(this.#runner, "/bin/launchctl", [
      "kill",
      "SIGTERM",
      `gui/${uid}/${this.definition.label}`,
    ]);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(250);
      const status = await this.status();
      if (!status.running) return status;
    }
    throw new GuildscribeError(
      "launch_agent_stop_timeout",
      "The LaunchAgent did not stop within 10 seconds",
      { retrySafety: "safe" },
    );
  }

  public async restart(): Promise<LaunchAgentStatus> {
    const uid = assertSupportedHost();
    await this.#ensureLoaded(uid);
    const current = await this.status();
    if (current.running) await this.stop();
    await runRequired(this.#runner, "/bin/launchctl", [
      "kickstart",
      `gui/${uid}/${this.definition.label}`,
    ]);
    return this.status();
  }
}

export const readLaunchAgentPlist = async (
  plistPath: string,
): Promise<string> => readFile(plistPath, "utf8");
