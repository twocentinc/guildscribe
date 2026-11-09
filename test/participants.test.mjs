import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("participant metadata retains recording-relative presence sessions", async () => {
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
    await initializeParticipants(active.location, active.manifest.recordingID, [
      speaker,
    ]);
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
      "2026-11-05T12:03:00.000Z",
    );

    const document = await readParticipants(active.location);
    assert.equal(document.participants.length, 1);
    assert.equal(document.participants[0].sessions.length, 2);
    assert.equal(document.participants[0].sessions[1].endOffsetMs, 180_000);
    assert.deepEqual(document.participants[0].sessions[0], {
      startOffsetMs: 0,
      endOffsetMs: 60_000,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy absolute participant sessions remain readable", async () => {
  const home = await mkdtemp(
    path.join(tmpdir(), "guildscribe-participants-legacy-"),
  );
  const active = await createRecording(
    getPaths(home),
    "111111111111111111",
    "222222222222222222",
    new Date("2026-11-05T12:00:00.000Z"),
  );
  try {
    await writeFile(
      path.join(active.location.directory, "participants.json"),
      JSON.stringify({
        version: 1,
        recordingID: active.manifest.recordingID,
        updatedAt: "2026-11-05T12:02:00.000Z",
        participants: [
          {
            userID: "333333333333333333",
            username: "speaker",
            displayName: "Speaker",
            sessions: [
              {
                joinedAt: "2026-11-05T12:00:30.000Z",
                leftAt: "2026-11-05T12:01:30.000Z",
              },
            ],
            speakingDurationMs: 1_000,
          },
        ],
      }),
    );
    const document = await readParticipants(active.location);
    assert.deepEqual(document.participants[0].sessions[0], {
      startOffsetMs: 30_000,
      endOffsetMs: 90_000,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
