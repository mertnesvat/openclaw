/**
 * Tutorial 11 — TUI + Gateway Streaming & Mirroring
 *
 * How OpenClaw streams AI responses from the gateway to multiple clients
 * (TUI, web UI, channels) in real-time, with throttling, subscription
 * management, and slow-consumer protection.
 *
 * Real source:
 *   src/gateway/server-chat.ts       — ChatRunState, delta throttling, broadcasting
 *   src/gateway/server-broadcast.ts  — Broadcast-to-all with scope guards
 *   src/tui/tui-stream-assembler.ts  — Client-side delta assembly
 *   src/gateway/protocol/schema/     — Wire protocol (TypeBox schemas)
 *
 * This is the hardest part of OpenClaw's architecture. The challenge:
 *
 *   The model streams tokens one-by-one. Multiple clients (TUI, web UI,
 *   Telegram, Discord) all need to see the response in real-time. But you
 *   can't send every single token — that's thousands of tiny WebSocket
 *   messages per second. And slow clients can't be allowed to block fast ones.
 *
 * OpenClaw solves this with a 4-layer architecture:
 *
 *   Layer 1: SERVER-SIDE BUFFERING — Raw tokens accumulated into text buffers
 *   Layer 2: DELTA THROTTLING — At most one broadcast per 150ms per run
 *   Layer 3: BROADCAST + SUBSCRIPTION — Events sent to subscribed clients only
 *   Layer 4: CLIENT-SIDE ASSEMBLY — TuiStreamAssembler merges deltas into display
 *
 * Run: bun run tutorial/11-tui-gateway-streaming/main.ts
 */

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 0: WIRE PROTOCOL
// ═══════════════════════════════════════════════════════════════════════════════
//
// Real source: src/gateway/protocol/schema/frames.ts
//
// Three frame types on the WebSocket:
//   RequestFrame  → client sends RPC call:    { type:"req", id, method, params }
//   ResponseFrame → server replies:           { type:"res", id, ok, payload? }
//   EventFrame    → server pushes event:      { type:"event", event, payload, seq }
//
// Chat streaming uses EventFrames with event="chat".

type EventFrame = {
  type: "event";
  event: string;       // "chat", "agent", "session.message", "tick", etc.
  payload: unknown;
  seq?: number;        // global sequence number (gap detection)
  stateVersion?: { presence: number; health: number };
};

