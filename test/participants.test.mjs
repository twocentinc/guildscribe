import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getPaths } from "../dist/config.js";
import { createRecording } from "../dist/recording.js";
import {
  finalizeParticipants,
  initializeParticipants,
  readParticipants,
  updateParticipantPresence,
} from "../dist/recording.js";

test("participant metadata retains presence sessions and speaking duration", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "guildscribe-participants-"));
  const active = await createRecording(
    getPaths(home),
    "111111111111111111",
    "222222222222222222",
    new Date("2026-11-05T12:00:00.000Z"),
  );
  const speaker = {
    userID: "333333333333333333",
    username: "speaker",
    displayName: "Speaker",
  };
  try {
    await initializeParticipants(
      active.location,
      active.manifest.recordingID,
      [speaker],
      "2026-11-05T12:00:00.000Z",
    );
    await updateParticipantPresence(
      active.location,
      active.manifest.recordingID,
      speaker,
      false,
      "2026-11-05T12:01:00.000Z",
    );
    await updateParticipantPresence(
      active.location,
      active.manifest.recordingID,
      speaker,
      true,
      "2026-11-05T12:02:00.000Z",
    );
    await finalizeParticipants(
      active.location,
      active.manifest.recordingID,
      [
        {
          version: 1,
          intervalID: "44444444-4444-4444-8444-444444444444",
          recordingID: active.manifest.recordingID,
          kind: "speaking",
          ...speaker,
          startOffsetMs: 0,
          endOffsetMs: 1_250,
          incomplete: false,
          reason: null,
          pcmFile: "44444444-4444-4444-8444-444444444444.pcm",
          updatedAt: "2026-11-05T12:00:01.250Z",
        },
      ],
      "2026-11-05T12:03:00.000Z",
    );

    const document = await readParticipants(active.location);
    assert.equal(document.participants.length, 1);
    assert.equal(document.participants[0].sessions.length, 2);
    assert.equal(
      document.participants[0].sessions[1].leftAt,
      "2026-11-05T12:03:00.000Z",
    );
    assert.equal(document.participants[0].speakingDurationMs, 1_250);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
