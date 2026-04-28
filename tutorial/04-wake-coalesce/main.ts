/**
 * Tutorial 04 — Wake Coalesce System
 *
 * How OpenClaw debounces rapid wake requests into a single heartbeat run.
 *
 * Real source: src/infra/heartbeat-wake.ts
 *
 * Key insight: Multiple things can trigger a heartbeat wake simultaneously:
 *   - The interval timer fires (every 30m)
 *   - A user action requires immediate attention
 *   - A retry from a failed previous run
 *   - A cron job completing
 *
 * Without coalescing, you'd get 4 heartbeat runs in rapid succession — wasteful
 * and potentially conflicting. The wake system debounces these into ONE run,
 * keeping the highest-priority reason.
 *
 * Priority: RETRY(0) < INTERVAL(1) < DEFAULT(2) < ACTION(3)
 * Higher priority wins when multiple wakes coalesce.
 *
 * The system also uses HANDLER GENERATIONS to prevent stale callbacks from
 * firing after the handler is replaced (e.g., during a config reload).
 *
 * Run: bun run tutorial/04-wake-coalesce/main.ts
 */

// ── Types ────────────────────────────────────────────────────────────────────

type WakeReason = "retry" | "interval" | "default" | "action";

type PendingWake = {
  reason: WakeReason;
  priority: number;
  requestedAt: number;
  agentId?: string;
};

type RunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

type WakeHandler = (opts: { reason: string; agentId?: string }) => Promise<RunResult>;

// ── Priority Map ─────────────────────────────────────────────────────────────
// From src/infra/heartbeat-wake.ts:49-54

const REASON_PRIORITY: Record<WakeReason, number> = {
  retry: 0,     // lowest — retry is tentative
  interval: 1,  // normal scheduled wake
  default: 2,   // generic/unknown trigger
  action: 3,    // highest — user/system action needs attention NOW
};

// ── Wake Coalescer ───────────────────────────────────────────────────────────

function createWakeCoalescer(opts: { coalesceMs?: number; retryMs?: number }) {
  const coalesceMs = opts.coalesceMs ?? 250;
  const retryMs = opts.retryMs ?? 1000;

  let handler: WakeHandler | null = null;
  let handlerGeneration = 0;
  const pendingWakes = new Map<string, PendingWake>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  // Log for demo purposes
  const log: string[] = [];

  function getWakeKey(agentId?: string): string {
    return agentId ?? "__global__";
  }

  // ── Request a wake ─────────────────────────────────────────────────
  // If a wake is already pending for this agent, keep the higher-priority one.
  function requestWake(reason: WakeReason, agentId?: string) {
    const key = getWakeKey(agentId);
    const priority = REASON_PRIORITY[reason];
    const existing = pendingWakes.get(key);

    if (existing && existing.priority >= priority) {
      log.push(
        `  [coalesce] ${reason}(${priority}) dropped — ` +
          `${existing.reason}(${existing.priority}) already pending`
      );
      return; // existing wake has equal or higher priority
    }

    if (existing) {
      log.push(
        `  [coalesce] ${reason}(${priority}) replaces ` +
          `${existing.reason}(${existing.priority})`
      );
    } else {
      log.push(`  [coalesce] ${reason}(${priority}) queued`);
    }

    pendingWakes.set(key, {
      reason,
      priority,
      requestedAt: Date.now(),
      agentId,
    });

    // Schedule the flush after coalesce window
    // (retry wakes use a longer minimum delay)
    const delayMs = reason === "retry" ? Math.max(coalesceMs, retryMs) : coalesceMs;
    scheduleFlush(delayMs);
  }

  function scheduleFlush(delayMs: number) {
    if (timer) return; // already scheduled
    timer = setTimeout(() => flush(), delayMs);
  }

  // ── Flush: run all pending wakes ───────────────────────────────────
  async function flush() {
    timer = null;
    if (running || !handler || pendingWakes.size === 0) return;

    running = true;
    const generation = handlerGeneration; // capture current generation

    // Drain the pending map
    const wakes = Array.from(pendingWakes.values());
    pendingWakes.clear();

    for (const wake of wakes) {
      // Generation check: if handler was replaced while we were running,
      // this callback is stale — skip it. This prevents double-processing
      // when config reloads swap the handler mid-flight.
      if (generation !== handlerGeneration) {
        log.push(`  [generation] stale handler (gen ${generation} vs ${handlerGeneration}), skipping`);
        break;
      }

      log.push(`  [run] executing heartbeat for reason="${wake.reason}"`);
      const result = await handler({ reason: wake.reason, agentId: wake.agentId });
      log.push(`  [result] ${result.status}${result.status === "ran" ? ` (${result.durationMs}ms)` : ""}`);
    }

    running = false;
  }

  // ── Set/replace handler ────────────────────────────────────────────
  // Increments generation so stale callbacks become no-ops.
  function setHandler(h: WakeHandler) {
    handler = h;
    handlerGeneration++;
    log.push(`  [handler] set (generation ${handlerGeneration})`);
  }

  return { requestWake, setHandler, flush, getLog: () => log };
}

// ── Demo ─────────────────────────────────────────────────────────────────────

console.log("=== Tutorial 04: Wake Coalesce System ===\n");

// Create a coalescer with a 100ms window (faster for demo)
const coalescer = createWakeCoalescer({ coalesceMs: 100, retryMs: 500 });

// Set up a mock heartbeat handler
coalescer.setHandler(async ({ reason }) => {
  // Simulate some work
  await new Promise((r) => setTimeout(r, 50));
  return { status: "ran", durationMs: 50 };
});

console.log("Scenario: 4 wake requests arrive within 100ms\n");

// Simulate rapid wake requests from different sources
coalescer.requestWake("interval");  // Scheduled timer fires
coalescer.requestWake("default");   // Generic trigger
coalescer.requestWake("retry");     // Retry from failed run (lower priority, dropped)
coalescer.requestWake("action");    // User action (highest priority, replaces all)

// Wait for the coalesce window to flush
await new Promise((r) => setTimeout(r, 300));
await coalescer.flush(); // ensure flushed

console.log("Event log:");
for (const line of coalescer.getLog()) {
  console.log(line);
}

console.log("\n--- Priority Table ---\n");
console.log("  Priority  Reason     When it fires");
console.log("  --------  ---------  ---------------------------");
console.log("       0    retry      After a failed heartbeat run");
console.log("       1    interval   Scheduled timer (every 30m)");
console.log("       2    default    Generic/unknown trigger");
console.log("       3    action     User action needs attention");

console.log("\nKey takeaways:");
console.log("  1. Multiple rapid wakes coalesce into ONE heartbeat run");
console.log("  2. Higher-priority reasons replace lower-priority pending wakes");
console.log("  3. Handler generations prevent stale callbacks after config reload");
console.log("  4. Retry wakes get a longer minimum delay (backoff)");
console.log("  5. The coalesce window (250ms default) debounces rapid triggers");
