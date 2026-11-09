import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { messageBodySchema, slashCommandsSchema } from "../dist/protocol.js";
import {
  discordTransport,
  discoverCapabilities,
  registrationFor,
  sendMessage,
  handleSlashCommand,
  runSlashHook,
  syncCommands,
} from "../dist/discordActions.js";
const command = slashCommandsSchema.parse([
  {
    name: "status",
    description: "Status",
    guildID: "123456789012345678",
    executable: "/usr/bin/false",
    allowedUserIDs: ["234567890123456789"],
  },
])[0];
test("messages enforce content and aggregate embed limits", () => {
  assert.equal(messageBodySchema.safeParse({}).success, false);
  assert.equal(
    messageBodySchema.safeParse({ content: "a", unknown: true }).success,
    false,
  );
  assert.equal(
    messageBodySchema.safeParse({
      embeds: [
        { description: "a".repeat(4000) },
        { description: "b".repeat(4000) },
      ],
    }).success,
    false,
  );
  assert.equal(
    messageBodySchema.safeParse({
      embeds: [
        { title: "Status", fields: [{ name: "state", value: "ready" }] },
      ],
    }).success,
    true,
  );
});
test("dry runs need no network and do not execute hooks", async () => {
  assert.deepEqual(
    await sendMessage(
      {},
      { channelID: command.guildID, message: { content: "hello" } },
      true,
    ),
    {
      dryRun: true,
      channelID: command.guildID,
      messageID: null,
      operation: "messages.send",
      payload: { content: "hello", allowed_mentions: { parse: [] } },
    },
  );
  assert.deepEqual(await syncCommands({ slashCommands: [command] }, true), {
    dryRun: true,
    commands: [`${command.guildID}/status`],
    operation: "commands.sync",
    registrations: [
      { guildID: command.guildID, definition: registrationFor(command) },
    ],
  });
});
test("authorization and busy checks precede hook execution", async () => {
  const replies = [];
  const interaction = {
    id: "interaction",
    guildId: command.guildID,
    commandName: "status",
    channelId: command.guildID,
    user: { id: "345678901234567890" },
    reply: async (x) => replies.push(x),
  };
  await handleSlashCommand(
    interaction,
    {},
    { slashCommands: [command] },
    new Set(),
  );
  assert.match(replies[0].content, /cannot/);
  interaction.user.id = command.allowedUserIDs[0];
  await handleSlashCommand(
    interaction,
    {},
    { slashCommands: [command] },
    new Set(["busy"]),
  );
  assert.match(replies[1].content, /already running/);
});
test("hook receives JSON without credentials and enforces failure/timeout", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "guildscribe-actions-"));
  try {
    const executable = path.join(home, "hook");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const p=JSON.parse(input);console.log(JSON.stringify({content:p.event+':'+String(process.env.GUILDSCRIBE_DISCORD_TOKEN)}))});\n`,
      { mode: 0o700 },
    );
    const result = await runSlashHook(
      { home },
      { ...command, executable },
      { event: "command.invoked" },
      3000,
    );
    assert.equal(result.content, "command.invoked:undefined");
    await assert.rejects(runSlashHook({ home }, command, {}, 3000), /failed/);
    await writeFile(executable, "#!/bin/sh\nwhile :; do :; done\n", {
      mode: 0o700,
    });
    await assert.rejects(
      runSlashHook({ home }, { ...command, executable }, {}, 30),
      /timed out/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const config = { discordToken: "fabricated-secret", slashCommands: [command] };
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers });
test("send uses exact payload and disabled mentions, without retries", async () => {
  const calls = [];
  const transport = discordTransport(config, undefined, async (url, init) => {
    calls.push({ url, init });
    return json({ id: "345678901234567890" });
  });
  const result = await sendMessage(
    config,
    { channelID: command.guildID, message: { embeds: [{ title: "Ready" }] } },
    false,
    undefined,
    transport,
  );
  assert.equal(result.messageID, "345678901234567890");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bot fabricated-secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), result.payload);
});
test("transport errors expose safe status and retry data without response bodies", async () => {
  for (const status of [403, 429, 500]) {
    let calls = 0;
    const transport = discordTransport(config, undefined, async () => {
      calls++;
      return json({ message: "fabricated-secret" }, status, {
        "retry-after": "2",
      });
    });
    await assert.rejects(
      transport.request("/channels/example/messages", "POST", {}),
      (e) => {
        assert.equal(e.details.httpStatus, status);
        assert.equal(e.details.retryAfter, "2");
        assert.equal(e.details.outcomeUnknown, true);
        assert.equal(e.retrySafety, "unsafe");
        assert.equal(JSON.stringify(e).includes("fabricated-secret"), false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});
test("deadline aborts in-flight fetch and pre-aborted requests never dispatch", async () => {
  const controller = new AbortController();
  let observed = false;
  const transport = discordTransport(
    config,
    controller.signal,
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            observed = true;
            reject(init.signal.reason);
          },
          { once: true },
        );
      }),
  );
  const pending = transport.request("/channels/example/messages", "POST", {});
  controller.abort();
  await assert.rejects(
    pending,
    (e) =>
      e.code === "command_timeout" &&
      e.details.outcomeUnknown &&
      e.exitCode === 6,
  );
  assert.equal(observed, true);
  let calls = 0;
  const stopped = discordTransport(config, controller.signal, async () => {
    calls++;
    return json({});
  });
  await assert.rejects(
    stopped.request("/users/@me", "GET"),
    (e) => e.retrySafety === "safe",
  );
  assert.equal(calls, 0);
});
test("sync previews match actual registrations and stop on partial failure", async () => {
  const next = { ...command, name: "zebra" };
  const cfg = { ...config, slashCommands: [next, command] };
  const preview = await syncCommands(cfg, true);
  const calls = [];
  const transport = discordTransport(cfg, undefined, async (url, init) => {
    calls.push({ url, init });
    if (init.method === "GET") return json({ id: "345678901234567890" });
    return calls.length === 2
      ? json({ id: "456789012345678901" })
      : json({}, 429);
  });
  await assert.rejects(syncCommands(cfg, false, undefined, transport), (e) => {
    assert.deepEqual(e.details.completedCommands, [
      `${command.guildID}/status`,
    ]);
    return e.code === "discord_rate_limited";
  });
  assert.deepEqual(
    calls.slice(1).map((c) => JSON.parse(c.init.body)),
    preview.registrations.map((r) => r.definition),
  );
});
test("capability discovery is offline by default and detects registration drift", async () => {
  const local = await discoverCapabilities(
    config,
    false,
    command.guildID,
    undefined,
    {
      request: () => {
        throw Error("unexpected network");
      },
    },
  );
  assert.equal(local.channel.sendMessages, null);
  assert.equal(local.commands[0].registration, "unknown");
  for (const [remote, status] of [
    [[], "missing"],
    [[registrationFor(command)], "matching"],
    [[{ ...registrationFor(command), description: "changed" }], "different"],
  ]) {
    const result = await discoverCapabilities(
      config,
      true,
      undefined,
      undefined,
      {
        request: async (route) =>
          route.includes("oauth2") ? { id: "345678901234567890" } : remote,
      },
    );
    assert.equal(result.commands[0].registration, status);
  }
});
test("channel permissions honor overwrites and administrator bypass", async () => {
  const guildID = command.guildID,
    channelID = "345678901234567890",
    userID = "456789012345678901";
  for (const admin of [false, true]) {
    const result = await discoverCapabilities(
      { ...config, slashCommands: [] },
      true,
      channelID,
      undefined,
      {
        request: async (route) => {
          if (route.includes("oauth2")) return { id: userID };
          if (route === `/channels/${channelID}`)
            return {
              type: 0,
              guild_id: guildID,
              permission_overwrites: [
                { id: guildID, type: 0, allow: "0", deny: "16384" },
              ],
            };
          if (route === "/users/@me") return { id: userID };
          if (route.includes("/members/"))
            return { user: { id: userID }, roles: [] };
          if (route.endsWith("/roles"))
            return [{ id: guildID, permissions: admin ? "8" : "19456" }];
          throw Error(route);
        },
      },
    );
    assert.equal(result.channel.sendMessages, true);
    assert.equal(result.channel.embedLinks, admin);
  }
});
test("authorized slash invocation acknowledges first and returns rich hook response", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "guildscribe-slash-"));
  try {
    const executable = path.join(home, "hook");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const p=JSON.parse(input);console.log(JSON.stringify({content:p.options.count===3?'done':'bad',embeds:[{title:'Ready'}]}))});\n`,
      { mode: 0o700 },
    );
    const events = [],
      busy = new Set();
    const interaction = {
      id: "test",
      guildId: command.guildID,
      channelId: command.guildID,
      commandName: command.name,
      user: { id: command.allowedUserIDs[0] },
      options: { get: () => ({ value: 3 }) },
      deferred: false,
      async deferReply() {
        events.push("defer");
        this.deferred = true;
      },
      async editReply(value) {
        events.push(value);
      },
    };
    await handleSlashCommand(
      interaction,
      { home },
      {
        ...config,
        hookTimeoutMs: 3000,
        slashCommands: [
          {
            ...command,
            executable,
            options: [{ name: "count", description: "Count", type: "integer" }],
          },
        ],
      },
      busy,
    );
    assert.equal(events[0], "defer");
    assert.equal(events[1].content, "done");
    assert.deepEqual(events[1].embeds, [{ title: "Ready" }]);
    assert.deepEqual(events[1].allowedMentions, { parse: [] });
    assert.equal(busy.size, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("help options come from the executable command registrations", async () => {
  const { createProgram, commandCatalog, helpResult } =
    await import("../dist/commands.js");
  const program = createProgram();
  for (const definition of commandCatalog()) {
    let node = program;
    for (const part of definition.key.split(" "))
      node = node.commands.find((c) => c.name() === part);
    assert.deepEqual(
      definition.options.map((o) => o.flags),
      node.options.map((o) => o.flags),
    );
  }
  const help = helpResult(["messages", "send"]);
  assert.equal(
    help.definitions[0].options.find((o) => o.flags.startsWith("--request"))
      .required,
    true,
  );
});

test("registration comparison normalizes optional required flags and finds option drift", async () => {
  const entry = {
    ...command,
    options: [{ name: "subject", description: "Subject", type: "string" }],
  };
  const definition = registrationFor(entry);
  const remote = {
    ...definition,
    options: definition.options.map(({ required, ...rest }) => rest),
  };
  const transport = {
    request: async (route) =>
      route.includes("oauth2") ? { id: "345678901234567890" } : [remote],
  };
  const first = await discoverCapabilities(
    { ...config, slashCommands: [entry] },
    true,
    undefined,
    undefined,
    transport,
  );
  assert.equal(first.commands[0].registration, "matching");
  remote.options[0].type = 4;
  const second = await discoverCapabilities(
    { ...config, slashCommands: [entry] },
    true,
    undefined,
    undefined,
    transport,
  );
  assert.equal(second.commands[0].registration, "different");
});
test("sync deadline prevents later registrations after earlier success", async () => {
  const controller = new AbortController();
  let posts = 0;
  const transport = {
    request: async (_route, method) => {
      if (method === "GET") return { id: "345678901234567890" };
      posts++;
      controller.abort();
      return { id: "456789012345678901" };
    },
  };
  await assert.rejects(
    syncCommands(
      { ...config, slashCommands: [command, { ...command, name: "zebra" }] },
      false,
      controller.signal,
      transport,
    ),
    (e) =>
      e.code === "command_timeout" && e.details.completedCommands.length === 1,
  );
  assert.equal(posts, 1);
});
