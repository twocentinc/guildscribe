import { mkdir, open, readFile, unlink } from "node:fs/promises";

import { Client, Events, GatewayIntentBits } from "discord.js";

import type { GuildscribeConfig, GuildscribePaths } from "./config.js";
import {
  configureDiagnosticFile,
  GuildscribeError,
  diagnostic,
  sanitizeError,
} from "./results.js";
import { GuildscribeRecorder, recoverRecordings } from "./recorder.js";

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const acquireLock = async (
  paths: GuildscribePaths,
): Promise<() => Promise<void>> => {
  const contents = `${process.pid}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(paths.lock, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      return async () => {
        try {
          if ((await readFile(paths.lock, "utf8")) === contents) {
            await unlink(paths.lock);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = Number(
        (await readFile(paths.lock, "utf8").catch(() => "")).trim(),
      );
      if (
        Number.isSafeInteger(existing) &&
        existing > 0 &&
        processIsAlive(existing)
      ) {
        throw new GuildscribeError(
          "daemon_already_running",
          "Another Guildscribe daemon is already running",
          { details: { pid: existing }, retrySafety: "safe" },
        );
      }
      await unlink(paths.lock).catch(() => undefined);
    }
  }
  throw new GuildscribeError("lock_failed", "Could not acquire daemon lock");
};

export const runDaemon = async (
  paths: GuildscribePaths,
  config: GuildscribeConfig,
): Promise<never> => {
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
  configureDiagnosticFile(paths.daemonLog);
  const releaseLock = await acquireLock(paths);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  const recorder = new GuildscribeRecorder({ client, config, paths });
  let shuttingDown = false;

  const shutdown = async (signal: string, exitCode: number): Promise<never> => {
    if (shuttingDown) return new Promise<never>(() => undefined);
    shuttingDown = true;
    diagnostic("info", "daemon.stopping", { signal });
    await recorder.shutdown().catch((error: unknown) => {
      diagnostic("error", "daemon.recorderShutdownFailed", {
        error: sanitizeError(error),
      });
    });
    client.destroy();
    await releaseLock().catch((error: unknown) => {
      diagnostic("error", "daemon.lockReleaseFailed", {
        error: sanitizeError(error),
      });
    });
    process.exit(exitCode);
  };

  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    recorder.handleVoiceStateUpdate(oldState, newState);
  });
  client.on(Events.ShardResume, () => recorder.handleGatewayResume());
  client.on(Events.Error, (error) => {
    diagnostic("error", "discord.clientError", {
      error: sanitizeError(error, [config.discordToken]),
    });
  });

  try {
    await recoverRecordings(paths, config);
    await client.login(config.discordToken);
    if (!client.isReady()) {
      await new Promise<void>((resolve) =>
        client.once(Events.ClientReady, () => resolve()),
      );
    }
    diagnostic("info", "daemon.connected", {
      botID: client.user?.id ?? null,
      botTag: client.user?.tag ?? null,
      voiceChannelIDs: config.voiceChannelIDs,
    });
    await recorder.initialize();
  } catch (error) {
    client.destroy();
    await releaseLock().catch(() => undefined);
    throw new GuildscribeError(
      "daemon_start_failed",
      sanitizeError(error, [config.discordToken]),
      { cause: error, retrySafety: "safe" },
    );
  }

  return new Promise<never>(() => undefined);
};
