import {
  GatewayIntentBits,
  type Message,
  type PartialMessage,
} from "discord.js";
import { z } from "zod";
import { databaseCall, databasePathFor, upsert } from "./storage.js";
import { diagnostic } from "./protocol.js";

const snowflake = z.string().regex(/^\d{15,22}$/);
export const discordIntents = (messageChannelIDs: string[] = [], captureAll = false) => [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  ...(captureAll || messageChannelIDs.length
    ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    : []),
];
const snapshotSchema = z
  .object({
    message_id: snowflake,
    guild_id: snowflake,
    channel_id: snowflake,
    parent_channel_id: snowflake.nullable(),
    channel_name: z.string().nullable(),
    author_id: snowflake,
    author_username: z.string(),
    author_display_name: z.string().nullable(),
    author_avatar_url: z.string().nullable(),
    author_is_bot: z.number().int().min(0).max(1),
    webhook_id: snowflake.nullable(),
    message_type: z.number().int(),
    content: z.string(),
    reply_to_message_id: snowflake.nullable(),
    created_at: z.number().int().nonnegative(),
    edited_at: z.number().int().nonnegative().nullable(),
    observed_at: z.number().int().nonnegative(),
    attachments_json: z.string(),
    embeds_json: z.string(),
  })
  .strict();
export const messageSnapshot = (message: Message) =>
  snapshotSchema.parse({
    message_id: message.id,
    guild_id: message.guildId,
    channel_id: message.channelId,
    parent_channel_id: message.channel.isThread()
      ? message.channel.parentId
      : null,
    channel_name: "name" in message.channel ? message.channel.name : null,
    author_id: message.author.id,
    author_username: message.author.username,
    author_display_name:
      message.member?.displayName ?? message.author.globalName ?? null,
    author_avatar_url: message.member?.displayAvatarURL?.({ extension: "png", size: 64 }) ?? message.author.displayAvatarURL?.({ extension: "png", size: 64 }) ?? null,
    author_is_bot: Number(message.author.bot),
    webhook_id: message.webhookId,
    message_type: message.type,
    content: message.content,
    reply_to_message_id: message.reference?.messageId ?? null,
    created_at: message.createdTimestamp,
    edited_at: message.editedTimestamp,
    observed_at: Date.now(),
    attachments_json: JSON.stringify(
      [...message.attachments.values()].map((a) => ({
        id: a.id,
        filename: a.name,
        description: a.description,
        contentType: a.contentType,
        size: a.size,
        url: a.url,
        proxyUrl: a.proxyURL,
        width: a.width,
        height: a.height,
        durationSeconds: a.duration,
      })),
    ),
    embeds_json: JSON.stringify(message.embeds.map((e) => e.toJSON())),
  });
export class MessageLogger {
  private queue: Promise<void> = Promise.resolve();
  private stopping = false;
  constructor(
    private readonly home: string,
    private readonly channelIDs: string[],
    private readonly captureAll = false,
    private readonly excludedIDs: string[] = [],
  ) {}
  private allowed(message: Message | PartialMessage): boolean {
    if (message.guildId === null) return false;
    const channel = message.channel;
    const parentID = "parentId" in channel ? channel.parentId : null;
    const parent = channel.isThread() ? channel.parent : null;
    // Without the parent we cannot safely evaluate category exclusions.
    if (channel.isThread() && !parent && this.excludedIDs.length) return false;
    const categoryID = parent && "parentId" in parent ? parent.parentId : null;
    if ([message.channelId, parentID, categoryID].some(
      (id) => id !== null && this.excludedIDs.includes(id),
    )) return false;
    return this.captureAll || this.channelIDs.includes(message.channelId) ||
      (channel.isThread() && parentID !== null && this.channelIDs.includes(parentID));
  }

  capture(message: Message | PartialMessage): void {
    if (this.stopping || !this.allowed(message)) return;
    // Freeze complete gateway payloads before Discord's cache can mutate them.
    let snapshot: ReturnType<typeof messageSnapshot> | null;
    try {
      snapshot = message.partial ? null : messageSnapshot(message);
    } catch {
      diagnostic("error", "messages.invalidPayload", { messageID: message.id });
      return;
    }
    this.queue = this.queue
      .then(async () => {
        if (!snapshot) {
          const full = await message.fetch();
          if (!this.allowed(full)) return;
          snapshot = messageSnapshot(full);
        }
        await databaseCall(
          databasePathFor(this.home),
          [
            upsert(
              "messages",
              snapshot,
              "message_id",
              "WHERE COALESCE(excluded.edited_at, excluded.created_at) >= COALESCE(messages.edited_at, messages.created_at) AND excluded.observed_at >= messages.observed_at",
            ),
          ],
          true,
        );
      })
      .catch(() => {
        // Payloads, URLs, and Discord tokens do not belong in operational logs.
        diagnostic("error", "messages.captureFailed", {
          messageID: message.id,
          channelID: message.channelId,
        });
      });
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.queue;
  }
  waitForIdle(): Promise<void> {
    return this.queue;
  }
}
