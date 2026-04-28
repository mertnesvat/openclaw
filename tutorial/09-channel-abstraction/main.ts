/**
 * Tutorial 09 — Channel Abstraction
 *
 * How OpenClaw normalizes Telegram, Discord, Slack behind one interface.
 *
 * Real source: src/channels/plugins/types.plugin.ts
 *              src/channels/plugins/types.core.ts
 *
 * Key insight: Every messaging platform has a different API, message format,
 * and capability set. OpenClaw abstracts this behind two interfaces:
 *
 *   INBOUND:  Platform event → normalized MsgContext
 *   OUTBOUND: Agent reply → platform-specific format
 *
 * Each channel declares its CAPABILITIES (reactions, threads, buttons, voice).
 * The agent's prompt and tool schemas adapt based on what the current channel
 * supports. If you're on Telegram (no threads), the agent won't try to create
 * threads. If you're on Discord (has reactions), the agent can use reactions.
 *
 * This also enables multi-channel agents: the SAME agent can handle messages
 * from Telegram and Discord, with the channel abstraction handling the
 * translation both ways.
 *
 * Run: bun run tutorial/09-channel-abstraction/main.ts
 */

// ── Types ────────────────────────────────────────────────────────────────────
// Simplified from src/channels/plugins/types.core.ts and types.plugin.ts

type MsgContext = {
  body: string;               // normalized text content
  from: string;               // sender identifier
  to: string;                 // recipient/conversation identifier
  channelId: string;          // "telegram", "discord", "slack"
  accountId: string;          // which bot account received this
  chatType: "direct" | "group";
  timestamp: number;
  messageId: string;          // platform-specific message ID
  attachments?: Attachment[];
  metadata?: Record<string, unknown>; // platform-specific extras
};

type Attachment = {
  type: "image" | "audio" | "video" | "file";
  url: string;
  mimeType?: string;
};

type OutboundReply = {
  text: string;
  attachments?: Attachment[];
  replyToMessageId?: string;  // native reply/quote
};

// ── Channel Capabilities ─────────────────────────────────────────────────────
// Each channel declares what it supports. The agent adapts accordingly.

type ChannelCapabilities = {
  reactions: boolean;         // can react with emoji
  threads: boolean;           // can create/reply in threads
  inlineButtons: boolean;     // can show interactive buttons
  voiceMessages: boolean;     // can send/receive voice
  richFormatting: boolean;    // supports markdown/HTML
  fileUpload: boolean;        // can upload files
  maxMessageLength: number;   // platform character limit
};

// ── Channel Plugin Interface ─────────────────────────────────────────────────
// Simplified from src/channels/plugins/types.plugin.ts

interface ChannelPlugin {
  id: string;
  name: string;
  capabilities: ChannelCapabilities;

  // Normalize platform event → MsgContext
  normalizeInbound(rawEvent: unknown): MsgContext | null;

  // Format agent reply → platform-specific payload
  formatOutbound(reply: OutboundReply, context: MsgContext): unknown;

  // Send formatted message via platform API
  send(formatted: unknown): Promise<{ messageId: string }>;
}

// ── Telegram Channel ─────────────────────────────────────────────────────────

const telegramChannel: ChannelPlugin = {
  id: "telegram",
  name: "Telegram",
  capabilities: {
    reactions: true,
    threads: false,           // Telegram doesn't have threads
    inlineButtons: true,      // Telegram has inline keyboards
    voiceMessages: true,
    richFormatting: true,     // Markdown supported
    fileUpload: true,
    maxMessageLength: 4096,
  },

  normalizeInbound(rawEvent: unknown): MsgContext | null {
    // In real OpenClaw: extensions/telegram/src/monitor.ts
    const evt = rawEvent as {
      message?: {
        text?: string;
        from?: { id: number; username?: string };
        chat: { id: number; type: string };
        message_id: number;
        date: number;
      };
    };

    if (!evt.message?.text) return null;

    return {
      body: evt.message.text,
      from: String(evt.message.from?.id ?? "unknown"),
      to: String(evt.message.chat.id),
      channelId: "telegram",
      accountId: "bot-main",
      chatType: evt.message.chat.type === "private" ? "direct" : "group",
      timestamp: evt.message.date * 1000,
      messageId: String(evt.message.message_id),
    };
  },

  formatOutbound(reply: OutboundReply, context: MsgContext) {
    // Telegram API format
    return {
      method: "sendMessage",
      chat_id: context.to,
      text: reply.text,
      parse_mode: "Markdown",
      reply_to_message_id: reply.replyToMessageId,
    };
  },

  async send(formatted) {
    // Would call Telegram Bot API
    console.log(`    [telegram] Sending: ${JSON.stringify(formatted)}`);
    return { messageId: "tg-msg-" + Date.now() };
  },
};

// ── Discord Channel ──────────────────────────────────────────────────────────

