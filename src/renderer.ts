import { spawn } from "node:child_process";
import { open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { RecordingInterval, RecordingLocation } from "./recording.js";
import { intervalPCMPath } from "./recording.js";
import { GuildscribeError, sanitizeError } from "./results.js";

const PCM_RATE = 48_000;
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_FRAME_BYTES = PCM_CHANNELS * PCM_BYTES_PER_SAMPLE;
const WINDOW_FRAMES = PCM_RATE * 10;
const MAX_DIAGNOSTIC_BYTES = 64 * 1_024;

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export const runCommand = async (
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_DIAGNOSTIC_BYTES) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_DIAGNOSTIC_BYTES) stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new GuildscribeError("command_timeout", `${command} timed out`, {
          details: { command, timeoutMs },
        }),
      );
    }, timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new GuildscribeError("command_failed", `${command} failed`, {
            details: {
              command,
              exitCode: code,
              signal,
              stderr: stderr.trim().slice(0, 4_000),
            },
          }),
        );
      }
    });
  });

export const validateMP3 = async (candidate: string): Promise<number> => {
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    candidate,
  ]);
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new GuildscribeError(
      "invalid_rendered_audio",
      "ffprobe could not validate the rendered MP3",
    );
  }
  return duration;
};

const existingValidDuration = async (
  candidate: string,
): Promise<number | null> => {
  try {
    return await validateMP3(candidate);
  } catch {
    return null;
  }
};

interface PCMSource {
  path: string;
  startFrame: number;
  frameCount: number;
}

const collectSources = async (
  location: RecordingLocation,
  intervals: RecordingInterval[],
): Promise<PCMSource[]> => {
  const sources: PCMSource[] = [];
  for (const interval of intervals) {
    if (interval.kind !== "speaking") continue;
    const pcmPath = intervalPCMPath(location, interval);
    if (!pcmPath) continue;
    try {
      const info = await stat(pcmPath);
      const frameCount = Math.floor(info.size / PCM_FRAME_BYTES);
      if (frameCount > 0) {
        sources.push({
          path: pcmPath,
          startFrame: Math.max(
            0,
            Math.round((interval.startOffsetMs * PCM_RATE) / 1_000),
          ),
          frameCount,
        });
      }
    } catch {
      // Missing interval audio is represented by silence in the combined track.
    }
  }
  return sources;
};

const mixPCM = async (
  destination: string,
  durationFrames: number,
  sources: PCMSource[],
): Promise<void> => {
  const output = await open(destination, "w", 0o600);
  try {
    for (
      let windowStart = 0;
      windowStart < durationFrames;
      windowStart += WINDOW_FRAMES
    ) {
      const windowEnd = Math.min(durationFrames, windowStart + WINDOW_FRAMES);
      const frames = windowEnd - windowStart;
      const mix = new Float32Array(frames * PCM_CHANNELS);
      const overlapping = sources.filter(
        (source) =>
          source.startFrame < windowEnd &&
          source.startFrame + source.frameCount > windowStart,
      );
      for (const source of overlapping) {
        const overlapStart = Math.max(windowStart, source.startFrame);
        const overlapEnd = Math.min(
          windowEnd,
          source.startFrame + source.frameCount,
        );
        const overlapFrames = overlapEnd - overlapStart;
        const sourceByteOffset =
          (overlapStart - source.startFrame) * PCM_FRAME_BYTES;
        const bytes = Buffer.allocUnsafe(overlapFrames * PCM_FRAME_BYTES);
        const input = await open(source.path, "r");
        try {
          let bytesRead = 0;
          while (bytesRead < bytes.length) {
            const result = await input.read(
              bytes,
              bytesRead,
              bytes.length - bytesRead,
              sourceByteOffset + bytesRead,
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
          }
          const sampleCount = Math.floor(bytesRead / PCM_BYTES_PER_SAMPLE);
          const destinationSample = (overlapStart - windowStart) * PCM_CHANNELS;
          for (let index = 0; index < sampleCount; index += 1) {
            mix[destinationSample + index] =
              (mix[destinationSample + index] ?? 0) +
              bytes.readInt16LE(index * PCM_BYTES_PER_SAMPLE) / 32_768;
          }
        } finally {
          await input.close();
        }
      }
      await output.write(
        Buffer.from(mix.buffer, mix.byteOffset, mix.byteLength),
      );
    }
    await output.sync();
  } finally {
    await output.close();
  }
};

export const renderMaster = async (
  location: RecordingLocation,
  durationMs: number,
  intervals: RecordingInterval[],
): Promise<{ audioFile: string; durationSeconds: number; reused: boolean }> => {
  const finalPath = path.join(location.directory, "audio.mp3");
  const existingDuration = await existingValidDuration(finalPath);
  if (existingDuration !== null) {
    return {
      audioFile: "audio.mp3",
      durationSeconds: existingDuration,
      reused: true,
    };
  }

  const mixPath = path.join(location.directory, ".audio.mix.f32le");
  const temporaryPath = path.join(location.directory, "audio.part.mp3");
  await rm(mixPath, { force: true });
  await rm(temporaryPath, { force: true });
  const durationFrames = Math.max(
    1,
    Math.round((durationMs * PCM_RATE) / 1_000),
  );
  const sources = await collectSources(location, intervals);

  try {
    await mixPCM(mixPath, durationFrames, sources);
    await runCommand(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "f32le",
        "-ar",
        String(PCM_RATE),
        "-ac",
        String(PCM_CHANNELS),
        "-i",
        mixPath,
        "-af",
        `alimiter=limit=0.95,atrim=end_sample=${durationFrames}`,
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "192k",
        "-t",
        String(Math.max(0.1, durationMs / 1_000)),
        temporaryPath,
      ],
      Math.max(60_000, Math.ceil(durationMs / 2)),
    );
    const durationSeconds = await validateMP3(temporaryPath);
    await rename(temporaryPath, finalPath);
    return { audioFile: "audio.mp3", durationSeconds, reused: false };
  } catch (error) {
    throw new GuildscribeError("render_failed", sanitizeError(error), {
      cause: error,
      retrySafety: "safe",
    });
  } finally {
    await rm(mixPath, { force: true }).catch(() => undefined);
  }
};
