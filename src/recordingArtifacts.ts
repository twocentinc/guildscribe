import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { GuildscribePaths } from "./config.js";
import {
  collectRecordingFiles,
  findRecording,
  loadIntervals,
  readManifest,
  readParticipants,
  showRecording,
} from "./recording.js";
import { validateMP3, runCommand } from "./renderer.js";
import { GuildscribeError, sanitizeError } from "./results.js";
import { readTranscriptionState } from "./transcription.js";

export interface VerificationCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  details?: Record<string, unknown>;
}

const checksum = async (candidate: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const input = createReadStream(candidate);
    input.on("error", reject);
    input.on("data", (chunk) => digest.update(chunk));
    input.on("end", () => resolve(digest.digest("hex")));
  });

const sidecarNames = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

export const verifyRecording = async (
  paths: GuildscribePaths,
  recordingID: string,
) => {
  const discovered = await findRecording(paths, recordingID);
  const checks: VerificationCheck[] = [];
  const add = (
    name: string,
    status: VerificationCheck["status"],
    message: string,
    details?: Record<string, unknown>,
  ) => checks.push(details ? { name, status, message, details } : { name, status, message });

  const manifest = await readManifest(discovered.location);
  add(
    "manifest.identity",
    manifest.recordingID === recordingID ? "pass" : "fail",
    manifest.recordingID === recordingID
      ? "Manifest identity matches its directory"
      : "Manifest recording ID does not match its directory",
  );
  add(
    "manifest.storage",
    discovered.storage === "published" && manifest.status !== "complete"
      ? "fail"
      : "pass",
    discovered.storage === "published" && manifest.status !== "complete"
      ? "Published recording is not marked complete"
      : "Manifest lifecycle agrees with its storage location",
    { status: manifest.status, storage: discovered.storage },
  );
  add(
    "manifest.names",
    manifest.guildName && manifest.channelName ? "pass" : "warn",
    manifest.guildName && manifest.channelName
      ? "Guild and channel names are present"
      : "Legacy recording does not contain guild and channel names",
  );

  const intervals = await loadIntervals(discovered.location);
  const names = await sidecarNames(discovered.location.intervalsDirectory);
  add(
    "intervals.sidecars",
    names.length === intervals.length ? "pass" : "fail",
    names.length === intervals.length
      ? "Every interval sidecar is readable"
      : "One or more interval sidecars is unreadable",
    { discovered: names.length, readable: intervals.length },
  );
  add(
    "intervals.count",
    manifest.intervalCount === intervals.length ? "pass" : "fail",
    manifest.intervalCount === intervals.length
      ? "Manifest interval count matches sidecars"
      : "Manifest interval count does not match sidecars",
    { manifest: manifest.intervalCount, sidecars: intervals.length },
  );

  for (const interval of intervals) {
    if (interval.kind === "connectionGap") {
      add(
        `interval.${interval.intervalID}`,
        interval.pcmFile === null ? "pass" : "fail",
        interval.pcmFile === null
          ? "Connection gap has no PCM payload"
          : "Connection gap unexpectedly references PCM",
      );
      continue;
    }
    const pcmPath = interval.pcmFile
      ? path.join(
          discovered.location.intervalsDirectory,
          path.basename(interval.pcmFile),
        )
      : null;
    if (!pcmPath) {
      add(
        `interval.${interval.intervalID}`,
        "fail",
        "Speaking interval has no PCM filename",
      );
      continue;
    }
    try {
      const info = await stat(pcmPath);
      const valid = info.isFile() && info.size > 0 && info.size % 4 === 0;
      const durationMs = Math.floor((info.size * 1_000) / (48_000 * 2 * 2));
      add(
        `interval.${interval.intervalID}`,
        valid ? "pass" : "fail",
        valid
          ? "PCM payload is a nonempty sequence of stereo frames"
          : "PCM payload is missing, empty, or not frame-aligned",
        { bytes: info.size, durationMs, userID: interval.userID },
      );
    } catch (error) {
      add(
        `interval.${interval.intervalID}`,
        "fail",
        "PCM payload is missing",
        { error: sanitizeError(error), userID: interval.userID },
      );
    }
  }

  if (manifest.audioFile) {
    const audioPath = path.join(
      discovered.location.directory,
      path.basename(manifest.audioFile),
    );
    try {
      const durationSeconds = await validateMP3(audioPath);
      add("audio.mp3", "pass", "FFprobe validated the combined MP3", {
        durationSeconds,
      });
    } catch (error) {
      add("audio.mp3", "fail", "Combined MP3 failed validation", {
        error: sanitizeError(error),
      });
    }
  } else {
    add(
      "audio.mp3",
      manifest.status === "complete" ? "fail" : "warn",
      "Manifest does not reference combined audio",
    );
  }

  try {
    const participants = await readParticipants(discovered.location);
    add(
      "participants",
      participants ? "pass" : "warn",
      participants
        ? "Participant presence metadata is readable"
        : "Legacy recording has no participant presence metadata",
      participants
        ? { participantCount: participants.participants.length }
        : undefined,
    );
  } catch (error) {
    add("participants", "fail", "Participant metadata is invalid", {
      error: sanitizeError(error),
    });
  }

  try {
    const transcription = await readTranscriptionState(discovered.location);
    if (!transcription) {
      add("transcription", "pass", "No transcription was requested");
    } else if (transcription.status === "complete") {
      const transcriptJSON = path.join(
        discovered.location.directory,
        "transcript.json",
      );
      const transcriptText = path.join(
        discovered.location.directory,
        "transcript.txt",
      );
      const document = JSON.parse(await readFile(transcriptJSON, "utf8")) as {
        recordingID?: unknown;
        text?: unknown;
        segments?: unknown;
      };
      await stat(transcriptText);
      const valid =
        document.recordingID === recordingID &&
        typeof document.text === "string" &&
        Array.isArray(document.segments);
      add(
        "transcription",
        valid ? "pass" : "fail",
        valid
          ? "Completed transcript artifacts are present"
          : "Canonical transcript document is invalid",
      );
    } else {
      add(
        "transcription",
        transcription.status === "failed" ? "warn" : "pass",
        `Transcription status is ${transcription.status}`,
        { attempts: transcription.attempts },
      );
    }
  } catch (error) {
    add("transcription", "fail", "Transcription state is inconsistent", {
      error: sanitizeError(error),
    });
  }

  const files = await collectRecordingFiles(discovered.location.directory);
  const checksums = [];
  for (const file of files) {
    checksums.push({
      relativePath: file.relativePath,
      bytes: file.bytes,
      sha256: await checksum(
        path.join(discovered.location.directory, file.relativePath),
      ),
    });
  }
  return {
    recordingID,
    passed: !checks.some((check) => check.status === "fail"),
    checks,
    files: checksums,
  };
};

