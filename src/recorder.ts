import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type AudioReceiveStream,
  type VoiceConnection,
} from "@discordjs/voice";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream";

import {
  ChannelType,
  type Client,
  type VoiceChannel,
  type VoiceState,
} from "discord.js";
import prism from "prism-media";

import type { GuildscribeConfig, GuildscribePaths } from "./config.js";
import { invokeHook } from "./hooks.js";
import {
  capturedDurationMs,
  createRecording,
  listInProgress,
  loadIntervals,
  publishRecording,
  readManifest,
  saveInterval,
  saveManifest,
  type RecordingInterval,
  type RecordingLocation,
  type RecordingManifest,
} from "./manifests.js";
import { renderMaster } from "./renderer.js";
import { diagnostic, sanitizeError } from "./results.js";
import {
  finalizeParticipants,
  initializeParticipants,
  updateParticipantPresence,
  type ParticipantSnapshot,
} from "./participants.js";

const SEGMENT_SILENCE_MS = 500;
const CHECKPOINT_MS = 2_000;
const PCM_RATE = 48_000;
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SAMPLE = 2;

interface RecorderDependencies {
  joinVoiceChannel: typeof joinVoiceChannel;
  waitForVoiceState: (
    connection: VoiceConnection,
    status: VoiceConnectionStatus,
    timeoutMs: number,
  ) => Promise<VoiceConnection>;
  createDecoder: () => NodeJS.ReadWriteStream;
  setGraceTimeout: (callback: () => void, durationMs: number) => NodeJS.Timeout;
  clearGraceTimeout: (timer: NodeJS.Timeout) => void;
  invokeHook: typeof invokeHook;
}

type RecordingPublishedHandler = (
  location: RecordingLocation,
  manifest: RecordingManifest,
) => Promise<void>;

const defaultDependencies: RecorderDependencies = {
  joinVoiceChannel,
  waitForVoiceState: (connection, status, timeoutMs) =>
    entersState(connection, status, timeoutMs),
  createDecoder: () =>
    new prism.opus.Decoder({
      rate: PCM_RATE,
      channels: PCM_CHANNELS,
      frameSize: 960,
    }),
  setGraceTimeout: (callback, durationMs) => setTimeout(callback, durationMs),
  clearGraceTimeout: (timer) => clearTimeout(timer),
  invokeHook,
};

interface ActiveRecording {
  location: RecordingLocation;
  manifest: RecordingManifest;
}

interface SpeakingSegment {
  interval: RecordingInterval;
  opusStream: AudioReceiveStream;
  output: WriteStream;
  checkpoint: NodeJS.Timeout;
  filePath: string;
  pipelineEnded: Promise<NodeJS.ErrnoException | null>;
}

interface ConnectionGap {
  interval: RecordingInterval;
  checkpoint: NodeJS.Timeout;
}

const wait = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const copyInterval = (interval: RecordingInterval): RecordingInterval => ({
  ...interval,
});

