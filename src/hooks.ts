import { spawn } from "node:child_process";

import type { GuildscribeConfig, GuildscribePaths } from "./config.js";
import type { RecordingLocation, RecordingManifest } from "./manifests.js";
import { diagnostic, PROTOCOL_VERSION, sanitizeError } from "./results.js";

export type HookEventName =
  | "channel.joined"
  | "channel.left"
  | "recording.started"
  | "recording.completed"
  | "recording.failed"
  | "transcription.completed"
  | "transcription.failed";

const hookPathForEvent = (
  config: GuildscribeConfig,
  event: HookEventName,
): string | undefined => {
  switch (event) {
    case "channel.joined":
      return config.hooks.channelJoined;
    case "channel.left":
      return config.hooks.channelLeft;
    case "recording.started":
      return config.hooks.recordingStarted;
    case "recording.completed":
      return config.hooks.recordingCompleted;
    case "recording.failed":
      return config.hooks.recordingFailed;
    case "transcription.completed":
      return config.hooks.transcriptionCompleted;
    case "transcription.failed":
      return config.hooks.transcriptionFailed;
  }
};

export const invokeHook = async (
  paths: GuildscribePaths,
  config: GuildscribeConfig,
  event: HookEventName,
  location: RecordingLocation,
  manifest: RecordingManifest,
  details: Record<string, unknown> = {},
): Promise<void> => {
  const executable = hookPathForEvent(config, event);
  if (!executable) return;
  const payload = {
    version: 1,
    protocolVersion: PROTOCOL_VERSION,
    event,
    occurredAt: new Date().toISOString(),
    recordingID: manifest.recordingID,
    guildID: manifest.guildID,
    channelID: manifest.channelID,
    recordingDirectory: location.directory,
    manifestPath: location.manifestPath,
    status: manifest.status,
    audioFile: manifest.audioFile,
    ...details,
  };
  await new Promise<void>((resolve) => {
    const child = spawn(executable, [event], {
      cwd: location.directory,
      env: {
        GUILDSCRIBE_EVENT: event,
        GUILDSCRIBE_HOME: paths.home,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 16_384) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    let settled = false;
    const finish = (details: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      diagnostic("info", "hook.finished", {
        eventName: event,
        recordingID: manifest.recordingID,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        ...details,
      });
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, timeout: true });
    }, config.hookTimeoutMs);
    timer.unref();
    child.once("error", (error) => {
      diagnostic("warn", "hook.failed", {
        eventName: event,
        recordingID: manifest.recordingID,
        error: sanitizeError(error),
      });
      finish({ ok: false });
    });
    child.once("close", (code, signal) => {
      finish({ ok: code === 0, exitCode: code, signal });
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
};
