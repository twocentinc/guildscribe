import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { GuildscribePaths } from "./config.js";
import {
  MacOSLaunchAgent,
  type LaunchAgentDefinition,
  type LaunchAgentStatus,
} from "./macosLaunchAgent.js";
import { GuildscribeError } from "./results.js";

export const GUILDSCRIBE_LAUNCH_AGENT_LABEL = "dev.guildscribe.daemon";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const getGuildscribeLaunchAgentDefinition = (
  paths: GuildscribePaths,
): LaunchAgentDefinition => ({
  label: GUILDSCRIBE_LAUNCH_AGENT_LABEL,
  plistPath: path.join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${GUILDSCRIBE_LAUNCH_AGENT_LABEL}.plist`,
  ),
  programArguments: [
    "/bin/bash",
    path.join(projectRoot, "scripts", "daemon"),
    paths.home,
    process.execPath,
  ],
  workingDirectory: projectRoot,
  standardOutPath: paths.launchdStdoutLog,
  standardErrorPath: paths.launchdStderrLog,
  processType: "Standard",
  throttleIntervalSeconds: 30,
  umask: 0o077,
});

const managerFor = (paths: GuildscribePaths): MacOSLaunchAgent =>
  new MacOSLaunchAgent(getGuildscribeLaunchAgentDefinition(paths));

const prepareInstall = async (paths: GuildscribePaths): Promise<void> => {
  try {
    await access(paths.env);
  } catch (error) {
    throw new GuildscribeError(
      "configuration_missing",
      "Guildscribe must be initialized before startup is installed",
      { details: { configurationPath: paths.env }, cause: error },
    );
  }
  const daemonScript = path.join(projectRoot, "scripts", "daemon");
  try {
    await access(daemonScript, constants.X_OK);
    await access(process.execPath, constants.X_OK);
  } catch (error) {
    throw new GuildscribeError(
      "startup_executable_missing",
      "The daemon wrapper or Node executable is unavailable",
      {
        details: { daemonScript, nodeExecutable: process.execPath },
        cause: error,
      },
    );
  }
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
};

export const planStartupInstall = (
  paths: GuildscribePaths,
): {
  label: string;
  plistPath: string;
  plist: string;
} => {
  const manager = managerFor(paths);
  return {
    label: manager.definition.label,
    plistPath: manager.definition.plistPath,
    plist: manager.render(),
  };
};

export const installStartup = async (
  paths: GuildscribePaths,
): Promise<LaunchAgentStatus> => {
  await prepareInstall(paths);
  return managerFor(paths).install();
};

export const uninstallStartup = async (
  paths: GuildscribePaths,
): Promise<LaunchAgentStatus> => managerFor(paths).uninstall();

export const getStartupStatus = async (
  paths: GuildscribePaths,
): Promise<LaunchAgentStatus> => managerFor(paths).status();

export const startStartup = async (
  paths: GuildscribePaths,
): Promise<LaunchAgentStatus> => managerFor(paths).start();

export const stopStartup = async (
  paths: GuildscribePaths,
): Promise<LaunchAgentStatus> => managerFor(paths).stop();

export const restartStartup = async (
  paths: GuildscribePaths,
): Promise<LaunchAgentStatus> => managerFor(paths).restart();

const lastLines = (contents: string, count: number): string[] => {
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-count);
};

export const readStartupLogs = async (
  paths: GuildscribePaths,
  lineCount: number,
): Promise<{ files: Array<{ path: string; lines: string[] }> }> => {
  if (!Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 10_000) {
    throw new GuildscribeError(
      "invalid_log_line_count",
      "--lines must be an integer between 1 and 10000",
    );
  }
  const files = await Promise.all(
    [paths.daemonLog, paths.launchdStdoutLog, paths.launchdStderrLog].map(
      async (filePath) => {
        const contents = await readFile(filePath, "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          },
        );
        return { path: filePath, lines: lastLines(contents, lineCount) };
      },
    ),
  );
  return { files };
};