export const recoverRecordings = async (
  paths: GuildscribePaths,
  config: GuildscribeConfig,
  onRecordingPublished: RecordingPublishedHandler = async () => undefined,
): Promise<void> => {
  for (const location of await listInProgress(paths)) {
    let manifest: RecordingManifest;
    try {
      manifest = await readManifest(location);
    } catch (error) {
      diagnostic("error", "recording.recoverySkipped", {
        directory: location.directory,
        error: sanitizeError(error),
      });
      continue;
    }
    try {
      if (manifest.status === "complete") {
        const published = await publishRecording(paths, location, manifest);
        void invokeHook(
          paths,
          config,
          "recording.completed",
          published,
          manifest,
        );
        await onRecordingPublished(published, manifest).catch((error) => {
          diagnostic("error", "transcription.enqueueFailed", {
            recordingID: manifest.recordingID,
            error: sanitizeError(error),
          });
        });
        continue;
      }
      const intervals = await loadIntervals(location);
      const capturedDuration = await capturedDurationMs(location, intervals);
      manifest.status = "finalizing";
      manifest.interrupted = true;
      manifest.emptySince ??= manifest.updatedAt;
      manifest.durationMs = Math.max(
        manifest.durationMs ?? 0,
        capturedDuration,
      );
      manifest.endedAt = new Date(
        Date.parse(manifest.startedAt) + manifest.durationMs,
      ).toISOString();
      manifest.intervalCount = intervals.length;
      manifest.error = null;
      await finalizeParticipants(
        location,
        manifest.recordingID,
        intervals,
        manifest.endedAt,
      );
      await saveManifest(location, manifest);
      const rendered = await renderMaster(
        location,
        manifest.durationMs,
        intervals,
      );
      manifest.status = "complete";
      manifest.audioFile = rendered.audioFile;
      await saveManifest(location, manifest);
      const published = await publishRecording(paths, location, manifest);
      diagnostic("info", "recording.recovered", {
        recordingID: manifest.recordingID,
        directory: published.directory,
      });
      void invokeHook(
        paths,
        config,
        "recording.completed",
        published,
        manifest,
      );
      await onRecordingPublished(published, manifest).catch((error) => {
        diagnostic("error", "transcription.enqueueFailed", {
          recordingID: manifest.recordingID,
          error: sanitizeError(error),
        });
      });
    } catch (error) {
      manifest.status = "failed";
      manifest.interrupted = true;
      manifest.error = sanitizeError(error, [config.discordToken]);
      await saveManifest(location, manifest).catch(() => undefined);
      diagnostic("error", "recording.recoveryFailed", {
        recordingID: manifest.recordingID,
        error: manifest.error,
      });
      void invokeHook(paths, config, "recording.failed", location, manifest);
    }
  }
};

export class GuildscribeRecorder {
  private readonly client: Client;
  private readonly config: GuildscribeConfig;
  private readonly paths: GuildscribePaths;
  private readonly dependencies: RecorderDependencies;
  private readonly onRecordingPublished: RecordingPublishedHandler;
  private recording: ActiveRecording | null = null;
  private connection: VoiceConnection | null = null;
  private connectionAnnounced = false;
  private speakingSegments = new Map<string, SpeakingSegment>();
  private connectionGap: ConnectionGap | null = null;
  private emptyTimer: NodeJS.Timeout | null = null;
  private operation: Promise<void> = Promise.resolve();
  private recovery: Promise<void> | null = null;
  private pendingWrites = new Set<Promise<void>>();
  private shuttingDown = false;

  public constructor(options: {
    client: Client;
    config: GuildscribeConfig;
    paths: GuildscribePaths;
    dependencies?: Partial<RecorderDependencies>;
    onRecordingPublished?: RecordingPublishedHandler;
  }) {
    this.client = options.client;
    this.config = options.config;
    this.paths = options.paths;
    this.dependencies = { ...defaultDependencies, ...options.dependencies };
    this.onRecordingPublished =
      options.onRecordingPublished ?? (async () => undefined);
  }

  public async initialize(): Promise<void> {
    await this.enqueue(() => this.reconcile());
  }

