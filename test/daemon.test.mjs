import assert from "node:assert/strict";
import test from "node:test";

import { sendOwnerOnlineNotification } from "../dist/daemon.js";

test("online notification DMs the configured owner without mentions", async () => {
  const calls = [];
  const client = {
    users: {
      send: async (...args) => {
        calls.push(args);
      },
    },
  };

  await sendOwnerOnlineNotification(client, "157904074535206912");

  assert.deepEqual(calls, [
    [
      "157904074535206912",
      {
        content: "Guildscribe is online.",
        allowedMentions: { parse: [] },
      },
    ],
  ]);
});
