/**
 * Tutorial 10 — Full Message Pipeline (Capstone)
 *
 * The complete message lifecycle tying all previous tutorials together.
 *
 * Real source: src/gateway/server-chat.ts (main orchestrator)
 *              src/auto-reply/ (reply dispatch)
 *              src/infra/outbound/deliver.ts (outbound delivery)
 *
 * This tutorial traces a single message from arrival to response:
 *
 *   1. Channel receives raw platform event           [Tutorial 09]
 *   2. Normalize to MsgContext                        [Tutorial 09]
 *   3. Route to the correct agent                     [Tutorial 08]
 *   4. Fire "message:received" hooks                  [Tutorial 05]
 *   5. Build system prompt from context files         [Tutorial 01]
 *   6. Call the model (simulated)
 *   7. Fire "message:sent" hooks                      [Tutorial 05]
 *   8. Format and deliver reply via originating channel [Tutorial 09]
 *
 * Special tokens:
 *   - HEARTBEAT_OK: agent acknowledges heartbeat with nothing to report
 *   - NO_REPLY: agent decides not to respond (e.g., message not for them)
 *
 * Run: bun run tutorial/10-message-pipeline/main.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Tokens ───────────────────────────────────────────────────────────────────
// From src/auto-reply/tokens.ts

const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
const SILENT_REPLY_TOKEN = "NO_REPLY";

// ── Simplified Types from Previous Tutorials ─────────────────────────────────

type MsgContext = {
  body: string;
  from: string;
  to: string;
  channelId: string;
  chatType: "direct" | "group";
  messageId: string;
};

type HookEvent = {
  type: string;
  action: string;
  context: Record<string, unknown>;
};

type HookHandler = (event: HookEvent) => Promise<void>;

type Route = {
  agentId: string;
  sessionKey: string;
  matchedBy: string;
};

// ── Minimal Hook System (from Tutorial 05) ───────────────────────────────────

const hooks = new Map<string, HookHandler[]>();

function registerHook(key: string, handler: HookHandler) {
  if (!hooks.has(key)) hooks.set(key, []);
  hooks.get(key)!.push(handler);
}

async function fireHook(event: HookEvent) {
  const typeHandlers = hooks.get(event.type) ?? [];
  const specificHandlers = hooks.get(`${event.type}:${event.action}`) ?? [];
  for (const h of [...typeHandlers, ...specificHandlers]) {
    try {
      await h(event);
    } catch (err) {
      console.log(`    [hook error] ${err}`);
    }
  }
}

// ── Minimal Router (from Tutorial 08) ────────────────────────────────────────

function resolveRoute(msg: MsgContext): Route {
  // Simple routing: all messages go to "nova" agent
  return {
    agentId: "nova",
    sessionKey: `nova:main:${msg.channelId}:${msg.chatType}:${msg.from}`,
    matchedBy: "default",
  };
}

// ── Minimal Soul Loader (from Tutorial 01) ───────────────────────────────────

const CONTEXT_FILE_ORDER = new Map([
  ["soul.md", 20], ["identity.md", 30], ["user.md", 40], ["tools.md", 50],
]);

function buildSystemPrompt(workspaceDir: string): string {
  const files = readdirSync(workspaceDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ name: f, content: readFileSync(join(workspaceDir, f), "utf-8") }))
    .sort((a, b) => {
      const aP = CONTEXT_FILE_ORDER.get(a.name.toLowerCase()) ?? 999;
      const bP = CONTEXT_FILE_ORDER.get(b.name.toLowerCase()) ?? 999;
      return aP - bP;
    });

  const sections = ["You are a helpful AI assistant.\n"];
  for (const f of files) {
    if (f.name.toLowerCase() === "soul.md") {
      sections.push("## Personality\nEmbody the following persona:\n");
    }
    sections.push(`### ${f.name}\n${f.content.trim()}\n`);
  }
  return sections.join("\n");
}

// ── Simulated Model Call ─────────────────────────────────────────────────────
// In real OpenClaw: src/gateway/server-chat.ts sends to Claude/GPT via providers

async function callModel(params: {
  systemPrompt: string;
  userMessage: string;
  isHeartbeat: boolean;
}): Promise<string> {
  // Simulate model response
  if (params.isHeartbeat) {
    return HEARTBEAT_TOKEN; // nothing needs attention
  }
  if (params.userMessage.toLowerCase().includes("ignore")) {
    return SILENT_REPLY_TOKEN; // agent chooses not to respond
  }
  return `I received your message: "${params.userMessage}". ` +
    `As Nova, I'd say the weather of your thoughts seems partly sunny today!`;
}

// ── The Pipeline ─────────────────────────────────────────────────────────────
// This is the heart of OpenClaw — the message lifecycle.

async function processMessage(rawEvent: unknown, channelId: string) {
  const step = (n: number, label: string) => console.log(`\n  Step ${n}: ${label}`);

  // ── Step 1: Normalize inbound ──────────────────────────────────────
  step(1, "Channel normalizes raw event to MsgContext");
  const msg: MsgContext = rawEvent as MsgContext; // pre-normalized for this demo
  console.log(`    channel=${msg.channelId} from=${msg.from} body="${msg.body}"`);

  // ── Step 2: Route to agent ─────────────────────────────────────────
  step(2, "Router resolves which agent handles this message");
  const route = resolveRoute(msg);
  console.log(`    agent=${route.agentId} matched=${route.matchedBy}`);
  console.log(`    session=${route.sessionKey}`);

  // ── Step 3: Fire "message:received" hooks ──────────────────────────
  step(3, 'Fire "message:received" hooks');
  await fireHook({
    type: "message",
    action: "received",
    context: { from: msg.from, content: msg.body, channelId: msg.channelId },
  });

  // ── Step 4: Build system prompt ────────────────────────────────────
  step(4, "Build system prompt from workspace context files");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const workspaceDir = resolve(__dirname, "..", "sample-workspace");
  const systemPrompt = buildSystemPrompt(workspaceDir);
  console.log(`    prompt length: ${systemPrompt.length} chars`);
  console.log(`    includes SOUL.md personality: YES`);

  // ── Step 5: Call the model ─────────────────────────────────────────
  step(5, "Send to model (system prompt + user message + tools)");
  const isHeartbeat = msg.body === "__heartbeat__";
  const modelResponse = await callModel({
    systemPrompt,
    userMessage: msg.body,
    isHeartbeat,
  });
  console.log(`    model response: "${modelResponse.slice(0, 80)}${modelResponse.length > 80 ? "..." : ""}"`);

  // ── Step 6: Check for special tokens ───────────────────────────────
  step(6, "Check for special tokens");

  if (modelResponse.trim() === HEARTBEAT_TOKEN) {
    console.log(`    HEARTBEAT_OK — agent has nothing to report. Pipeline ends.`);
    return;
  }

  if (modelResponse.trim() === SILENT_REPLY_TOKEN) {
    console.log(`    NO_REPLY — agent chose not to respond. Pipeline ends.`);
    return;
  }

  console.log(`    Normal reply — proceeding to delivery.`);

  // ── Step 7: Fire "message:sent" hooks ──────────────────────────────
  step(7, 'Fire "message:sent" hooks');
  await fireHook({
    type: "message",
    action: "sent",
    context: { to: msg.from, content: modelResponse, channelId: msg.channelId },
  });

  // ── Step 8: Deliver via originating channel ────────────────────────
  step(8, "Format and deliver reply via originating channel");
  console.log(`    channel: ${msg.channelId} (originating channel)`);
  console.log(`    to: ${msg.from}`);
  console.log(`    reply: "${modelResponse}"`);
  console.log(`    [delivered]`);
}

// ── Setup Hooks ──────────────────────────────────────────────────────────────

registerHook("message:received", async (event) => {
  const ctx = event.context as { from: string; content: string };
  console.log(`    [hook] Logging inbound from ${ctx.from}: "${ctx.content}"`);
});

registerHook("message:sent", async (event) => {
  const ctx = event.context as { to: string };
  console.log(`    [hook] Logging outbound to ${ctx.to}`);
});

registerHook("message", async (event) => {
  console.log(`    [hook] Analytics: ${event.type}:${event.action}`);
});

// ── Run the Demo ─────────────────────────────────────────────────────────────

console.log("=== Tutorial 10: Full Message Pipeline ===");
console.log("=========================================");

// Scenario 1: Normal message
console.log("\n\n--- Scenario 1: Normal User Message ---");
await processMessage(
  {
    body: "How's the weather today?",
    from: "mert-123",
    to: "nova-bot",
    channelId: "telegram",
    chatType: "direct",
    messageId: "msg-001",
  },
  "telegram"
);

// Scenario 2: Heartbeat (agent checks periodic tasks)
console.log("\n\n--- Scenario 2: Heartbeat Check ---");
await processMessage(
  {
    body: "__heartbeat__",
    from: "system",
    to: "nova-bot",
    channelId: "internal",
    chatType: "direct",
    messageId: "hb-001",
  },
  "internal"
);

// Scenario 3: Silent reply (agent decides not to respond)
console.log("\n\n--- Scenario 3: Agent Chooses Silence ---");
await processMessage(
  {
    body: "Please ignore this test message",
    from: "user-456",
    to: "nova-bot",
    channelId: "discord",
    chatType: "group",
    messageId: "msg-002",
  },
  "discord"
);

console.log("\n\n=========================================");
console.log("\nKey takeaways:");
console.log("  1. The pipeline is LINEAR: inbound -> route -> hooks -> prompt -> model -> hooks -> outbound");
console.log("  2. HEARTBEAT_OK stops the pipeline early (nothing to report)");
console.log("  3. NO_REPLY stops the pipeline early (agent chose silence)");
console.log("  4. Hooks fire at defined interception points (not arbitrary)");
console.log("  5. Reply routes back via ORIGINATING channel (not just any channel)");
console.log("  6. System prompt is rebuilt each turn with fresh context files");
console.log("  7. This is the same flow whether the message comes from Telegram, Discord, or Slack");