  public handleVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
  ): Promise<void> {
    const configured = new Set(this.config.voiceChannelIDs);
    const preferredChannelID = configured.has(newState.channelId ?? "")
      ? newState.channelId
      : configured.has(oldState.channelId ?? "")
        ? oldState.channelId
        : null;
    if (!preferredChannelID) return Promise.resolve();
    return this.enqueue(async () => {
      await this.recordParticipantTransition(oldState, newState);
      await this.reconcile(preferredChannelID);
    });
  }

  public handleGatewayResume(): Promise<void> {
    return this.enqueue(() => this.reconcile());
  }

  public waitForIdle(): Promise<void> {
    return this.operation;
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.emptyTimer) this.dependencies.clearGraceTimeout(this.emptyTimer);
    this.emptyTimer = null;
    await this.stopSpeakingSegments();
    await this.closeConnectionGap(true);
    await Promise.allSettled([...this.pendingWrites]);
    if (this.recording) {
      this.recording.manifest.interrupted = true;
      await saveManifest(
        this.recording.location,
        this.recording.manifest,
      ).catch(() => undefined);
    }
    this.destroyVoiceConnection();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.operation.then(operation, operation);
    this.operation = queued.catch((error: unknown) => {
      diagnostic("error", "recorder.operationFailed", {
        error: sanitizeError(error, [this.config.discordToken]),
      });
    });
    return queued;
  }

  private trackWrite(write: Promise<void>): void {
    this.pendingWrites.add(write);
    void write
      .catch((error: unknown) => {
        diagnostic("error", "recording.checkpointFailed", {
          error: sanitizeError(error),
        });
      })
      .finally(() => this.pendingWrites.delete(write));
  }

  private async getChannel(channelID: string): Promise<VoiceChannel> {
    const channel = await this.client.channels.fetch(channelID);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new Error(
        `Configured channel ${channelID} is not a guild voice channel`,
      );
    }
    return channel;
  }

  private async findOccupiedChannel(
    preferredChannelID?: string | null,
  ): Promise<VoiceChannel | null> {
    const orderedIDs = [
      ...(preferredChannelID ? [preferredChannelID] : []),
      ...this.config.voiceChannelIDs,
    ].filter((channelID, index, values) => values.indexOf(channelID) === index);
    for (const channelID of orderedIDs) {
      const channel = await this.getChannel(channelID);
      if (channel.members.some((member) => !member.user.bot)) return channel;
    }
    return null;
  }

  private participantSnapshot(state: VoiceState): ParticipantSnapshot | null {
    const member = state.member;
    if (!member || member.user.bot) return null;
    return {
      userID: member.user.id,
      username: member.user.username,
      displayName: member.displayName,
    };
  }

  private async recordParticipantTransition(
    oldState: VoiceState,
    newState: VoiceState,
  ): Promise<void> {
    const active = this.recording;
    if (!active) return;
    const oldParticipant = this.participantSnapshot(oldState);
    const newParticipant = this.participantSnapshot(newState);
    const channelID = active.manifest.channelID;
    const occurredAt = new Date().toISOString();
    if (
      oldParticipant &&
      oldState.channelId === channelID &&
      newState.channelId !== channelID
    ) {
      await updateParticipantPresence(
        active.location,
        active.manifest.recordingID,
        oldParticipant,
        false,
        occurredAt,
      );
    }
    if (newParticipant && newState.channelId === channelID) {
      await updateParticipantPresence(
        active.location,
        active.manifest.recordingID,
        newParticipant,
        true,
        occurredAt,
      );
    }
  }

  private async reconcile(preferredChannelID?: string | null): Promise<void> {
    if (this.shuttingDown) return;
    const channel = this.recording
      ? await this.getChannel(this.recording.manifest.channelID)
      : await this.findOccupiedChannel(preferredChannelID);
    if (!channel) {
      this.destroyVoiceConnection();
      return;
    }
    const humanCount = channel.members.filter(
      (member) => !member.user.bot,
    ).size;

    if (humanCount > 0) {
      if (this.emptyTimer) this.dependencies.clearGraceTimeout(this.emptyTimer);
      this.emptyTimer = null;
      if (this.recording?.manifest.emptySince) {
        this.recording.manifest.emptySince = null;
        await saveManifest(this.recording.location, this.recording.manifest);
      }
      if (!this.recording) {
        const created = await createRecording(
          this.paths,
          channel.guild.id,
          channel.id,
          new Date(),
          { guildName: channel.guild.name, channelName: channel.name },
        );
        await initializeParticipants(
          created.location,
          created.manifest.recordingID,
          channel.members
            .filter((member) => !member.user.bot)
            .map((member) => ({
              userID: member.user.id,
              username: member.user.username,
              displayName: member.displayName,
            })),
          created.manifest.startedAt,
        );
        this.recording = created;
        diagnostic("info", "recording.started", {
          recordingID: created.manifest.recordingID,
          channelID: channel.id,
        });
        void this.dependencies.invokeHook(
          this.paths,
          this.config,
          "recording.started",
          created.location,
          created.manifest,
        );
      }
      await this.ensureVoiceConnection(channel);
      return;
    }

    if (!this.recording) {
      this.destroyVoiceConnection();
      return;
    }
    if (this.emptyTimer) return;

    const emptySince = new Date();
    this.recording.manifest.emptySince = emptySince.toISOString();
    await saveManifest(this.recording.location, this.recording.manifest);
    this.emptyTimer = this.dependencies.setGraceTimeout(() => {
      this.emptyTimer = null;
      void this.enqueue(async () => {
        const currentChannel = await this.getChannel(channel.id);
        const currentHumans = currentChannel.members.filter(
          (member) => !member.user.bot,
        ).size;
        if (currentHumans > 0 || !this.recording) return;
        await this.finalizeRecording(emptySince);
      });
    }, this.config.emptyGraceMs);
    this.emptyTimer.unref();
  }

  private async ensureVoiceConnection(channel: VoiceChannel): Promise<void> {
    if (
      this.connection &&
      this.connection.joinConfig.channelId !== channel.id
    ) {
      this.destroyVoiceConnection();
    }
    if (
      this.connection &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      if (this.connection.state.status === VoiceConnectionStatus.Ready) {
        this.announceVoiceJoined(channel);
        return;
      }
      try {
        await this.dependencies.waitForVoiceState(
          this.connection,
          VoiceConnectionStatus.Ready,
          15_000,
        );
        this.announceVoiceJoined(channel);
        return;
      } catch {
        this.connection.rejoin({
          channelId: channel.id,
          selfDeaf: false,
          selfMute: true,
        });
        await this.dependencies.waitForVoiceState(
          this.connection,
          VoiceConnectionStatus.Ready,
          15_000,
        );
        this.announceVoiceJoined(channel);
        return;
      }
    }

    const connection = this.dependencies.joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    this.connection = connection;
    connection.receiver.speaking.on("start", (userID) => {
      void this.enqueue(() => this.startSpeakingSegment(userID));
    });
    connection.on("error", (error) => {
      diagnostic("error", "discord.voiceError", {
        error: sanitizeError(error),
      });
    });
    connection.on("stateChange", (_oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Ready) {
        void this.closeConnectionGap(false);
      } else if (newState.status === VoiceConnectionStatus.Disconnected) {
        void this.openConnectionGap("voiceDisconnected");
        this.beginRecovery(connection);
      }
    });
    await this.dependencies.waitForVoiceState(
      connection,
      VoiceConnectionStatus.Ready,
      20_000,
    );
    await this.closeConnectionGap(false);
    this.announceVoiceJoined(channel);
  }

  private announceVoiceJoined(channel: VoiceChannel): void {
    const active = this.recording;
    if (this.connectionAnnounced || !active) return;
    this.connectionAnnounced = true;
    diagnostic("info", "discord.voiceJoined", {
      channelID: channel.id,
      recordingID: active.manifest.recordingID,
    });
    void this.dependencies.invokeHook(
      this.paths,
      this.config,
      "channel.joined",
      active.location,
      active.manifest,
    );
  }

  private beginRecovery(connection: VoiceConnection): void {
    if (this.recovery || this.shuttingDown) return;
    this.recovery = (async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (
          this.shuttingDown ||
          !this.recording ||
          connection !== this.connection
        ) {
          return;
        }
        try {
          connection.rejoin({
            channelId: this.recording.manifest.channelID,
            selfDeaf: false,
            selfMute: true,
          });
          await this.dependencies.waitForVoiceState(
            connection,
            VoiceConnectionStatus.Ready,
            15_000,
          );
          await this.closeConnectionGap(false);
          return;
        } catch (error) {
          diagnostic("warn", "discord.voiceRejoinFailed", {
            attempt: attempt + 1,
            error: sanitizeError(error),
          });
          await wait(Math.min(10_000, 500 * 2 ** attempt));
        }
      }
      if (this.connection === connection) this.destroyVoiceConnection();
      else if (connection.state.status !== VoiceConnectionStatus.Destroyed)
        connection.destroy();
      await this.enqueue(() => this.reconcile());
    })().finally(() => {
      this.recovery = null;
    });
  }

  private async startSpeakingSegment(userID: string): Promise<void> {
    const active = this.recording;
    const connection = this.connection;
    if (
      !active ||
      active.manifest.status !== "recording" ||
      !connection ||
      connection.state.status !== VoiceConnectionStatus.Ready ||
      this.speakingSegments.has(userID)
    ) {
      return;
    }
    const channel = await this.getChannel(active.manifest.channelID);
    const member = channel.members.get(userID);
    if (!member || member.user.bot) return;

    const intervalID = randomUUID();
    const startedAt = Date.parse(active.manifest.startedAt);
    const startOffsetMs = Math.max(0, Date.now() - startedAt);
    const pcmFile = `${intervalID}.pcm`;
    const interval: RecordingInterval = {
      version: 1,
      intervalID,
      recordingID: active.manifest.recordingID,
      kind: "speaking",
      userID,
      username: member.user.username,
      displayName: member.displayName,
      startOffsetMs,
      endOffsetMs: startOffsetMs,
      incomplete: true,
      reason: null,
      pcmFile,
      updatedAt: new Date().toISOString(),
    };
    const filePath = path.join(active.location.intervalsDirectory, pcmFile);
    const opusStream = connection.receiver.subscribe(userID, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: SEGMENT_SILENCE_MS,
      },
    });
    const decoder = this.dependencies.createDecoder();
    const output = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
    let resolvePipeline: (error: NodeJS.ErrnoException | null) => void = () =>
      undefined;
    const pipelineEnded = new Promise<NodeJS.ErrnoException | null>(
      (resolve) => {
        resolvePipeline = resolve;
      },
    );
    const checkpoint = setInterval(() => {
      interval.endOffsetMs = Math.max(
        interval.startOffsetMs,
        Date.now() - startedAt,
      );
      this.trackWrite(saveInterval(active.location, copyInterval(interval)));
    }, CHECKPOINT_MS);
    checkpoint.unref();
    this.speakingSegments.set(userID, {
      interval,
      opusStream,
      output,
      checkpoint,
      filePath,
      pipelineEnded,
    });
    this.trackWrite(saveInterval(active.location, copyInterval(interval)));
    pipeline(opusStream, decoder, output, (error) => {
      resolvePipeline(error ?? null);
      void this.enqueue(() =>
        this.finishSpeakingSegment(userID, error ?? null),
      );
    });
  }

  private async stopSpeakingSegments(): Promise<void> {
    const segments = [...this.speakingSegments.entries()];
    for (const [, segment] of segments) {
      clearInterval(segment.checkpoint);
      segment.opusStream.destroy();
    }
    const errors = await Promise.all(
      segments.map(([, segment]) => segment.pipelineEnded),
    );
    for (const [index, [userID]] of segments.entries()) {
      await this.finishSpeakingSegment(userID, errors[index] ?? null);
    }
  }

  private async finishSpeakingSegment(
    userID: string,
    error: NodeJS.ErrnoException | null,
  ): Promise<void> {
    const segment = this.speakingSegments.get(userID);
    if (!segment) return;
    this.speakingSegments.delete(userID);
    clearInterval(segment.checkpoint);
    let bytes = 0;
    try {
      bytes = (await stat(segment.filePath)).size;
    } catch {
      // The interval remains incomplete when its PCM file cannot be read.
    }
    const audioDurationMs = Math.floor(
      (bytes * 1_000) / (PCM_RATE * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE),
    );
    segment.interval.endOffsetMs =
      segment.interval.startOffsetMs + Math.max(0, audioDurationMs);
    segment.interval.incomplete = Boolean(error);
    const active = this.recording;
    if (active) await saveInterval(active.location, segment.interval);
    if (error && !this.shuttingDown) {
      diagnostic("warn", "recording.intervalFailed", {
        intervalID: segment.interval.intervalID,
        error: sanitizeError(error),
      });
    }
  }

  private async openConnectionGap(reason: string): Promise<void> {
    const active = this.recording;
    if (!active || this.connectionGap || active.manifest.status !== "recording")
      return;
    const startedAt = Date.parse(active.manifest.startedAt);
    const startOffsetMs = Math.max(0, Date.now() - startedAt);
    const interval: RecordingInterval = {
      version: 1,
      intervalID: randomUUID(),
      recordingID: active.manifest.recordingID,
      kind: "connectionGap",
      userID: null,
      username: null,
      displayName: null,
      startOffsetMs,
      endOffsetMs: startOffsetMs,
      incomplete: true,
      reason,
      pcmFile: null,
      updatedAt: new Date().toISOString(),
    };
    const checkpoint = setInterval(() => {
      interval.endOffsetMs = Math.max(
        interval.startOffsetMs,
        Date.now() - startedAt,
      );
      this.trackWrite(saveInterval(active.location, copyInterval(interval)));
    }, CHECKPOINT_MS);
    checkpoint.unref();
    this.connectionGap = { interval, checkpoint };
    this.trackWrite(saveInterval(active.location, copyInterval(interval)));
  }

  private async closeConnectionGap(interrupted: boolean): Promise<void> {
    const gap = this.connectionGap;
    const active = this.recording;
    if (!gap || !active) return;
    this.connectionGap = null;
    clearInterval(gap.checkpoint);
    gap.interval.endOffsetMs = Math.max(
      gap.interval.startOffsetMs,
      Date.now() - Date.parse(active.manifest.startedAt),
    );
    gap.interval.incomplete = interrupted;
    await saveInterval(active.location, gap.interval);
  }

  private async finalizeRecording(endedAt: Date): Promise<void> {
    const active = this.recording;
    if (!active) return;
    if (this.emptyTimer) this.dependencies.clearGraceTimeout(this.emptyTimer);
    this.emptyTimer = null;
    active.manifest.status = "finalizing";
    active.manifest.endedAt = endedAt.toISOString();
    active.manifest.durationMs = Math.max(
      100,
      endedAt.getTime() - Date.parse(active.manifest.startedAt),
    );
    await saveManifest(active.location, active.manifest);
    this.destroyVoiceConnection();
    await this.stopSpeakingSegments();
    await this.closeConnectionGap(false);
    await Promise.allSettled([...this.pendingWrites]);

    try {
      const intervals = await loadIntervals(active.location);
      active.manifest.intervalCount = intervals.length;
      await finalizeParticipants(
        active.location,
        active.manifest.recordingID,
        intervals,
        active.manifest.endedAt,
      );
      const rendered = await renderMaster(
        active.location,
        active.manifest.durationMs,
        intervals,
      );
      active.manifest.status = "complete";
      active.manifest.audioFile = rendered.audioFile;
      active.manifest.error = null;
      await saveManifest(active.location, active.manifest);
      const published = await publishRecording(
        this.paths,
        active.location,
        active.manifest,
      );
      this.recording = null;
      diagnostic("info", "recording.completed", {
        recordingID: active.manifest.recordingID,
        directory: published.directory,
        durationMs: active.manifest.durationMs,
      });
      void this.dependencies.invokeHook(
        this.paths,
        this.config,
        "recording.completed",
        published,
        active.manifest,
      );
      await this.onRecordingPublished(published, active.manifest).catch(
        (error: unknown) => {
          diagnostic("error", "transcription.enqueueFailed", {
            recordingID: active.manifest.recordingID,
            error: sanitizeError(error),
          });
        },
      );
    } catch (error) {
      active.manifest.status = "failed";
      active.manifest.error = sanitizeError(error, [this.config.discordToken]);
      await saveManifest(active.location, active.manifest).catch(
        () => undefined,
      );
      this.recording = null;
      diagnostic("error", "recording.failed", {
        recordingID: active.manifest.recordingID,
        error: active.manifest.error,
      });
      void this.dependencies.invokeHook(
        this.paths,
        this.config,
        "recording.failed",
        active.location,
        active.manifest,
      );
    }

    if (!this.shuttingDown) await this.reconcile();
  }

  private destroyVoiceConnection(): void {
    const active = this.recording;
    const shouldAnnounce = this.connectionAnnounced && Boolean(active);
    if (
      this.connection &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      this.connection.destroy();
    }
    this.connection = null;
    this.connectionAnnounced = false;
    if (shouldAnnounce && active) {
      diagnostic("info", "discord.voiceLeft", {
        channelID: active.manifest.channelID,
        recordingID: active.manifest.recordingID,
      });
      void this.dependencies.invokeHook(
        this.paths,
        this.config,
        "channel.left",
        active.location,
        active.manifest,
      );
    }
  }
}
