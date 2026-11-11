import { readManifest, locationForDirectory } from "../dist/recording.js";
import { VoiceConnectionStatus } from "@discordjs/voice";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import test from "node:test";

import { ChannelType, Collection } from "discord.js";
import prism from "prism-media";

import { getPaths } from "../dist/config.js";
import { GuildscribeRecorder } from "../dist/recording.js";

const USER_A = "333333333333333333";
const USER_B = "666666666666666666";
const CHANNEL_A = "111111111111111111";
const CHANNEL_B = "222222222222222222";

class FakeVoiceConnection extends EventEmitter {
  constructor(channelID) {
    super();
    this.joinConfig = { channelId: channelID };
    this.state = { status: VoiceConnectionStatus.Ready };
    this.destroyed = false;
    this.streams = new Map();
    this.receiver = {
      speaking: new EventEmitter(),
      subscribe: (userID) => {
        const stream = new PassThrough({ objectMode: true });
        this.streams.set(userID, stream);
        return stream;
      },
    };
  }

  destroy() {
    if (this.destroyed) return;
    const previous = this.state;
    this.destroyed = true;
    this.state = { status: VoiceConnectionStatus.Destroyed };
    this.emit("stateChange", previous, this.state);
  }

  rejoin(options) {
    const previous = this.state;
    this.joinConfig.channelId = options.channelId;
    this.state = { status: VoiceConnectionStatus.Ready };
    this.emit("stateChange", previous, this.state);
    return true;
  }
}

class ManualGraceClock {
  constructor() {
    this.pending = new Set();
  }

  set = (callback) => {
    const timer = { callback, unref() {} };
    this.pending.add(timer);
    return timer;
  };

  clear = (timer) => {
    this.pending.delete(timer);
  };

  fireAll() {
    const pending = [...this.pending];
    this.pending.clear();
    for (const timer of pending) timer.callback();
  }
}

const humanMember = (userID, username = "speaker") => ({
  user: { id: userID, bot: false, username },
  displayName: username,
});

const fakeChannel = (channelID, guildID = "444444444444444444") => ({
  id: channelID,
  name: `channel-${channelID}`,
  type: ChannelType.GuildVoice,
  guild: { id: guildID, name: "Test Guild", voiceAdapterCreator: {} },
  members: new Collection(),
});

const prepareHome = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "guildscribe-recorder-"));
  const paths = getPaths(home);
  await Promise.all(
    [paths.inProgress, paths.recordings, paths.logs].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  return { home, paths };
};

const createHarness = ({ channels, paths, graceClock }) => {
  const connections = [];
  const hookEvents = [];
  const client = {
    channels: {
      fetch: async (channelID) => channels.get(channelID) ?? null,
    },
  };
  const config = {
    discordToken: "not-used",
    voiceChannelIDs: [...channels.keys()],
    emptyGraceMs: 30_000,
    hookTimeoutMs: 30_000,
    hooks: {},
  };
  const recorder = new GuildscribeRecorder({
    client,
    config,
    paths,
    dependencies: {
      joinVoiceChannel: ({ channelId }) => {
        const connection = new FakeVoiceConnection(channelId);
        connections.push(connection);
        return connection;
      },
      waitForVoiceState: async (connection) => connection,
      setGraceTimeout: graceClock.set,
      clearGraceTimeout: graceClock.clear,
      invokeHook: async (_paths, _config, event, _location, manifest) => {
        hookEvents.push({ event, channelID: manifest.channelID });
      },
    },
  });
  return { connections, hookEvents, recorder };
};

const encodeOpus = async (pcm) => {
  const encoder = new prism.opus.Encoder({
    rate: 48_000,
    channels: 2,
    frameSize: 960,
  });
  const packets = [];
  encoder.on("data", (packet) => packets.push(Buffer.from(packet)));
  encoder.end(pcm);
  await finished(encoder);
  return packets;
};

const waitFor = async (condition, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await condition();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError ?? new Error("Condition timed out");
};

