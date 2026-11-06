import { constants } from "node:fs";
import { access, open, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} from "discord.js";

import {
  type GuildscribeConfig,
  type GuildscribePaths,
  loadConfig,
  verifyExecutable,
} from "./config.js";
import { runCommand } from "./renderer.js";
import { sanitizeError } from "./results.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  passed: boolean;
}

const modeString = (mode: number): string => `0${(mode & 0o777).toString(8)}`;

const pushCheck = (
  checks: DoctorCheck[],
  name: string,
  ok: boolean,
  message: string,
  details?: Record<string, unknown>,
): void => {
  checks.push(details ? { name, ok, message, details } : { name, ok, message });
};

const checkWritableDirectory = async (
  checks: DoctorCheck[],
  name: string,
  directory: string,
): Promise<void> => {
  const candidate = path.join(directory, `.doctor-${process.pid}.tmp`);
  try {
    const handle = await open(candidate, "wx", 0o600);
    await handle.close();
    await rm(candidate, { force: true });
    pushCheck(checks, name, true, "Directory is writable", { directory });
  } catch (error) {
    await rm(candidate, { force: true }).catch(() => undefined);
    pushCheck(checks, name, false, sanitizeError(error), { directory });
  }
};

const checkTool = async (
  checks: DoctorCheck[],
  name: string,
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<void> => {
  try {
    const result = await runCommand(executable, args, timeoutMs);
    const firstLine = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    pushCheck(checks, name, true, firstLine || `${executable} is callable`);
  } catch (error) {
    pushCheck(checks, name, false, sanitizeError(error));
  }
};

const checkDiscord = async (
  checks: DoctorCheck[],
  config: GuildscribeConfig,
  timeoutMs: number,
): Promise<void> => {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  const ready = new Promise<void>((resolve, reject) => {
    if (client.isReady()) {
      resolve();
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("Discord login timed out")),
      timeoutMs,
    );
    timer.unref();
    client.once(Events.ClientReady, () => {
      clearTimeout(timer);
      resolve();
    });
    client.once(Events.Error, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  try {
    await client.login(config.discordToken);
    await ready;
    const user = client.user;
    pushCheck(
      checks,
      "discord.token",
      Boolean(user?.bot),
      "Discord accepted the bot token",
      {
        botID: user?.id ?? null,
        botTag: user?.tag ?? null,
      },
    );

    for (const channelID of config.voiceChannelIDs) {
      try {
        const channel = await client.channels.fetch(channelID);
        const supported = channel?.type === ChannelType.GuildVoice;
        pushCheck(
          checks,
          `discord.channel.${channelID}`,
          supported,
          supported
            ? "Configured Discord voice channel is available"
            : "Configured channel is missing or is not a guild voice channel",
          {
            channelID,
            channelType: channel?.type ?? null,
            guildID: supported && channel ? channel.guild.id : null,
          },
        );
        if (!supported || !channel || !user) {
          pushCheck(
            checks,
            `discord.permissions.${channelID}`,
            false,
            "Permissions could not be evaluated for the configured channel",
            { channelID },
          );
          continue;
        }
        const permissions = channel.permissionsFor(user.id);
        const canView =
          permissions?.has(PermissionFlagsBits.ViewChannel) ?? false;
        const canConnect =
          permissions?.has(PermissionFlagsBits.Connect) ?? false;
        pushCheck(
          checks,
          `discord.permissions.${channelID}`,
          canView && canConnect,
          canView && canConnect
            ? "Bot can view and connect to the configured channel"
            : "Bot lacks View Channel or Connect permission",
          { channelID, connect: canConnect, viewChannel: canView },
        );
      } catch (error) {
        pushCheck(
          checks,
          `discord.channel.${channelID}`,
          false,
          sanitizeError(error, [config.discordToken]),
          { channelID },
        );
        pushCheck(
          checks,
          `discord.permissions.${channelID}`,
          false,
          "Skipped because the configured channel could not be fetched",
          { channelID },
        );
      }
    }
  } catch (error) {
    const message = sanitizeError(error, [config.discordToken]);
    pushCheck(checks, "discord.token", false, message);
    for (const channelID of config.voiceChannelIDs) {
      pushCheck(
        checks,
        `discord.channel.${channelID}`,
        false,
        "Skipped because Discord login failed",
        { channelID },
      );
      pushCheck(
        checks,
        `discord.permissions.${channelID}`,
        false,
        "Skipped because Discord login failed",
        { channelID },
      );
    }
  } finally {
    client.destroy();
  }
};

export const runDoctor = async (
  paths: GuildscribePaths,
  timeoutMs: number,
): Promise<DoctorResult> => {
  const checks: DoctorCheck[] = [];
  try {
    const info = await stat(paths.home);
    const secure = info.isDirectory() && (info.mode & 0o077) === 0;
    pushCheck(
      checks,
      "filesystem.home",
      secure,
      secure
        ? "Runtime home has owner-only permissions"
        : "Runtime home is too permissive",
      { home: paths.home, mode: modeString(info.mode) },
    );
  } catch (error) {
    pushCheck(checks, "filesystem.home", false, sanitizeError(error), {
      home: paths.home,
    });
  }

  try {
    const info = await stat(paths.env);
    const secure = info.isFile() && (info.mode & 0o077) === 0;
    pushCheck(
      checks,
      "filesystem.configuration",
      secure,
      secure ? ".env has owner-only permissions" : ".env is too permissive",
      { configurationPath: paths.env, mode: modeString(info.mode) },
    );
  } catch (error) {
    pushCheck(checks, "filesystem.configuration", false, sanitizeError(error), {
      configurationPath: paths.env,
    });
  }

  let config: GuildscribeConfig | null = null;
  try {
    config = await loadConfig(paths);
    pushCheck(
      checks,
      "configuration.values",
      true,
      "Required configuration is valid",
      {
        voiceChannelIDs: config.voiceChannelIDs,
        discordToken: "[redacted]",
        emptyGraceMs: config.emptyGraceMs,
      },
    );
  } catch (error) {
    pushCheck(checks, "configuration.values", false, sanitizeError(error));
  }

  await checkWritableDirectory(
    checks,
    "filesystem.inProgress",
    paths.inProgress,
  );
  await checkWritableDirectory(
    checks,
    "filesystem.recordings",
    paths.recordings,
  );
  await checkWritableDirectory(checks, "filesystem.logs", paths.logs);

  if (config) {
    for (const [name, executable] of Object.entries(config.hooks)) {
      try {
        await verifyExecutable(executable);
        pushCheck(checks, `hook.${name}`, true, "Hook is executable", {
          executable,
        });
      } catch (error) {
        pushCheck(checks, `hook.${name}`, false, sanitizeError(error), {
          executable,
        });
      }
    }
  }

  await checkTool(checks, "tool.ffmpeg", "ffmpeg", ["-version"], timeoutMs);
  await checkTool(checks, "tool.ffprobe", "ffprobe", ["-version"], timeoutMs);
  if (config) await checkDiscord(checks, config, timeoutMs);
  else {
    pushCheck(
      checks,
      "discord.token",
      false,
      "Skipped because configuration is invalid",
    );
  }

  return { checks, passed: checks.every((check) => check.ok) };
};
