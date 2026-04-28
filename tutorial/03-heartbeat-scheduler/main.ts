/**
 * Tutorial 03 — Heartbeat Scheduler (Phase-Aligned Timing)
 *
 * How OpenClaw staggers heartbeats so multiple agents don't all fire at once.
 *
 * Real source: src/infra/heartbeat-schedule.ts (entire file, 59 lines)
 *              src/infra/heartbeat-active-hours.ts
 *
 * Key insight: If 5 agents all have a 30-minute heartbeat, naive scheduling
 * would fire them all at :00 and :30 past every hour. This causes load spikes.
 *
 * OpenClaw solves this with PHASE OFFSETS: each agent gets a deterministic
 * offset derived from SHA-256(deviceSeed + agentId). Agent "alice" might fire
 * at :07 and :37, while "bob" fires at :19 and :49. Same interval, different
 * phase — spread evenly across the interval window.
 *
 * The schedule is also preserved across config reloads: if the interval and
 * phase haven't changed and the next-due time is still in the future, keep it.
 *
 * Run: bun run tutorial/03-heartbeat-scheduler/main.ts
 */

import { createHash } from "node:crypto";

// ── Phase Calculation ────────────────────────────────────────────────────────
// Exact logic from src/infra/heartbeat-schedule.ts:7-15

function resolveHeartbeatPhaseMs(params: {
  schedulerSeed: string;
  agentId: string;
  intervalMs: number;
}): number {
  const intervalMs = Math.max(1, Math.floor(params.intervalMs));
  // SHA-256 of "seed:agentId" — deterministic, uniformly distributed
  const digest = createHash("sha256")
    .update(`${params.schedulerSeed}:${params.agentId}`)
    .digest();
  // Read first 4 bytes as unsigned 32-bit integer, modulo interval
  return digest.readUInt32BE(0) % intervalMs;
}

// ── Modular Arithmetic Helper ────────────────────────────────────────────────
// JavaScript % can return negative for negative inputs. This normalizes it.
// From src/infra/heartbeat-schedule.ts:3-5

function normalizeModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

// ── Next Due Time ────────────────────────────────────────────────────────────
// Given current time and phase offset, when should the next heartbeat fire?
// From src/infra/heartbeat-schedule.ts:17-31

function computeNextHeartbeatPhaseDueMs(params: {
  nowMs: number;
  intervalMs: number;
  phaseMs: number;
}): number {
  const intervalMs = Math.max(1, Math.floor(params.intervalMs));
  const nowMs = Math.floor(params.nowMs);
  const phaseMs = normalizeModulo(Math.floor(params.phaseMs), intervalMs);

  // Where are we within the current interval cycle?
  const cyclePositionMs = normalizeModulo(nowMs, intervalMs);

  // How far until the next phase-aligned fire time?
  let deltaMs = normalizeModulo(phaseMs - cyclePositionMs, intervalMs);
  if (deltaMs === 0) {
    deltaMs = intervalMs; // exactly on phase = schedule for next cycle
  }

  return nowMs + deltaMs;
}

// ── Schedule Preservation ────────────────────────────────────────────────────
// If config hasn't changed and next-due is still in the future, keep it.
// From src/infra/heartbeat-schedule.ts:33-59

function resolveNextHeartbeatDueMs(params: {
  nowMs: number;
  intervalMs: number;
  phaseMs: number;
  prev?: { intervalMs: number; phaseMs: number; nextDueMs: number };
}): number {
  const intervalMs = Math.max(1, Math.floor(params.intervalMs));
  const phaseMs = normalizeModulo(Math.floor(params.phaseMs), intervalMs);
  const prev = params.prev;

  // Preserve existing schedule if config unchanged and still in the future
  if (
    prev &&
    prev.intervalMs === intervalMs &&
    prev.phaseMs === phaseMs &&
    prev.nextDueMs > params.nowMs
  ) {
    return prev.nextDueMs;
  }

  // Otherwise, compute fresh
  return computeNextHeartbeatPhaseDueMs({
    nowMs: params.nowMs,
    intervalMs,
    phaseMs,
  });
}