test("one active channel owns the recorder through grace and finalization", async () => {
  const { home, paths } = await prepareHome();
  const channelA = fakeChannel(CHANNEL_A);
  const channelB = fakeChannel(CHANNEL_B);
  channelA.members.set(USER_A, humanMember(USER_A));
  channelB.members.set("555555555555555555", humanMember("555555555555555555"));
  const channels = new Map([
    [CHANNEL_A, channelA],
    [CHANNEL_B, channelB],
  ]);
  const graceClock = new ManualGraceClock();
  const { connections, hookEvents, recorder } = createHarness({
    channels,
    paths,
    graceClock,
  });

  try {
    await recorder.initialize();
    assert.deepEqual(
      connections.map((connection) => connection.joinConfig.channelId),
      [CHANNEL_A],
    );

    await recorder.handleVoiceStateUpdate(
      { channelId: null },
      { channelId: CHANNEL_B },
    );
    assert.equal(connections.length, 1, "second occupied channel was ignored");

    channelA.members.clear();
    await recorder.handleVoiceStateUpdate(
      { channelId: CHANNEL_A },
      { channelId: null },
    );
    assert.equal(graceClock.pending.size, 1);
    assert.equal(connections[0].destroyed, false);

    channelA.members.set(USER_A, humanMember(USER_A));
    await recorder.handleVoiceStateUpdate(
      { channelId: null },
      { channelId: CHANNEL_A },
    );
    graceClock.fireAll();
    await recorder.waitForIdle();
    assert.equal(connections[0].destroyed, false, "return cancelled grace");

    channelA.members.clear();
    await recorder.handleVoiceStateUpdate(
      { channelId: CHANNEL_A },
      { channelId: null },
    );
    graceClock.fireAll();
    await recorder.waitForIdle();

    assert.deepEqual(
      connections.map((connection) => connection.joinConfig.channelId),
      [CHANNEL_A, CHANNEL_B],
    );
    assert.equal(connections[0].destroyed, true);
    assert.equal(connections[1].destroyed, false);
    assert.equal(
      connections.filter((connection) => !connection.destroyed).length,
      1,
    );
    assert.deepEqual(
      hookEvents
        .filter(({ event }) => event.startsWith("channel."))
        .map(({ event, channelID }) => `${event}:${channelID}`),
      [
        `channel.joined:${CHANNEL_A}`,
        `channel.left:${CHANNEL_A}`,
        `channel.joined:${CHANNEL_B}`,
      ],
    );
  } finally {
    await recorder.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("simultaneous Discord Opus streams produce separate PCM and a final MP3", async () => {
  const { home, paths } = await prepareHome();
  const channel = fakeChannel(CHANNEL_A);
  channel.members.set(USER_A, humanMember(USER_A));
  channel.members.set(USER_B, humanMember(USER_B, "second-speaker"));
  const channels = new Map([[CHANNEL_A, channel]]);
  const graceClock = new ManualGraceClock();
  const { connections, recorder } = createHarness({
    channels,
    paths,
    graceClock,
  });

  try {
    await recorder.initialize();
    const connection = connections[0];
    assert.ok(connection);

    connection.receiver.speaking.emit("start", USER_A);
    connection.receiver.speaking.emit("start", USER_B);
    await recorder.waitForIdle();
    const streamA = connection.streams.get(USER_A);
    const streamB = connection.streams.get(USER_B);
    assert.ok(streamA, "recorder subscribed to the first speaking user");
    assert.ok(streamB, "recorder subscribed to the second speaking user");

    const frameCount = 5;
    const pcmA = Buffer.alloc(960 * 2 * 2 * frameCount);
    const pcmB = Buffer.alloc(960 * 2 * 2 * frameCount);
    for (let sample = 0; sample < pcmA.length / 2; sample += 1) {
      pcmA.writeInt16LE(Math.round(Math.sin(sample / 10) * 10_000), sample * 2);
      pcmB.writeInt16LE(Math.round(Math.cos(sample / 17) * 8_000), sample * 2);
    }
    const [packetsA, packetsB] = await Promise.all([
      encodeOpus(pcmA),
      encodeOpus(pcmB),
    ]);
    assert.equal(packetsA.length, frameCount);
    assert.equal(packetsB.length, frameCount);
    for (let index = 0; index < frameCount; index += 1) {
      streamA.write(packetsA[index]);
      streamB.write(packetsB[index]);
    }
    streamA.end();
    streamB.end();

    const recordingID = (await readdir(paths.inProgress))[0];
    assert.ok(recordingID);
    const recordingDirectory = path.join(paths.inProgress, recordingID);
    const intervalDirectory = path.join(recordingDirectory, "intervals");
    const intervals = await waitFor(async () => {
      await recorder.waitForIdle();
      const sidecarNames = (await readdir(intervalDirectory)).filter((name) =>
        name.endsWith(".json"),
      );
      assert.equal(sidecarNames.length, 2);
      const values = await Promise.all(
        sidecarNames.map(async (name) =>
          JSON.parse(
            await readFile(path.join(intervalDirectory, name), "utf8"),
          ),
        ),
      );
      assert.ok(values.every(({ incomplete }) => incomplete === false));
      return values;
    });
    const intervalsByUser = new Map(
      intervals.map((interval) => [interval.userID, interval]),
    );
    assert.deepEqual([...intervalsByUser.keys()].sort(), [USER_A, USER_B]);
    const pcmPaths = intervals.map((interval) =>
      path.join(intervalDirectory, `${interval.intervalID}.pcm`),
    );
    const [decodedA, decodedB] = await Promise.all(
      pcmPaths.map((pcmPath) => readFile(pcmPath)),
    );
    assert.equal(decodedA.length, pcmA.length);
    assert.equal(decodedB.length, pcmB.length);
    assert.ok(decodedA.some((byte) => byte !== 0));
    assert.ok(decodedB.some((byte) => byte !== 0));
    assert.notDeepEqual(decodedA, decodedB);
    assert.ok(
      intervals.every(
        (interval) => interval.endOffsetMs - interval.startOffsetMs === 100,
      ),
    );

    const manifest = await readManifest(
      locationForDirectory(recordingDirectory),
    );
    channel.members.clear();
    await recorder.handleVoiceStateUpdate(
      { channelId: CHANNEL_A },
      { channelId: null },
    );
    graceClock.fireAll();
    await recorder.waitForIdle();

    const started = new Date(manifest.startedAt);
    const published = path.join(
      paths.recordings,
      String(started.getUTCFullYear()),
      String(started.getUTCMonth() + 1).padStart(2, "0"),
      recordingID,
    );
    const complete = await readManifest(locationForDirectory(published));
    assert.equal(complete.status, "complete");
    assert.equal(complete.channelID, CHANNEL_A);
    assert.equal(complete.channelName, `channel-${CHANNEL_A}`);
    assert.equal(complete.guildName, "Test Guild");
    assert.equal(complete.schemaVersion, 1);
    const participants = JSON.parse(
      await readFile(path.join(published, "participants.json"), "utf8"),
    );
    assert.equal(participants.participants.length, 2);
    assert.deepEqual(
      participants.participants.map(({ userID }) => userID).sort(),
      [USER_A, USER_B],
    );
    assert.ok(
      participants.participants.every(
        ({ sessions }) =>
          sessions.length === 1 && sessions[0].endOffsetMs !== null,
      ),
    );
    assert.ok((await stat(path.join(published, "audio.mp3"))).size > 0);
    const publishedPCM = await Promise.all(
      intervals.map((interval) =>
        readFile(
          path.join(published, "intervals", `${interval.intervalID}.pcm`),
        ),
      ),
    );
    assert.equal(publishedPCM[0].length, pcmA.length);
    assert.equal(publishedPCM[1].length, pcmB.length);
  } finally {
    await recorder.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test("synchronous disconnect during rejoin cannot re-enter recovery", async () => {
  const { home, paths } = await prepareHome();
  const channel = fakeChannel(CHANNEL_A);
  channel.members.set(USER_A, humanMember(USER_A));
  const { connections, recorder } = createHarness({
    channels: new Map([[CHANNEL_A, channel]]), paths, graceClock: new ManualGraceClock(),
  });
  try {
    await recorder.initialize();
    const connection = connections[0];
    let calls = 0;
    connection.rejoin = () => {
      calls++;
      if (calls > 1) throw new Error("reentrant recovery");
      const previous = connection.state;
      connection.state = { status: VoiceConnectionStatus.Disconnected };
      connection.emit("stateChange", previous, connection.state);
      connection.state = { status: VoiceConnectionStatus.Ready };
      return true;
    };
    const previous = connection.state;
    connection.state = { status: VoiceConnectionStatus.Disconnected };
    connection.emit("stateChange", previous, connection.state);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
  } finally {
    await recorder.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});
