import { verifyExecutable } from "./config.js";
import { z } from "zod";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  PermissionFlagsBits,
  PermissionsBitField,
  Routes,
  MessageFlags,
  Events,
  type APIEmbed,
  type Client,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { GuildscribeConfig, GuildscribePaths } from "./config.js";
import {
  GuildscribeError,
  diagnostic,
  messageBodySchema,
  messageSendRequestSchema,
  slashCommandsSchema,
} from "./protocol.js";

export interface DiscordTransport {
  request(
    route: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown>;
}

export const discordTransport = (
  config: GuildscribeConfig,
  signal: AbortSignal = AbortSignal.timeout(30_000),
  fetcher: typeof fetch = fetch,
): DiscordTransport => ({
  async request(route, method, body) {
    const mutation = method !== "GET";
    const details = { operation: method, route, outcomeUnknown: mutation };
    try {
      signal.throwIfAborted();
      const response = await fetcher(`https://discord.com/api/v10${route}`, {
        method,
        signal,
        headers: {
          Authorization: `Bot ${config.discordToken}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        throw new GuildscribeError(
          response.status === 429
            ? "discord_rate_limited"
            : "discord_request_failed",
          `Discord request failed with HTTP ${response.status}`,
          {
            exitCode: 5,
            retrySafety: mutation
              ? "unsafe"
              : response.status === 429 || response.status >= 500
                ? "safe"
                : "never",
            details: {
              ...details,
              httpStatus: response.status,
              retryAfter: response.headers.get("retry-after"),
            },
          },
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof GuildscribeError) throw error;
      throw new GuildscribeError(
        signal.aborted ? "command_timeout" : "discord_transport_failed",
        signal.aborted
          ? "Discord request exceeded its deadline"
          : "Discord request did not return a valid response",
        {
          exitCode: signal.aborted ? 6 : 5,
          retrySafety: mutation ? "unsafe" : "safe",
          details,
        },
      );
    }
  },
});

export const registrationFor = (
  command: z.infer<typeof slashCommandsSchema>[number],
) => ({
  name: command.name,
  description: command.description,
  type: 1,
  default_member_permissions: "0",
  options: [...command.options]
    .sort((a, b) => Number(!!b.required) - Number(!!a.required))
    .map((o) => ({
      name: o.name,
      description: o.description,
      required: o.required ?? false,
      type: {
        string: 3,
        integer: 4,
        boolean: 5,
        user: 6,
        channel: 7,
        role: 8,
        number: 10,
      }[o.type],
    })),
});
export const sendMessage = async (
  config: GuildscribeConfig,
  request: z.infer<typeof messageSendRequestSchema>,
  dryRun: boolean,
  signal?: AbortSignal,
  transport = discordTransport(config, signal),
) => {
  const parsed = messageSendRequestSchema.parse(request);
  const payload = { ...parsed.message, allowed_mentions: { parse: [] } };
  const result = {
    dryRun,
    channelID: parsed.channelID,
    messageID: null as string | null,
    operation: "messages.send" as const,
    payload,
  };
  if (dryRun) return result;
  const response = await transport.request(
    Routes.channelMessages(parsed.channelID),
    "POST",
    payload,
  );
  const decoded = z
    .object({ id: z.string().regex(/^\d{15,22}$/) })
    .safeParse(response);
  if (!decoded.success)
    throw new GuildscribeError(
      "discord_response_failed",
      "Discord returned an invalid message result",
      {
        retrySafety: "unsafe",
        details: { operation: "messages.send", outcomeUnknown: true },
      },
    );
  return { ...result, messageID: decoded.data.id };
};
export const syncCommands = async (
  config: GuildscribeConfig,
  dryRun: boolean,
  signal?: AbortSignal,
  transport = discordTransport(config, signal),
) => {
  const registrations = (config.slashCommands ?? [])
    .map((c) => ({ guildID: c.guildID, definition: registrationFor(c) }))
    .sort(
      (a, b) =>
        a.guildID.localeCompare(b.guildID) ||
        a.definition.name.localeCompare(b.definition.name),
    );
  const completed: string[] = [];
  if (!dryRun && registrations.length) {
    const app = z
      .object({ id: z.string() })
      .parse(await transport.request(Routes.oauth2CurrentApplication(), "GET"));
    for (const registration of registrations) {
      try {
        signal?.throwIfAborted();
        const response = await transport.request(
          Routes.applicationGuildCommands(app.id, registration.guildID),
          "POST",
          registration.definition,
        );
        if (
          !z.object({ id: z.string().regex(/^\d{15,22}$/) }).safeParse(response)
            .success
        )
          throw new GuildscribeError(
            "discord_response_failed",
            "Discord returned an invalid registration result",
            {
              retrySafety: "unsafe",
              details: { operation: "commands.sync", outcomeUnknown: true },
            },
          );
        completed.push(
          `${registration.guildID}/${registration.definition.name}`,
        );
      } catch (error) {
        if (error instanceof GuildscribeError)
          throw new GuildscribeError(error.code, error.message, {
            exitCode: error.exitCode,
            retrySafety: error.retrySafety,
            details: { ...error.details, completedCommands: completed },
          });
        throw new GuildscribeError(
          "command_timeout",
          "Command sync stopped at its deadline",
          {
            exitCode: 6,
            retrySafety: "unsafe",
            details: { outcomeUnknown: true, completedCommands: completed },
          },
        );
      }
    }
  }
  return {
    dryRun,
    commands: registrations.map((r) => `${r.guildID}/${r.definition.name}`),
    operation: "commands.sync" as const,
    registrations,
  };
};

export const discoverCapabilities = async (
  config: GuildscribeConfig,
  live: boolean,
  channelID?: string,
  signal?: AbortSignal,
  transport = discordTransport(config, signal),
) => {
  const commands = await Promise.all(
    (config.slashCommands ?? []).map(async (c) => {
      let executableReady = false;
      try {
        await verifyExecutable(c.executable);
        executableReady = (await stat(c.executable)).isFile();
      } catch {}
      return {
        guildID: c.guildID,
        name: c.name,
        executableReady,
        registration: "unknown" as
          | "unknown"
          | "matching"
          | "missing"
          | "different",
        allowedUserIDs: c.allowedUserIDs,
        channelIDs: c.channelIDs ?? [],
        ephemeral: c.ephemeral,
      };
    }),
  );
  let channel: {
    channelID: string;
    sendMessages: boolean | null;
    embedLinks: boolean | null;
  } | null = channelID
    ? { channelID, sendMessages: null, embedLinks: null }
    : null;
  if (live) {
    const app = z
      .object({ id: z.string() })
      .parse(await transport.request(Routes.oauth2CurrentApplication(), "GET"));
    for (const guildID of [...new Set(commands.map((c) => c.guildID))].sort()) {
      const remote = z
        .array(
          z.object({
            name: z.string(),
            type: z.number(),
            description: z.string(),
            default_member_permissions: z.string().nullable(),
            options: z.array(z.unknown()).optional(),
          }),
        )
        .parse(
          await transport.request(
            Routes.applicationGuildCommands(app.id, guildID),
            "GET",
          ),
        );
      for (const entry of commands.filter((c) => c.guildID === guildID)) {
        const match = remote.find((c) => c.name === entry.name && c.type === 1);
        const local = registrationFor(
          config.slashCommands!.find(
            (c) => c.name === entry.name && c.guildID === guildID,
          )!,
        );
        entry.registration = !match
          ? "missing"
          : match.description === local.description &&
              match.default_member_permissions ===
                local.default_member_permissions &&
              JSON.stringify(
                (match.options ?? []).map((o) => {
                  const option = z
                    .object({
                      name: z.string(),
                      description: z.string(),
                      required: z.boolean().optional(),
                      type: z.number(),
                    })
                    .strict()
                    .safeParse(o);
                  return option.success
                    ? [
                        option.data.name,
                        option.data.description,
                        option.data.type,
                        option.data.required ?? false,
                      ]
                    : null;
                }),
              ) ===
                JSON.stringify(
                  local.options.map((o) => [
                    o.name,
                    o.description,
                    o.type,
                    o.required,
                  ]),
                )
            ? "matching"
            : "different";
      }
    }
    if (channelID) {
      const data = z
        .object({
          type: z.number(),
          guild_id: z.string().optional(),
          permission_overwrites: z
            .array(
              z.object({
                id: z.string(),
                type: z.number(),
                allow: z.string(),
                deny: z.string(),
              }),
            )
            .optional(),
        })
        .parse(await transport.request(Routes.channel(channelID), "GET"));
      // Thread membership and archived/locked state need extra checks; report unknown.
      if (data.guild_id && [0, 5].includes(data.type)) {
        const self = z
          .object({ id: z.string() })
          .parse(await transport.request(Routes.user(), "GET"));
        const member = z
          .object({
            user: z.object({ id: z.string() }),
            roles: z.array(z.string()),
            communication_disabled_until: z.string().nullable().optional(),
          })
          .parse(
            await transport.request(
              Routes.guildMember(data.guild_id, self.id),
              "GET",
            ),
          );
        const roles = z
          .array(z.object({ id: z.string(), permissions: z.string() }))
          .parse(
            await transport.request(Routes.guildRoles(data.guild_id), "GET"),
          );
        let bits = roles
          .filter((r) => r.id === data.guild_id || member.roles.includes(r.id))
          .reduce((n, r) => n | BigInt(r.permissions), 0n);
        if (!(bits & PermissionFlagsBits.Administrator)) {
          const overwrites = data.permission_overwrites ?? [];
          const everyone = overwrites.find(
            (o) => o.id === data.guild_id && o.type === 0,
          );
          if (everyone)
            bits = (bits & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
          const shared = overwrites.filter(
            (o) => o.type === 0 && member.roles.includes(o.id),
          );
          bits =
            (bits & ~shared.reduce((n, o) => n | BigInt(o.deny), 0n)) |
            shared.reduce((n, o) => n | BigInt(o.allow), 0n);
          const own = overwrites.find(
            (o) => o.type === 1 && o.id === member.user.id,
          );
          if (own) bits = (bits & ~BigInt(own.deny)) | BigInt(own.allow);
        }
        const permissions = new PermissionsBitField(bits);
        const canSend =
          permissions.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
          ]) &&
          !(
            member.communication_disabled_until &&
            Date.parse(member.communication_disabled_until) > Date.now()
          );
        channel = {
          channelID,
          sendMessages: canSend,
          embedLinks:
            canSend && permissions.has(PermissionFlagsBits.EmbedLinks),
        };
      }
    }
  }
  return {
    live,
    operations: { sendMessages: true, embeds: true, slashHooks: true },
    channel,
    commands,
    limitations: [
      "Only slash commands invoke action hooks.",
      "Discord integration permissions and daemon availability must also allow execution.",
      "Thread and non-text-channel permissions are reported as unknown.",
      "Checks are a point-in-time snapshot; Discord enforces permissions when sending.",
    ],
  };
};

type SlashCommand = z.infer<typeof slashCommandsSchema>[number];
export const runSlashHook = (
  paths: GuildscribePaths,
  command: SlashCommand,
  payload: unknown,
  timeoutMs: number,
): Promise<z.infer<typeof messageBodySchema>> =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, [], {
      cwd: paths.home,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        TMPDIR: process.env.TMPDIR,
        GUILDSCRIBE_HOME: paths.home,
        GUILDSCRIBE_EVENT: "command.invoked",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (
      error?: Error,
      result?: z.infer<typeof messageBodySchema>,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve(result!);
    };
    const timer = setTimeout(
      () => finish(new Error("Hook timed out; outcome unknown")),
      Math.min(timeoutMs, 120_000),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 65_536)
        finish(new Error("Hook output exceeded limit"));
    });
    child.stderr.resume();
    child.stdin.on("error", () => finish(new Error("Hook input failed")));
    child.once("error", () => finish(new Error("Hook could not start")));
    child.once("close", (code) => {
      if (settled) return;
      try {
        if (code !== 0) throw new Error("Hook failed");
        finish(undefined, messageBodySchema.parse(JSON.parse(output)));
      } catch {
        finish(new Error("Hook failed or returned an invalid response"));
      }
    });
    child.stdin.end(JSON.stringify(payload) + "\n");
  });

export const handleSlashCommand = async (
  interaction: ChatInputCommandInteraction,
  paths: GuildscribePaths,
  config: GuildscribeConfig,
  busy: Set<string>,
) => {
  const command = config.slashCommands?.find(
    (c) =>
      c.guildID === interaction.guildId && c.name === interaction.commandName,
  );
  if (!command) return;
  if (
    !command.allowedUserIDs.includes(interaction.user.id) ||
    (command.channelIDs && !command.channelIDs.includes(interaction.channelId))
  ) {
    await interaction.reply({
      content: "You cannot run this command here.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // One hook at a time; reject concurrent calls rather than queueing stale actions.
  if (busy.size) {
    await interaction.reply({
      content: "A command is already running. Try again when it finishes.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  busy.add(interaction.id);
  try {
    await interaction.deferReply(
      command.ephemeral ? { flags: MessageFlags.Ephemeral } : {},
    );
    const options = Object.fromEntries(
      command.options.map((o) => [
        o.name,
        interaction.options.get(o.name)?.value ?? null,
      ]),
    );
    const response = await runSlashHook(
      paths,
      command,
      {
        version: 1,
        event: "command.invoked",
        interactionID: interaction.id,
        commandName: command.name,
        guildID: interaction.guildId,
        channelID: interaction.channelId,
        userID: interaction.user.id,
        options,
      },
      config.hookTimeoutMs,
    );
    await interaction.editReply({
      ...(response.content !== undefined ? { content: response.content } : {}),
      ...(response.embeds ? { embeds: response.embeds as APIEmbed[] } : {}),
      allowedMentions: { parse: [] },
    });
  } catch {
    diagnostic("warn", "command.failed", {
      commandName: command.name,
      interactionID: interaction.id,
    });
    if (interaction.deferred)
      await interaction
        .editReply({
          content:
            "Command failed or timed out. Its outcome may be unknown; check before retrying.",
          embeds: [],
          allowedMentions: { parse: [] },
        })
        .catch(() => undefined);
  } finally {
    busy.delete(interaction.id);
  }
};
export const installSlashCommands = (
  client: Client,
  paths: GuildscribePaths,
  config: GuildscribeConfig,
) => {
  const busy = new Set<string>();
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    void handleSlashCommand(interaction, paths, config, busy).catch(() =>
      diagnostic("warn", "command.responseFailed", {
        interactionID: interaction.id,
      }),
    );
  });
};