const ensureNewDestination = async (destination: string): Promise<void> => {
  if (!path.isAbsolute(destination)) {
    throw new GuildscribeError(
      "invalid_export_destination",
      "Export destination must be an absolute path",
      { details: { destination } },
    );
  }
  try {
    await lstat(destination);
    throw new GuildscribeError(
      "export_destination_exists",
      "Export destination already exists",
      { details: { destination }, retrySafety: "unsafe" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

export const exportRecording = async (
  paths: GuildscribePaths,
  recordingID: string,
  destination: string,
  options: { dryRun: boolean; wav: boolean; timeoutMs: number },
) => {
  const discovered = await findRecording(paths, recordingID);
  const normalizedDestination = path.normalize(destination);
  await ensureNewDestination(normalizedDestination);
  const sourceWithSeparator = `${discovered.location.directory}${path.sep}`;
  if (
    normalizedDestination === discovered.location.directory ||
    normalizedDestination.startsWith(sourceWithSeparator)
  ) {
    throw new GuildscribeError(
      "invalid_export_destination",
      "Export destination cannot be inside the recording",
      { details: { destination: normalizedDestination } },
    );
  }
  const sourceFiles = (await collectRecordingFiles(discovered.location.directory))
    .filter(
      ({ relativePath }) =>
        relativePath !== ".transcription-staging" &&
        !relativePath.startsWith(`.transcription-staging${path.sep}`),
    )
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const plannedFiles = sourceFiles.map(({ relativePath }) => relativePath);
  if (options.wav) plannedFiles.push("audio.wav");
  plannedFiles.push("checksums.sha256");
  if (options.dryRun) {
    return {
      changed: false,
      dryRun: true,
      recordingID,
      destination: normalizedDestination,
      files: plannedFiles,
    };
  }

  await mkdir(normalizedDestination, { recursive: false, mode: 0o700 });
  try {
    for (const file of sourceFiles) {
      const target = path.join(normalizedDestination, file.relativePath);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(
        path.join(discovered.location.directory, file.relativePath),
        target,
      );
    }
    let wavFile: string | null = null;
    if (options.wav) {
      const audio = path.join(normalizedDestination, "audio.mp3");
      wavFile = "audio.wav";
      await runCommand(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          audio,
          "-codec:a",
          "pcm_s16le",
          path.join(normalizedDestination, wavFile),
        ],
        options.timeoutMs,
      );
    }
    const exportedFiles = await collectRecordingFiles(normalizedDestination);
    const digestLines: string[] = [];
    for (const file of exportedFiles.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    )) {
      digestLines.push(
        `${await checksum(path.join(normalizedDestination, file.relativePath))}  ${file.relativePath}`,
      );
    }
    await writeFile(
      path.join(normalizedDestination, "checksums.sha256"),
      `${digestLines.join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const summary = await showRecording(paths, recordingID);
    return {
      changed: true,
      dryRun: false,
      recordingID,
      destination: normalizedDestination,
      fileCount: digestLines.length + 1,
      sourceBytes: summary.totalBytes,
      wavFile,
      checksumsFile: "checksums.sha256",
    };
  } catch (error) {
    await rm(normalizedDestination, { recursive: true, force: true });
    throw new GuildscribeError("recording_export_failed", "Export failed", {
      details: { destination: normalizedDestination, recordingID },
      cause: error,
      retrySafety: "safe",
    });
  }
};
