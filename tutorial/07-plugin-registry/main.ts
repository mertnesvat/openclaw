/**
 * Tutorial 07 — Plugin Registry & Registration
 *
 * How loaded plugins register their capabilities into a central registry.
 *
 * Real source: src/plugins/registry.ts
 *
 * Key insight: Tutorial 06 showed how plugins are DISCOVERED (manifests).
 * This tutorial shows what happens AFTER activation: each plugin receives
 * a scoped API and registers its tools, hooks, channels, and providers.
 *
 * The registry enforces:
 *   - Name uniqueness: two plugins can't register a tool with the same name
 *   - Scoped API: each plugin can only see/modify its own registrations
 *   - Diagnostics: collisions produce errors, not crashes
 *
 * This two-phase design (manifest discovery → runtime registration) means
 * the host knows WHAT a plugin declares before it loads, and then VERIFIES
 * that what it registers matches expectations.
 *
 * Run: bun run tutorial/07-plugin-registry/main.ts
 */

// ── Types ────────────────────────────────────────────────────────────────────

type PluginTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => Promise<string>;
  // Track which plugin owns this tool
  _pluginId: string;
};

type PluginHookRegistration = {
  eventKey: string;
  handler: (event: unknown) => Promise<void>;
  _pluginId: string;
};

type PluginChannel = {
  id: string;
  name: string;
  _pluginId: string;
};

type Diagnostic = {
  level: "error" | "warning";
  pluginId: string;
  message: string;
};

// ── Registry ─────────────────────────────────────────────────────────────────
// Simplified from src/plugins/registry.ts

type PluginRegistry = {
  tools: Map<string, PluginTool>;
  hooks: PluginHookRegistration[];
  channels: Map<string, PluginChannel>;
  diagnostics: Diagnostic[];
};

function createPluginRegistry(): PluginRegistry {
  return {
    tools: new Map(),
    hooks: [],
    channels: new Map(),
    diagnostics: [],
  };
}

// ── Scoped API ───────────────────────────────────────────────────────────────
// Each plugin gets its own API instance that scopes registrations to that plugin.
// From src/plugins/registry.ts — createApi(record)

type PluginApi = {
  registerTool(tool: Omit<PluginTool, "_pluginId">): void;
  registerHook(eventKey: string, handler: (event: unknown) => Promise<void>): void;
  registerChannel(channel: Omit<PluginChannel, "_pluginId">): void;
};

function createPluginApi(pluginId: string, registry: PluginRegistry): PluginApi {
  return {
    registerTool(tool) {
      const fullTool: PluginTool = { ...tool, _pluginId: pluginId };

      // Collision detection: another plugin already registered this tool name
      if (registry.tools.has(tool.name)) {
        const existing = registry.tools.get(tool.name)!;
        registry.diagnostics.push({
          level: "error",
          pluginId,
          message:
            `Tool name collision: "${tool.name}" already registered by ` +
            `plugin "${existing._pluginId}". Skipping.`,
        });
        return; // don't overwrite — first registration wins
      }

      registry.tools.set(tool.name, fullTool);
      console.log(`  [${pluginId}] registered tool: ${tool.name}`);
    },

    registerHook(eventKey, handler) {
      registry.hooks.push({ eventKey, handler, _pluginId: pluginId });
      console.log(`  [${pluginId}] registered hook: ${eventKey}`);
    },

    registerChannel(channel) {
      if (registry.channels.has(channel.id)) {
        const existing = registry.channels.get(channel.id)!;
        registry.diagnostics.push({
          level: "error",
          pluginId,
          message:
            `Channel id collision: "${channel.id}" already registered by ` +
            `plugin "${existing._pluginId}". Skipping.`,
        });
        return;
      }

      registry.channels.set(channel.id, { ...channel, _pluginId: pluginId });
      console.log(`  [${pluginId}] registered channel: ${channel.id}`);
    },
  };
}

// ── Plugin Runtime Simulation ────────────────────────────────────────────────
// Simulates what happens when a plugin's index.js is loaded and called.

async function loadAndRegisterPlugin(
  pluginId: string,
  registry: PluginRegistry,
  initFn: (api: PluginApi) => Promise<void>
) {
  const api = createPluginApi(pluginId, registry);
  console.log(`\n  Loading plugin: ${pluginId}`);
  await initFn(api);
}

// ── Demo ─────────────────────────────────────────────────────────────────────

console.log("=== Tutorial 07: Plugin Registry & Registration ===\n");

const registry = createPluginRegistry();

// Plugin 1: Weather plugin registers tools and hooks
await loadAndRegisterPlugin("weather", registry, async (api) => {
  api.registerTool({
    name: "get_weather",
    description: "Get weather for a location",
    inputSchema: { type: "object", properties: { location: { type: "string" } } },
    execute: async (input) => {
      const { location } = input as { location: string };
      return `Weather in ${location}: 18C, partly cloudy`;
    },
  });

  api.registerHook("message:received", async (event) => {
    // Detect weather-related queries and suggest tool use
    console.log("    weather hook: checking for weather queries...");
  });
});

// Plugin 2: Calendar plugin registers tools
await loadAndRegisterPlugin("calendar", registry, async (api) => {
  api.registerTool({
    name: "create_event",
    description: "Create a calendar event",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string" },
      },
    },
    execute: async (input) => {
      const { title, date } = input as { title: string; date: string };
      return `Created event: ${title} on ${date}`;
    },
  });

  // TRY to register a tool with a name that already exists
  api.registerTool({
    name: "get_weather", // COLLISION with weather plugin!
    description: "Calendar weather check",
    inputSchema: {},
    execute: async () => "nope",
  });
});

// Plugin 3: Matrix channel plugin
await loadAndRegisterPlugin("matrix", registry, async (api) => {
  api.registerChannel({
    id: "matrix",
    name: "Matrix Protocol",
  });

  api.registerHook("message:sent", async (event) => {
    console.log("    matrix hook: formatting for Matrix protocol...");
  });
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log("\n--- Registry Summary ---\n");

console.log("  Tools:");
for (const [name, tool] of registry.tools) {
  console.log(`    ${name} (owner: ${tool._pluginId}) — ${tool.description}`);
}

console.log("\n  Hooks:");
for (const hook of registry.hooks) {
  console.log(`    ${hook.eventKey} (owner: ${hook._pluginId})`);
}

console.log("\n  Channels:");
for (const [id, channel] of registry.channels) {
  console.log(`    ${id} (owner: ${channel._pluginId}) — ${channel.name}`);
}

if (registry.diagnostics.length > 0) {
  console.log("\n  Diagnostics:");
  for (const diag of registry.diagnostics) {
    console.log(`    [${diag.level}] ${diag.message}`);
  }
}

// Execute a tool to show it works
console.log("\n--- Tool Execution Demo ---\n");
const weatherTool = registry.tools.get("get_weather");
if (weatherTool) {
  const result = await weatherTool.execute({ location: "London" });
  console.log(`  get_weather("London") -> "${result}"`);
}

console.log("\nKey takeaways:");
console.log("  1. Each plugin gets a SCOPED API — can only register, not see others");
console.log("  2. Name collisions produce diagnostics, not crashes");
console.log("  3. First registration wins — later collisions are skipped");
console.log("  4. Two-phase: manifest DECLARES, runtime REGISTERS");
console.log("  5. The registry becomes the source of truth for available capabilities");
console.log("  6. Tools, hooks, channels, providers all follow the same pattern");
