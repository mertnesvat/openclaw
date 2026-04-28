/**
 * Tutorial 08 — Route Resolution with Binding Priority
 *
 * How OpenClaw maps incoming messages to the right agent.
 *
 * Real source: src/routing/resolve-route.ts, src/routing/session-key.ts
 *
 * Key insight: OpenClaw supports MULTIPLE agents running simultaneously.
 * When a message arrives on Discord or Telegram, the router must decide:
 * "Which agent should handle this message?"
 *
 * The answer comes from BINDINGS — rules that map message properties to agents.
 * Bindings are checked in PRIORITY ORDER:
 *
 *   1. binding.peer        — exact user match (highest priority)
 *   2. binding.peer.parent — thread parent match
 *   3. binding.peer.wildcard — wildcard peer patterns
 *   4. binding.guild+roles — Discord guild + member roles
 *   5. binding.guild       — all messages in a Discord guild
 *   6. binding.team        — all messages in a Slack team
 *   7. binding.account     — all messages for a bot account
 *   8. binding.channel     — all messages on a channel type
 *   9. default             — fallback agent (lowest priority)
 *
 * This means you can route specific users to a specialized agent while
 * everyone else goes to the default. Like a phone menu, but smarter.
 *
 * Run: bun run tutorial/08-route-resolution/main.ts
 */

// ── Types ────────────────────────────────────────────────────────────────────
// From src/routing/resolve-route.ts

type ChatType = "direct" | "group" | "channel";

type RoutePeer = {
  kind: ChatType;
  id: string;
};

type Binding = {
  agentId: string;
  match: {
    channel?: string;         // e.g., "discord", "telegram"
    accountId?: string;       // specific bot account
    peer?: { kind: ChatType; id: string }; // exact user/chat
    guildId?: string;         // Discord guild
    teamId?: string;          // Slack team
    roles?: string[];         // Discord roles
  };
};

type RouteInput = {
  channel: string;            // "discord", "telegram", etc.
  accountId?: string;
  peer?: RoutePeer;
  parentPeer?: RoutePeer;     // for threads
  guildId?: string;
  teamId?: string;
  memberRoleIds?: string[];
};

type ResolvedRoute = {
  agentId: string;
  sessionKey: string;
  matchedBy: string;          // which binding level matched
};

// ── Session Key Builder ──────────────────────────────────────────────────────
// From src/routing/session-key.ts
// Format: {agentId}:main:{channel}:{chatType}:{peerId}

function buildSessionKey(
  agentId: string,
  channel: string,
  peer?: RoutePeer
): string {
  const parts = [agentId, "main", channel];
  if (peer) {
    parts.push(peer.kind, peer.id);
  }
  return parts.join(":");
}

// ── Route Resolver ───────────────────────────────────────────────────────────
// Simplified from src/routing/resolve-route.ts — resolveAgentRoute()
// Walks bindings in priority order, returns first match.

function resolveRoute(
  input: RouteInput,
  bindings: Binding[],
  defaultAgentId: string
): ResolvedRoute {
  // Priority 1: Exact peer match
  if (input.peer) {
    const match = bindings.find(
      (b) =>
        b.match.peer &&
        b.match.peer.id === input.peer!.id &&
        b.match.peer.kind === input.peer!.kind &&
        (!b.match.channel || b.match.channel === input.channel)
    );
    if (match) {
      return {
        agentId: match.agentId,
        sessionKey: buildSessionKey(match.agentId, input.channel, input.peer),
        matchedBy: "binding.peer",
      };
    }
  }

  // Priority 2: Parent peer match (for threads)
  if (input.parentPeer) {
    const match = bindings.find(
      (b) =>
        b.match.peer &&
        b.match.peer.id === input.parentPeer!.id &&
        (!b.match.channel || b.match.channel === input.channel)
    );
    if (match) {
      return {
        agentId: match.agentId,
        sessionKey: buildSessionKey(match.agentId, input.channel, input.peer),
        matchedBy: "binding.peer.parent",
      };
    }
  }

  // Priority 4: Guild + Roles match
  if (input.guildId && input.memberRoleIds?.length) {
    const match = bindings.find(
      (b) =>
        b.match.guildId === input.guildId &&
        b.match.roles?.some((r) => input.memberRoleIds!.includes(r))
    );
    if (match) {
      return {
        agentId: match.agentId,
        sessionKey: buildSessionKey(match.agentId, input.channel, input.peer),
        matchedBy: "binding.guild+roles",
      };
    }
  }

  // Priority 5: Guild match
  if (input.guildId) {
    const match = bindings.find(
      (b) => b.match.guildId === input.guildId && !b.match.roles
    );
    if (match) {
      return {
        agentId: match.agentId,
        sessionKey: buildSessionKey(match.agentId, input.channel, input.peer),
        matchedBy: "binding.guild",
      };
    }
  }

  // Priority 6: Team match
  if (input.teamId) {
    const match = bindings.find((b) => b.match.teamId === input.teamId);
    if (match) {
      return {
        agentId: match.agentId,
        sessionKey: buildSessionKey(match.agentId, input.channel, input.peer),
        matchedBy: "binding.team",
      };
    }
  }

  // Priority 7: Account match
  if (input.accountId) {
    const match = bindings.find(
      (b) =>
        b.match.accountId === input.accountId &&
        (!b.match.channel || b.match.channel === input.channel)
    );
    if (match) {
      return {
        agentId: match.agentId,
        sessionKey: buildSessionKey(match.agentId, input.channel, input.peer),
        matchedBy: "binding.account",
      };
    }
  }

  // Priority 8: Channel match
  {
    const match = bindings.find(
      (b) =>
        b.match.channel === input.channel &&
        !b.match.peer &&
        !b.match.guildId &&
        !b.match.teamId &&
        !b.match.accountId
    );
    if (match) {
      return {
        agentId: match.agentId,
        sessionKey: buildSessionKey(match.agentId, input.channel, input.peer),
        matchedBy: "binding.channel",
      };
    }
  }

  // Priority 9: Default
  return {
    agentId: defaultAgentId,
    sessionKey: buildSessionKey(defaultAgentId, input.channel, input.peer),
    matchedBy: "default",
  };
}