// ── Active Hours Check ───────────────────────────────────────────────────────
// Simplified from src/infra/heartbeat-active-hours.ts
// Uses Intl.DateTimeFormat for timezone-aware hour checking

function isWithinActiveHours(params: {
  nowMs: number;
  timezone: string;
  activeStart: number; // hour (0-23)
  activeEnd: number;   // hour (0-23)
}): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: params.timezone,
    hour: "numeric",
    hour12: false,
  });
  const currentHour = parseInt(formatter.format(new Date(params.nowMs)), 10);

  if (params.activeStart <= params.activeEnd) {
    // Simple range: e.g., 9-18
    return currentHour >= params.activeStart && currentHour < params.activeEnd;
  } else {
    // Wrapping range: e.g., 22-6 (night shift)
    return currentHour >= params.activeStart || currentHour < params.activeEnd;
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

console.log("=== Tutorial 03: Heartbeat Scheduler ===\n");

const THIRTY_MINUTES = 30 * 60 * 1000;
const deviceSeed = "device-abc123"; // unique per installation
const agents = ["alice", "bob", "charlie", "diana", "eve"];
const now = Date.now();

console.log(`Interval: 30 minutes`);
console.log(`Device seed: "${deviceSeed}"`);
console.log(`Current time: ${new Date(now).toISOString()}\n`);

console.log("Agent phase offsets (staggered fire times):\n");

for (const agentId of agents) {
  const phaseMs = resolveHeartbeatPhaseMs({
    schedulerSeed: deviceSeed,
    agentId,
    intervalMs: THIRTY_MINUTES,
  });

  const nextDue = computeNextHeartbeatPhaseDueMs({
    nowMs: now,
    intervalMs: THIRTY_MINUTES,
    phaseMs,
  });

  const phaseMinutes = (phaseMs / 60_000).toFixed(1);
  const dueIn = ((nextDue - now) / 60_000).toFixed(1);

  console.log(
    `  ${agentId.padEnd(10)} phase: ${phaseMinutes.padStart(5)}m   ` +
      `next fire: ${new Date(nextDue).toISOString()} (in ${dueIn}m)`
  );
}

// Show schedule preservation
console.log("\n--- Schedule Preservation Demo ---\n");

const alicePhase = resolveHeartbeatPhaseMs({
  schedulerSeed: deviceSeed,
  agentId: "alice",
  intervalMs: THIRTY_MINUTES,
});

const firstDue = resolveNextHeartbeatDueMs({
  nowMs: now,
  intervalMs: THIRTY_MINUTES,
  phaseMs: alicePhase,
});

// 5 minutes later, config hasn't changed — should keep the same schedule
const laterMs = now + 5 * 60_000;
const secondDue = resolveNextHeartbeatDueMs({
  nowMs: laterMs,
  intervalMs: THIRTY_MINUTES,
  phaseMs: alicePhase,
  prev: { intervalMs: THIRTY_MINUTES, phaseMs: alicePhase, nextDueMs: firstDue },
});

console.log(`  Alice first due:  ${new Date(firstDue).toISOString()}`);
console.log(`  Alice 5min later: ${new Date(secondDue).toISOString()}`);
console.log(`  Same time? ${firstDue === secondDue ? "YES (schedule preserved)" : "NO (recomputed)"}`);

// Active hours check
console.log("\n--- Active Hours Demo ---\n");

const timezone = "Europe/London";
const activeStart = 9;
const activeEnd = 18;
const withinHours = isWithinActiveHours({
  nowMs: now,
  timezone,
  activeStart,
  activeEnd,
});

console.log(`  Timezone: ${timezone}`);
console.log(`  Active window: ${activeStart}:00 - ${activeEnd}:00`);
console.log(`  Currently within active hours? ${withinHours ? "YES" : "NO (heartbeat skipped)"}`);

console.log("\nKey takeaways:");
console.log("  1. SHA-256 phase offset distributes agents evenly across the interval");
console.log("  2. Same seed+agent always produces the same offset (deterministic)");
console.log("  3. Schedule is preserved across config reloads if nothing changed");
console.log("  4. Active hours prevent heartbeats from firing during quiet periods");
