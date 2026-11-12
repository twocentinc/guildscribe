import { installSlashCommands } from "./discordActions.js";
import { discordIntents, MessageLogger } from "./messages.js";
import { mkdir, open, readFile, unlink } from "node:fs/promises";

import { Client, Events, Partials } from "discord.js";

import type { GuildscribeConfig, GuildscribePaths } from "./config.js";
import {
  configureDiagnosticFile,
  GuildscribeError,
  diagnostic,
  sanitizeError,
} from "./protocol.js";
import { GuildscribeRecorder, recoverRecordings } from "./recording.js";
import { migrateLegacyStorage, TranscriptionWorker } from "./transcription.js";
import {
  DAEMON_HEARTBEAT_INTERVAL_MS,
  daemonLockText,
  parseDaemonLock,
  processIsAlive,
  type DaemonRuntimeState,
  writeDaemonRuntimeState,
} from "./status.js";

export const sendOwnerOnlineNotification = async (
  client: Pick<Client, "users">,
  ownerUserID: string,
): Promise<void> => {
  await client.users.send(ownerUserID, {
    content: "Guildscribe is online.",
    allowedMentions: { parse: [] },
  });
};

const acquireLock = async (
  paths: GuildscribePaths,
  startedAt: Date,
): Promise<() => Promise<void>> => {
  const contents = daemonLockText(process.pid, startedAt);
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
      const existing = parseDaemonLock(
        await readFile(paths.lock, "utf8").catch(() => ""),
      )?.pid;
      if (
        existing !== undefined &&
        Number.isSafeInteger(existing) &&
        existing > 0 &&
        processIsAlive(existing)
      ) {
        throw new GuildscribeError(
          "daemon_already_running",
          "Another Guildscribe daemon is already running",
          { details: { pid: existing }, retrySafety: "never" },
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
  const daemonStartedAt = new Date();
  const releaseLock = await acquireLock(paths, daemonStartedAt);
  const client = new Client({
    intents: discordIntents(config.messageChannelIDs, config.captureAllMessageChannels),
    partials: [Partials.Message],
  });
  installSlashCommands(client, paths, config);
  const messages = new MessageLogger(
    paths.home,
    config.messageChannelIDs ?? [],
    config.captureAllMessageChannels ?? false,
    config.excludedMessageChannelIDs ?? [],
  );
  client.on(Events.MessageCreate, (message) => messages.capture(message));
  client.on(Events.MessageUpdate, (_old, message) => messages.capture(message));
  const transcription = new TranscriptionWorker(paths, config);
  const recorder = new GuildscribeRecorder({
    client,
    config,
    paths,
    onRecordingPublished: (location, manifest) =>
      transcription.enqueue(location, manifest).then(() => undefined),
  });
  let transcriptionPoll: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let runtimeState: DaemonRuntimeState["state"] = "starting";
  let discordReady = false;
  let lastError: string | null = null;

  const persistRuntimeState = async (): Promise<void> => {
    await writeDaemonRuntimeState(paths, {
      version: 1,
      pid: process.pid,
      startedAt: daemonStartedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      state: runtimeState,
      discordReady,
      lastError,
    });
  };

  const updateRuntimeState = async (
    state: DaemonRuntimeState["state"],
    ready: boolean,
    error: string | null = null,
  ): Promise<void> => {
    runtimeState = state;
    discordReady = ready;
    lastError = error;
    await persistRuntimeState();
  };

  const heartbeat = setInterval(() => {
    void persistRuntimeState().catch((error: unknown) => {
      diagnostic("error", "daemon.heartbeatFailed", {
        error: sanitizeError(error),
      });
    });
  }, DAEMON_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const shutdown = async (signal: string, exitCode: number): Promise<never> => {
    if (shuttingDown) return new Promise<never>(() => undefined);
    shuttingDown = true;
    clearInterval(heartbeat);
    if (transcriptionPoll) clearInterval(transcriptionPoll);
    diagnostic("info", "daemon.stopping", { signal });
    await updateRuntimeState("stopping", false, lastError).catch(
      (error: unknown) => {
        diagnostic("error", "daemon.heartbeatFailed", {
          error: sanitizeError(error),
        });
      },
    );
    await recorder.shutdown().catch((error: unknown) => {
      diagnostic("error", "daemon.recorderShutdownFailed", {
        error: sanitizeError(error),
      });
    });
    await transcription.shutdown().catch((error: unknown) => {
      diagnostic("error", "daemon.transcriptionShutdownFailed", {
        error: sanitizeError(error),
      });
    });
    await messages.shutdown();
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
  client.on(Events.ShardResume, () => {
    recorder.handleGatewayResume();
    if (!shuttingDown) {
      void updateRuntimeState("ready", true).catch((error: unknown) => {
        diagnostic("error", "daemon.heartbeatFailed", {
          error: sanitizeError(error),
        });
      });
    }
  });
  client.on(Events.ShardDisconnect, (event) => {
    const error = sanitizeError(
      new Error(`Discord gateway disconnected: ${event.code} ${event.reason}`),
    );
    diagnostic("warn", "discord.shardDisconnected", { error });
    if (!shuttingDown) {
      void updateRuntimeState("degraded", false, error).catch(
        (writeError: unknown) => {
          diagnostic("error", "daemon.heartbeatFailed", {
            error: sanitizeError(writeError),
          });
        },
      );
    }
  });
  client.on(Events.Error, (error) => {
    const message = sanitizeError(error, [config.discordToken]);
    diagnostic("error", "discord.clientError", { error: message });
    lastError = message;
    if (!client.isReady() && !shuttingDown) {
      runtimeState = "degraded";
      discordReady = false;
    }
    void persistRuntimeState().catch((writeError: unknown) => {
      diagnostic("error", "daemon.heartbeatFailed", {
        error: sanitizeError(writeError),
      });
    });
  });

  try {
    await persistRuntimeState();
    await migrateLegacyStorage(paths);
    await transcription.recover();
    await recoverRecordings(paths, config, (location, manifest) =>
      transcription.enqueue(location, manifest).then(() => undefined),
    );
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
    await updateRuntimeState("ready", true);
    if (config.ownerUserID) {
      try {
        await sendOwnerOnlineNotification(client, config.ownerUserID);
        diagnostic("info", "owner.onlineNotificationSent", {
          ownerUserID: config.ownerUserID,
        });
      } catch (error) {
        diagnostic("warn", "owner.onlineNotificationFailed", {
          error: sanitizeError(error, [config.discordToken]),
          ownerUserID: config.ownerUserID,
        });
      }
    }
    let polling = false;
    transcriptionPoll = setInterval(() => {
      if (polling || shuttingDown) return;
      polling = true;
      void transcription
        .pollPending()
        .catch((error) =>
          diagnostic("error", "transcription.pollFailed", {
            error: sanitizeError(error),
          }),
        )
        .finally(() => {
          polling = false;
        });
    }, 2000);
    transcriptionPoll.unref();
  } catch (error) {
    clearInterval(heartbeat);
    if (transcriptionPoll) clearInterval(transcriptionPoll);
    await updateRuntimeState(
      "degraded",
      false,
      sanitizeError(error, [config.discordToken]),
    ).catch(() => undefined);
    await transcription.shutdown().catch(() => undefined);
    await messages.shutdown();
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