// ── Demo ─────────────────────────────────────────────────────────────────────

console.log("=== Tutorial 08: Route Resolution ===\n");

// Configure bindings — these map messages to agents
const bindings: Binding[] = [
  // VIP user "mert" always goes to the "nova" agent (personal assistant)
  {
    agentId: "nova",
    match: { peer: { kind: "direct", id: "mert-123" } },
  },
  // The #support Discord guild goes to the "support-bot" agent
  {
    agentId: "support-bot",
    match: { guildId: "guild-support-999" },
  },
  // Users with "premium" role in the main guild go to "premium-bot"
  {
    agentId: "premium-bot",
    match: { guildId: "guild-main-001", roles: ["role-premium"] },
  },
  // All Telegram messages go to "telegram-bot"
  {
    agentId: "telegram-bot",
    match: { channel: "telegram" },
  },
];

const defaultAgent = "general-assistant";

console.log("Bindings configured:");
for (const b of bindings) {
  const matchDesc = Object.entries(b.match)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  console.log(`  ${b.agentId.padEnd(16)} <- ${matchDesc}`);
}
console.log(`  ${"(default)".padEnd(16)} <- ${defaultAgent}\n`);

// Test various messages
const testMessages: { label: string; input: RouteInput }[] = [
  {
    label: "DM from VIP user Mert on Discord",
    input: {
      channel: "discord",
      peer: { kind: "direct", id: "mert-123" },
      guildId: undefined,
    },
  },
  {
    label: "Message in #support Discord guild",
    input: {
      channel: "discord",
      peer: { kind: "group", id: "channel-help" },
      guildId: "guild-support-999",
    },
  },
  {
    label: "Premium user in main Discord guild",
    input: {
      channel: "discord",
      peer: { kind: "group", id: "channel-general" },
      guildId: "guild-main-001",
      memberRoleIds: ["role-premium", "role-member"],
    },
  },
  {
    label: "Regular user on Telegram",
    input: {
      channel: "telegram",
      peer: { kind: "direct", id: "tg-user-456" },
    },
  },
  {
    label: "Unknown user on Slack (no bindings match)",
    input: {
      channel: "slack",
      peer: { kind: "direct", id: "slack-user-789" },
      teamId: "team-unknown",
    },
  },
];

console.log("--- Routing Messages ---\n");

for (const { label, input } of testMessages) {
  const route = resolveRoute(input, bindings, defaultAgent);
  console.log(`  ${label}`);
  console.log(`    -> agent: ${route.agentId}`);
  console.log(`    -> matched by: ${route.matchedBy}`);
  console.log(`    -> session key: ${route.sessionKey}`);
  console.log("");
}

console.log("Key takeaways:");
console.log("  1. Bindings are checked in strict priority order (peer > guild > channel > default)");
console.log("  2. First match wins — more specific bindings always beat broader ones");
console.log("  3. Session keys encode agent + channel + peer for persistence");
console.log("  4. Multiple agents can run simultaneously with different bindings");
console.log("  5. Default agent catches everything that doesn't match a binding");
console.log("  6. Thread messages can inherit routing from their parent peer");
