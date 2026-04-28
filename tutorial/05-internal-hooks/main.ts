/**
 * Tutorial 05 — Internal Hook System (Event Bus)
 *
 * How OpenClaw's internal event bus works with hierarchical matching.
 *
 * Real source: src/hooks/internal-hooks.ts
 *
 * Key insight: The hook system uses TWO-LEVEL matching:
 *   - Register for "message" → receives ALL message events (received, sent, etc.)
 *   - Register for "message:received" → receives ONLY message:received events
 *
 * When triggerInternalHook fires "message:received", BOTH handlers fire:
 *   1. All handlers registered for the broad type "message"
 *   2. All handlers registered for the specific "message:received"
 *
 * Errors in one handler are caught and logged but DON'T prevent other handlers
 * from running. This is critical for plugin stability — a buggy plugin hook
 * can't crash the entire event pipeline.
 *
 * The handler registry uses Symbol.for() as a globalThis singleton key.
 * This ensures the same Map is shared even when the bundler splits this module
 * into multiple chunks — without it, handlers registered in one chunk would be
 * invisible to triggers in another chunk.
 *
 * Run: bun run tutorial/05-internal-hooks/main.ts
 */

// ── Types ────────────────────────────────────────────────────────────────────
// From src/hooks/internal-hook-types.ts

type HookEvent = {
  type: string;   // broad category: "message", "command", "session", "gateway"
  action: string; // specific action: "received", "sent", "new", "startup"
  context: Record<string, unknown>; // payload
};

type HookHandler = (event: HookEvent) => Promise<void>;

// ── Hook Registry ────────────────────────────────────────────────────────────
// From src/hooks/internal-hooks.ts:189-198
//
// Uses Symbol.for() so the Map survives bundle splitting.
// In a real app, two separate JS chunks might both import this module.
// Without the singleton, each chunk gets its own Map and hooks silently break.

const HANDLERS_KEY = Symbol.for("tutorial.internalHookHandlers");

function getHandlers(): Map<string, HookHandler[]> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[HANDLERS_KEY]) {
    g[HANDLERS_KEY] = new Map<string, HookHandler[]>();
  }
  return g[HANDLERS_KEY] as Map<string, HookHandler[]>;
}

let hooksEnabled = true;

// ── Register ─────────────────────────────────────────────────────────────────
// From src/hooks/internal-hooks.ts:220-225

function registerHook(eventKey: string, handler: HookHandler): void {
  const handlers = getHandlers();
  if (!handlers.has(eventKey)) {
    handlers.set(eventKey, []);
  }
  handlers.get(eventKey)!.push(handler);
}

// ── Unregister ───────────────────────────────────────────────────────────────
// From src/hooks/internal-hooks.ts:233-248

function unregisterHook(eventKey: string, handler: HookHandler): void {
  const handlers = getHandlers();
  const list = handlers.get(eventKey);
  if (!list) return;
  const idx = list.indexOf(handler);
  if (idx !== -1) list.splice(idx, 1);
  if (list.length === 0) handlers.delete(eventKey);
}

// ── Trigger ──────────────────────────────────────────────────────────────────
// From src/hooks/internal-hooks.ts:286-306
//
// This is the core pattern: fire BOTH broad type AND specific type:action handlers.
// Errors are isolated — one bad handler doesn't stop the rest.

async function triggerHook(event: HookEvent): Promise<void> {
  if (!hooksEnabled) return;

  const handlers = getHandlers();

  // Collect both broad ("message") and specific ("message:received") handlers
  const typeHandlers = handlers.get(event.type) ?? [];
  const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];
  const allHandlers = [...typeHandlers, ...specificHandlers];

  if (allHandlers.length === 0) return;

  for (const handler of allHandlers) {
    try {
      await handler(event);
    } catch (err) {
      // Error isolation: log but continue running other handlers
      // From src/hooks/internal-hooks.ts:301-303
      console.error(
        `  [hook error] ${event.type}:${event.action}: ${err instanceof Error ? err.message : err}`
      );
    }
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function clearHooks(): void {
  getHandlers().clear();
}

function getRegisteredKeys(): string[] {
  return Array.from(getHandlers().keys());
}

// ── Demo ─────────────────────────────────────────────────────────────────────

console.log("=== Tutorial 05: Internal Hook System ===\n");
clearHooks();

// Register hooks at different levels

// Broad: catches ALL message events
registerHook("message", async (event) => {
  console.log(`  [hook: message/*]     type=${event.type} action=${event.action}`);
});

// Specific: only catches message:received
registerHook("message:received", async (event) => {
  const ctx = event.context as { from?: string; content?: string };
  console.log(`  [hook: msg:received]  from=${ctx.from} content="${ctx.content}"`);
});

// Specific: only catches message:sent
registerHook("message:sent", async (event) => {
  const ctx = event.context as { to?: string; content?: string };
  console.log(`  [hook: msg:sent]      to=${ctx.to} content="${ctx.content}"`);
});

// A buggy hook — should NOT crash the pipeline
registerHook("message", async () => {
  throw new Error("Plugin X crashed!");
});

// Another broad hook — should still fire despite the error above
registerHook("message", async (event) => {
  console.log(`  [hook: message/*]     (post-error hook still fires!)`);
});

console.log("Registered hooks:", getRegisteredKeys().join(", "));
console.log("");

// Fire a message:received event
console.log('--- Firing "message:received" ---\n');
await triggerHook({
  type: "message",
  action: "received",
  context: { from: "user123", content: "Hello Nova!", channelId: "telegram" },
});

console.log("");

// Fire a message:sent event
console.log('--- Firing "message:sent" ---\n');
await triggerHook({
  type: "message",
  action: "sent",
  context: { to: "user123", content: "Hi there!", channelId: "telegram" },
});

console.log("");

// Fire a completely different event type — no message hooks fire
console.log('--- Firing "session:started" (no handlers) ---\n');
await triggerHook({
  type: "session",
  action: "started",
  context: { sessionId: "abc" },
});
console.log("  (silence — no hooks registered for session events)\n");

// Disable hooks globally
console.log("--- Disabling hooks globally ---\n");
hooksEnabled = false;
await triggerHook({
  type: "message",
  action: "received",
  context: { from: "user456", content: "Anyone there?" },
});
console.log("  (silence — hooks are disabled)\n");
hooksEnabled = true;

console.log("Key takeaways:");
console.log('  1. "message" handlers fire for ALL message events (received, sent, etc.)');
console.log('  2. "message:received" handlers fire ONLY for that specific action');
console.log("  3. When message:received fires, BOTH broad + specific handlers run");
console.log("  4. Errors in one handler don't stop other handlers (error isolation)");
console.log("  5. Symbol.for() singleton ensures handlers survive bundle splitting");
console.log("  6. Global enable/disable toggle for the entire hook system");