// Chat event payload — the heart of streaming
// Real source: src/gateway/protocol/schema/logs-chat.ts
type ChatEventPayload = {
  runId: string;        // unique per model invocation
  sessionKey: string;   // which conversation this belongs to
  seq: number;          // per-run sequence number
  state: "delta" | "final" | "aborted" | "error";
  message?: {
    role: "assistant";
    content: ContentBlock[];
    timestamp: number;
  };
  usage?: { inputTokens: number; outputTokens: number };
  stopReason?: string;
  errorMessage?: string;
  errorKind?: "refusal" | "timeout" | "rate_limit" | "context_length";
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1: SERVER-SIDE BUFFERING (ChatRunState)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Real source: src/gateway/server-chat.ts:197-234
//
// As model tokens arrive, the gateway accumulates them in buffers.
// Two buffers per run: raw (unfiltered) and display (tokens stripped of
// control sequences like NO_REPLY, HEARTBEAT_OK).

type ChatRunState = {
  rawBuffers: Map<string, string>;      // runId → raw accumulated text
  buffers: Map<string, string>;         // runId → display-safe text
  deltaSentAt: Map<string, number>;     // runId → timestamp of last broadcast
  deltaLastBroadcastLen: Map<string, number>; // runId → text length at last broadcast
};

function createChatRunState(): ChatRunState {
  return {
    rawBuffers: new Map(),
    buffers: new Map(),
    deltaSentAt: new Map(),
    deltaLastBroadcastLen: new Map(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2: DELTA THROTTLING
// ═══════════════════════════════════════════════════════════════════════════════
//
// Real source: src/gateway/server-chat.ts:725-744
//
// The key insight: model tokens arrive character-by-character, but we
// broadcast at most once per 150ms. This avoids flooding clients with
// thousands of tiny messages per second while still feeling responsive.
//
// The throttle also checks:
//   - Is the text just a silent control token? (NO_REPLY) → suppress
//   - Is the text identical to last broadcast? → skip duplicate
//   - Is this a hidden heartbeat output? → suppress

const DELTA_THROTTLE_MS = 150;

function shouldBroadcastDelta(
  runState: ChatRunState,
  runId: string,
  newText: string,
  now: number
): boolean {
  // Check 1: Is the text empty or a control token?
  if (!newText || newText === "NO_REPLY" || newText === "HEARTBEAT_OK") {
    return false;
  }

  // Check 2: Has 150ms passed since last broadcast?
  const lastSentAt = runState.deltaSentAt.get(runId) ?? 0;
  if (now - lastSentAt < DELTA_THROTTLE_MS) {
    return false;
  }

  // Check 3: Is the text identical to last broadcast?
  const lastLen = runState.deltaLastBroadcastLen.get(runId) ?? 0;
  if (newText.length === lastLen) {
    return false;
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 3: BROADCAST + SUBSCRIPTION SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
//
// Real source: src/gateway/server-broadcast.ts
//              src/gateway/server-chat.ts:242-373
//
// The gateway maintains two subscription registries:
//
// 1. SessionEventSubscriberRegistry — clients that want ALL session lifecycle events
// 2. SessionMessageSubscriberRegistry — clients subscribed to SPECIFIC session messages
//
// When a chat delta/final arrives, the gateway:
//   broadcast("chat", payload) → goes to ALL connected clients
//   nodeSendToSession(sessionKey, "chat", payload) → goes to session subscribers
//
// Each client filters by sessionKey on its side.
//
// SCOPE GUARDS: certain events require specific scopes:
//   "session.message" → READ_SCOPE
//   "exec.approval.*" → APPROVALS_SCOPE

type WsClient = {
  connId: string;
  name: string;
  bufferedBytes: number;   // how backed up this client's send buffer is
  scopes: string[];
  send: (frame: string) => void;
};

const MAX_BUFFERED_BYTES = 1024 * 1024; // 1MB

type SessionMessageSubscriberRegistry = {
  subscribe: (connId: string, sessionKey: string) => void;
  unsubscribe: (connId: string, sessionKey: string) => void;
  unsubscribeAll: (connId: string) => void;
  getSubscribers: (sessionKey: string) => ReadonlySet<string>;
};

function createSessionMessageSubscriberRegistry(): SessionMessageSubscriberRegistry {
  // Two-way index: sessionKey→connIds AND connId→sessionKeys
  // Real source: src/gateway/server-chat.ts:297-373
  const sessionToConnIds = new Map<string, Set<string>>();
  const connToSessions = new Map<string, Set<string>>();

  return {
    subscribe(connId, sessionKey) {
      // Add to session→conn mapping
      let connIds = sessionToConnIds.get(sessionKey);
      if (!connIds) { connIds = new Set(); sessionToConnIds.set(sessionKey, connIds); }
      connIds.add(connId);

      // Add to conn→session mapping (for cleanup on disconnect)
      let sessions = connToSessions.get(connId);
      if (!sessions) { sessions = new Set(); connToSessions.set(connId, sessions); }
      sessions.add(sessionKey);
    },

    unsubscribe(connId, sessionKey) {
      sessionToConnIds.get(sessionKey)?.delete(connId);
      connToSessions.get(connId)?.delete(sessionKey);
    },

    // Called when a client disconnects — clean up ALL its subscriptions
    unsubscribeAll(connId) {
      const sessions = connToSessions.get(connId);
      if (sessions) {
        for (const sessionKey of sessions) {
          sessionToConnIds.get(sessionKey)?.delete(connId);
        }
        connToSessions.delete(connId);
      }
    },

    getSubscribers(sessionKey) {
      return sessionToConnIds.get(sessionKey) ?? new Set();
    },
  };
}

// Broadcaster with slow-consumer protection
// Real source: src/gateway/server-broadcast.ts:58-132
function createBroadcaster(clients: Map<string, WsClient>) {
  let globalSeq = 0;

  return function broadcast(
    event: string,
    payload: unknown,
    opts?: { dropIfSlow?: boolean; targetConnIds?: Set<string> }
  ) {
    const frame = JSON.stringify({
      type: "event",
      event,
      payload,
      seq: opts?.targetConnIds ? undefined : ++globalSeq,
    });

    for (const client of clients.values()) {
      // Targeted: skip clients not in target set
      if (opts?.targetConnIds && !opts.targetConnIds.has(client.connId)) {
        continue;
      }

      // SLOW CONSUMER PROTECTION
      // Real source: src/gateway/server-broadcast.ts:101-117
      const isSlow = client.bufferedBytes > MAX_BUFFERED_BYTES;
      if (isSlow && opts?.dropIfSlow) {
        console.log(`    [broadcast] DROPPING event for slow client "${client.name}"`);
        continue;  // drop this event for slow clients
      }
      if (isSlow) {
        console.log(`    [broadcast] DISCONNECTING slow client "${client.name}" (buffer overflow)`);
        continue;  // in real code: client.socket.close(1008, "slow consumer")
      }

      client.send(frame);
      client.bufferedBytes += frame.length;
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 4: CLIENT-SIDE STREAM ASSEMBLY (TuiStreamAssembler)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Real source: src/tui/tui-stream-assembler.ts
//
// The client receives delta events with partial text. The assembler:
//   1. Maintains per-run state: thinking text, content text, content blocks
//   2. Separates "thinking" blocks from "content" blocks
//   3. Composes final display text from thinking + content
//   4. Returns null if the display text hasn't changed (no re-render needed)
//
// On "final" events, the assembler resolves the definitive text and cleans up.

type RunStreamState = {
  thinkingText: string;
  contentText: string;
  displayText: string;
};

class StreamAssembler {
  private runs = new Map<string, RunStreamState>();

  private getOrCreate(runId: string): RunStreamState {
    let state = this.runs.get(runId);
    if (!state) {
      state = { thinkingText: "", contentText: "", displayText: "" };
      this.runs.set(runId, state);
    }
    return state;
  }

  /**
   * Ingest a streaming delta. Returns the new display text, or null if unchanged.
   * Real source: src/tui/tui-stream-assembler.ts:163-175
   */
  ingestDelta(runId: string, message: ChatEventPayload["message"], showThinking: boolean): string | null {
    const state = this.getOrCreate(runId);
    const previousDisplay = state.displayText;

    if (!message?.content) return null;

    for (const block of message.content) {
      if (block.type === "thinking" && "thinking" in block) {
        state.thinkingText = (block as { type: "thinking"; thinking: string }).thinking;
      }
      if (block.type === "text") {
        state.contentText = block.text;
      }
    }

    // Compose display: optionally prefix thinking in a dimmed block
    state.displayText = showThinking && state.thinkingText
      ? `[thinking] ${state.thinkingText}\n\n${state.contentText}`
      : state.contentText;

    // Return null if nothing changed (skip render)
    if (state.displayText === previousDisplay) return null;
    return state.displayText;
  }

  /**
   * Finalize a run. Returns definitive text. Cleans up state.
   * Real source: src/tui/tui-stream-assembler.ts:177-205
   */
  finalize(runId: string, message: ChatEventPayload["message"], showThinking: boolean): string {
    this.ingestDelta(runId, message, showThinking);
    const state = this.runs.get(runId);
    const finalText = state?.displayText ?? "";
    this.runs.delete(runId);
    return finalText;
  }

  drop(runId: string) {
    this.runs.delete(runId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUTTING IT ALL TOGETHER: Full Simulation
// ═══════════════════════════════════════════════════════════════════════════════

async function simulate() {
  console.log("=== Tutorial 11: TUI + Gateway Streaming & Mirroring ===\n");

  // ── Setup: Gateway server ──────────────────────────────────────────
  const chatState = createChatRunState();
  const subscriptions = createSessionMessageSubscriberRegistry();
  const clients = new Map<string, WsClient>();

  const broadcast = createBroadcaster(clients);

  // Register 3 clients: TUI, Web UI, and a slow mobile client
  const tuiClient: WsClient = {
    connId: "conn-tui",
    name: "TUI (terminal)",
    bufferedBytes: 0,
    scopes: ["read", "write"],
    send: (frame) => {
      const parsed = JSON.parse(frame) as EventFrame;
      tuiEvents.push(parsed);
    },
  };

  const webClient: WsClient = {
    connId: "conn-web",
    name: "Web UI",
    bufferedBytes: 0,
    scopes: ["read"],
    send: (frame) => {
      const parsed = JSON.parse(frame) as EventFrame;
      webEvents.push(parsed);
    },
  };

  const slowClient: WsClient = {
    connId: "conn-slow",
    name: "Slow Mobile",
    bufferedBytes: MAX_BUFFERED_BYTES + 1, // already over the limit!
    scopes: ["read"],
    send: () => {}, // never actually sends
  };

  clients.set(tuiClient.connId, tuiClient);
  clients.set(webClient.connId, webClient);
  clients.set(slowClient.connId, slowClient);

  const tuiEvents: EventFrame[] = [];
  const webEvents: EventFrame[] = [];

  // Subscribe TUI and Web to the session
  const sessionKey = "nova:main:telegram:direct:mert-123";
  subscriptions.subscribe(tuiClient.connId, sessionKey);
  subscriptions.subscribe(webClient.connId, sessionKey);
  // Slow client is NOT subscribed — but broadcast goes to all

  console.log("Gateway setup:");
  console.log(`  3 clients connected: TUI, Web UI, Slow Mobile`);
  console.log(`  Session: ${sessionKey}`);
  console.log(`  TUI + Web subscribed to session messages\n`);

  // ── Simulate model streaming ───────────────────────────────────────
  console.log("--- Model Streaming Simulation ---\n");

  const runId = "run-abc123";
  const modelResponse = "The weather in London is 18°C and partly cloudy. Perfect for a walk!";
  const words = modelResponse.split(" ");

  let tokensReceived = 0;
  let broadcastCount = 0;

  console.log("  Server-side (gateway):\n");

  for (const word of words) {
    tokensReceived++;
    const accumulatedText = words.slice(0, tokensReceived).join(" ");

    // Layer 1: Buffer the token
    chatState.rawBuffers.set(runId, accumulatedText);
    chatState.buffers.set(runId, accumulatedText);

    // Layer 2: Throttle — should we broadcast?
    const now = Date.now() + tokensReceived * 30; // simulate ~30ms per token
    if (shouldBroadcastDelta(chatState, runId, accumulatedText, now)) {
      chatState.deltaSentAt.set(runId, now);
      chatState.deltaLastBroadcastLen.set(runId, accumulatedText.length);

      const payload: ChatEventPayload = {
        runId,
        sessionKey,
        seq: broadcastCount + 1,
        state: "delta",
        message: {
          role: "assistant",
          content: [{ type: "text", text: accumulatedText }],
          timestamp: now,
        },
      };

      // Layer 3: Broadcast to all clients (with slow-consumer protection)
      broadcast("chat", payload, { dropIfSlow: true });
      broadcastCount++;

      const preview = accumulatedText.length > 50
        ? accumulatedText.slice(0, 50) + "..."
        : accumulatedText;
      console.log(`    [delta #${broadcastCount}] "${preview}"`);
    }
  }

  // Send final event
  const finalPayload: ChatEventPayload = {
    runId,
    sessionKey,
    seq: broadcastCount + 1,
    state: "final",
    message: {
      role: "assistant",
      content: [{ type: "text", text: modelResponse }],
      timestamp: Date.now(),
    },
    usage: { inputTokens: 150, outputTokens: words.length },
    stopReason: "end_turn",
  };

  broadcast("chat", finalPayload);
  broadcastCount++;
  console.log(`    [final] complete response delivered`);

  console.log(`\n  Tokens received: ${tokensReceived}`);
  console.log(`  Broadcasts sent: ${broadcastCount} (${tokensReceived - broadcastCount} throttled)`);

  // ── Client-side assembly ───────────────────────────────────────────
  console.log("\n--- Client-Side Assembly (TUI) ---\n");

  const assembler = new StreamAssembler();
  let renderCount = 0;

  for (const event of tuiEvents) {
    const payload = event.payload as ChatEventPayload;
    if (payload.state === "delta") {
      const displayText = assembler.ingestDelta(runId, payload.message!, false);
      if (displayText !== null) {
        renderCount++;
        // In real TUI: chatLog.updateAssistant(displayText, runId)
        // then: tui.requestRender()
      }
    } else if (payload.state === "final") {
      const finalText = assembler.finalize(runId, payload.message!, false);
      renderCount++;
      console.log(`  Final display text: "${finalText}"`);
    }
  }

  console.log(`  TUI received ${tuiEvents.length} events, triggered ${renderCount} renders`);
  console.log(`  Web UI received ${webEvents.length} events`);

  // ── Subscription demo ──────────────────────────────────────────────
  console.log("\n--- Subscription Management ---\n");

  console.log("  Session subscribers:");
  const subs = subscriptions.getSubscribers(sessionKey);
  console.log(`    ${sessionKey}: [${Array.from(subs).join(", ")}]`);

  // Client disconnects — clean up all subscriptions
  subscriptions.unsubscribeAll(webClient.connId);
  console.log(`\n  Web client disconnected. Remaining subscribers:`);
  const subsAfter = subscriptions.getSubscribers(sessionKey);
  console.log(`    ${sessionKey}: [${Array.from(subsAfter).join(", ")}]`);

  // ── Architecture diagram ───────────────────────────────────────────
  console.log("\n--- Architecture ---\n");
  console.log("  Model API (streaming tokens)");
  console.log("       |");
  console.log("       v");
  console.log("  [Layer 1: Server Buffer]     rawBuffers + buffers (per runId)");
  console.log("       |");
  console.log("       v");
  console.log("  [Layer 2: Delta Throttle]    150ms minimum between broadcasts");
  console.log("       |");
  console.log("       v");
  console.log("  [Layer 3: Broadcast]         -> all clients (scope-gated)");
  console.log("       |           |                  |");
  console.log("       v           v                  v");
  console.log("     TUI         Web UI          Slow Client");
  console.log("       |           |               (DROPPED)");
  console.log("       v           v");
  console.log("  [Layer 4: StreamAssembler]   merge deltas -> display text");
  console.log("       |           |");
  console.log("       v           v");
  console.log("   Terminal     Browser");
  console.log("   Render       Render");

  console.log("\n--- Sequence Number Gap Detection ---\n");
  console.log("  Events carry a global `seq` number (EventFrame.seq).");
  console.log("  If a client receives seq=5 then seq=7, it knows seq=6 was lost.");
  console.log("  The client can then request a backfill or full history reload.");
  console.log("  Real source: src/gateway/client.ts (gap detection logic)");

  console.log("\nKey takeaways:");
  console.log("  1. Model tokens are BUFFERED server-side, not forwarded 1:1");
  console.log("  2. THROTTLE: at most one broadcast per 150ms per run");
  console.log(`  3. ${tokensReceived} tokens became ${broadcastCount} broadcasts (${Math.round((1 - broadcastCount / tokensReceived) * 100)}% reduction)`);
  console.log("  4. Slow clients get events DROPPED (dropIfSlow) or DISCONNECTED");
  console.log("  5. Client-side StreamAssembler skips renders when text unchanged");
  console.log("  6. Subscriptions are two-way indexed (session->conns, conn->sessions)");
  console.log("  7. Global seq numbers enable gap detection for reconnecting clients");
  console.log("  8. Same broadcast reaches TUI, Web UI, and channels simultaneously");
}

simulate().catch(console.error);