const discordChannel: ChannelPlugin = {
  id: "discord",
  name: "Discord",
  capabilities: {
    reactions: true,
    threads: true,            // Discord has threads!
    inlineButtons: true,      // Discord has components (buttons, selects)
    voiceMessages: false,     // Not in text channels
    richFormatting: true,     // Markdown supported
    fileUpload: true,
    maxMessageLength: 2000,   // Discord's limit
  },

  normalizeInbound(rawEvent: unknown): MsgContext | null {
    // In real OpenClaw: extensions/discord/src/monitor/listeners.ts
    const evt = rawEvent as {
      content?: string;
      author?: { id: string; username: string };
      channel_id: string;
      id: string;
      timestamp: string;
      guild_id?: string;
    };

    if (!evt.content) return null;

    return {
      body: evt.content,
      from: evt.author?.id ?? "unknown",
      to: evt.channel_id,
      channelId: "discord",
      accountId: "bot-main",
      chatType: evt.guild_id ? "group" : "direct",
      timestamp: new Date(evt.timestamp).getTime(),
      messageId: evt.id,
      metadata: { guildId: evt.guild_id },
    };
  },

  formatOutbound(reply: OutboundReply, context: MsgContext) {
    // Discord API format
    const payload: Record<string, unknown> = {
      content: reply.text.slice(0, 2000), // enforce limit
      channel_id: context.to,
    };
    if (reply.replyToMessageId) {
      payload.message_reference = { message_id: reply.replyToMessageId };
    }
    return payload;
  },

  async send(formatted) {
    console.log(`    [discord] Sending: ${JSON.stringify(formatted)}`);
    return { messageId: "dc-msg-" + Date.now() };
  },
};

// ── Channel Registry ─────────────────────────────────────────────────────────

const channels = new Map<string, ChannelPlugin>([
  ["telegram", telegramChannel],
  ["discord", discordChannel],
]);

// ── Demo ─────────────────────────────────────────────────────────────────────

console.log("=== Tutorial 09: Channel Abstraction ===\n");

// Show capabilities comparison
console.log("Channel Capabilities:\n");
console.log(
  "  Feature          Telegram   Discord"
);
console.log(
  "  ───────────────  ─────────  ───────"
);
const caps: (keyof ChannelCapabilities)[] = [
  "reactions", "threads", "inlineButtons", "voiceMessages",
  "richFormatting", "fileUpload", "maxMessageLength",
];
for (const cap of caps) {
  const tg = String(telegramChannel.capabilities[cap]);
  const dc = String(discordChannel.capabilities[cap]);
  console.log(`  ${cap.padEnd(17)} ${tg.padEnd(11)} ${dc}`);
}

// Simulate inbound messages from different platforms
console.log("\n--- Inbound Normalization ---\n");

const telegramEvent = {
  message: {
    text: "What's the weather like?",
    from: { id: 12345, username: "mert" },
    chat: { id: 67890, type: "private" },
    message_id: 42,
    date: Math.floor(Date.now() / 1000),
  },
};

const discordEvent = {
  content: "What's the weather like?",
  author: { id: "user-abc", username: "mert" },
  channel_id: "ch-general",
  id: "msg-999",
  timestamp: new Date().toISOString(),
  guild_id: "guild-main",
};

console.log("  Raw Telegram event → MsgContext:");
const tgMsg = telegramChannel.normalizeInbound(telegramEvent)!;
console.log(`    body: "${tgMsg.body}"`);
console.log(`    from: ${tgMsg.from}, to: ${tgMsg.to}, type: ${tgMsg.chatType}`);

console.log("\n  Raw Discord event → MsgContext:");
const dcMsg = discordChannel.normalizeInbound(discordEvent)!;
console.log(`    body: "${dcMsg.body}"`);
console.log(`    from: ${dcMsg.from}, to: ${dcMsg.to}, type: ${dcMsg.chatType}`);

console.log("\n  Same normalized format! The agent sees identical MsgContext.");

// Simulate outbound reply
console.log("\n--- Outbound Formatting ---\n");

const agentReply: OutboundReply = {
  text: "It's 18C and partly cloudy in London right now.",
  replyToMessageId: tgMsg.messageId,
};

console.log("  Agent reply (platform-agnostic):");
console.log(`    text: "${agentReply.text}"\n`);

console.log("  Formatted for Telegram:");
const tgFormatted = telegramChannel.formatOutbound(agentReply, tgMsg);
console.log(`    ${JSON.stringify(tgFormatted)}\n`);

console.log("  Formatted for Discord:");
const dcFormatted = discordChannel.formatOutbound(agentReply, dcMsg);
console.log(`    ${JSON.stringify(dcFormatted)}\n`);

console.log("--- Delivery ---\n");
await telegramChannel.send(tgFormatted);
await discordChannel.send(dcFormatted);

console.log("\nKey takeaways:");
console.log("  1. INBOUND: each platform normalizes to the same MsgContext shape");
console.log("  2. OUTBOUND: agent reply is formatted per-platform before sending");
console.log("  3. Capabilities tell the agent what features are available");
console.log("  4. Same agent can handle both Telegram and Discord simultaneously");
console.log("  5. Platform limits (e.g., 2000 char Discord) are enforced at format time");
console.log("  6. The agent never sees raw platform events — only MsgContext");
