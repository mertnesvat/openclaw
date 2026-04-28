/**
 * Tutorial 06 — Plugin Manifest Discovery
 *
 * How OpenClaw discovers plugins via manifests BEFORE loading any code.
 *
 * Real source: src/plugins/manifest.ts, src/plugins/loader.ts
 *
 * Key insight: Most plugin systems load code first, then discover capabilities.
 * OpenClaw FLIPS this: it reads openclaw.plugin.json manifests first, validates
 * them, plans which plugins should activate, and ONLY THEN loads runtime code.
 *
 * This "manifest-first control plane" means:
 *   - A broken plugin can never crash the host during discovery
 *   - Plugin metadata is available for UI, CLI, and config without loading code
 *   - Activation decisions (enabled/disabled) happen from pure data
 *   - Code loading is deferred until the plugin is actually needed (lazy)
 *
 * The manifest declares: id, capabilities, config schema, commands, hooks, etc.
 * Think of it as the plugin's "resume" — the host reads it and decides whether
 * to "hire" (activate) the plugin.
 *
 * Run: bun run tutorial/06-plugin-manifest/main.ts
 */

// ── Types ────────────────────────────────────────────────────────────────────
// Simplified from src/plugins/types.ts and manifest.ts

type PluginManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  runtime: "node" | "bun";
  capabilities?: string[];     // e.g., ["channel", "provider", "tools"]
  enabledByDefault?: boolean;
  hooks?: PluginHookDeclaration[];
  commands?: PluginCommandDeclaration[];
  configSchema?: Record<string, unknown>;
};

type PluginHookDeclaration = {
  event: string;       // e.g., "message:received"
  entrypoint: string;  // e.g., "./hooks/on-message.js"
};

type PluginCommandDeclaration = {
  name: string;
  description: string;
  entrypoint: string;
};

type ManifestLoadResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string };

// ── Manifest Loader ──────────────────────────────────────────────────────────
// Simplified from src/plugins/manifest.ts — loadPluginManifest()

function loadPluginManifest(raw: unknown): ManifestLoadResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "Manifest must be a JSON object" };
  }

  const obj = raw as Record<string, unknown>;

  // Required field: id
  if (typeof obj.id !== "string" || obj.id.trim() === "") {
    return { ok: false, error: "Manifest missing required field: id" };
  }

  // Required field: name
  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    return { ok: false, error: "Manifest missing required field: name" };
  }

  // Required field: version
  if (typeof obj.version !== "string") {
    return { ok: false, error: "Manifest missing required field: version" };
  }

  // Normalize capabilities (trim, filter empty)
  const capabilities = Array.isArray(obj.capabilities)
    ? (obj.capabilities as string[]).map((c) => c.trim()).filter(Boolean)
    : [];

  return {
    ok: true,
    manifest: {
      id: obj.id.trim(),
      name: obj.name.trim(),
      version: obj.version.trim(),
      description: typeof obj.description === "string" ? obj.description : undefined,
      runtime: obj.runtime === "bun" ? "bun" : "node",
      capabilities,
      enabledByDefault: obj.enabledByDefault === true,
      hooks: Array.isArray(obj.hooks) ? (obj.hooks as PluginHookDeclaration[]) : [],
      commands: Array.isArray(obj.commands) ? (obj.commands as PluginCommandDeclaration[]) : [],
      configSchema: typeof obj.configSchema === "object" ? (obj.configSchema as Record<string, unknown>) : undefined,
    },
  };
}

// ── Plugin Discovery ─────────────────────────────────────────────────────────
// Simulates scanning an extensions/ directory for plugin manifests.
// In real OpenClaw: src/plugins/loader.ts scans extensions/* for openclaw.plugin.json

type DiscoveredPlugin = {
  dir: string;
  manifest: PluginManifest;
};

function discoverPlugins(pluginDirs: Map<string, unknown>): DiscoveredPlugin[] {
  const discovered: DiscoveredPlugin[] = [];

  for (const [dir, rawManifest] of pluginDirs) {
    const result = loadPluginManifest(rawManifest);
    if (result.ok) {
      discovered.push({ dir, manifest: result.manifest });
      console.log(`  [discover] ${dir} -> OK (id: ${result.manifest.id})`);
    } else {
      console.log(`  [discover] ${dir} -> FAILED: ${result.error}`);
    }
  }

  return discovered;
}

// ── Activation Planner ───────────────────────────────────────────────────────
// Decides which discovered plugins should actually load.
// In real OpenClaw, this checks config.plugins.enabled/disabled lists.

type ActivationPlan = {
  pluginId: string;
  shouldActivate: boolean;
  reason: string;
};

function planActivation(
  discovered: DiscoveredPlugin[],
  config: { enabled: string[]; disabled: string[] }
): ActivationPlan[] {
  return discovered.map(({ manifest }) => {
    // Explicit enable overrides everything
    if (config.enabled.includes(manifest.id)) {
      return { pluginId: manifest.id, shouldActivate: true, reason: "explicitly enabled in config" };
    }

    // Explicit disable overrides default
    if (config.disabled.includes(manifest.id)) {
      return { pluginId: manifest.id, shouldActivate: false, reason: "explicitly disabled in config" };
    }

    // Fall back to manifest default
    if (manifest.enabledByDefault) {
      return { pluginId: manifest.id, shouldActivate: true, reason: "enabled by default (manifest)" };
    }

    return { pluginId: manifest.id, shouldActivate: false, reason: "not enabled (no config, no default)" };
  });
}

// ── Demo ─────────────────────────────────────────────────────────────────────

console.log("=== Tutorial 06: Plugin Manifest Discovery ===\n");

// Simulate an extensions/ directory with plugin manifests
const pluginDirs = new Map<string, unknown>([
  [
    "extensions/weather",
    {
      id: "weather",
      name: "Weather Plugin",
      version: "1.2.0",
      description: "Provides weather lookup tools",
      runtime: "node",
      capabilities: ["tools"],
      enabledByDefault: true,
      hooks: [{ event: "message:received", entrypoint: "./hooks/detect-weather-query.js" }],
      commands: [{ name: "weather", description: "Check weather for a location", entrypoint: "./commands/weather.js" }],
    },
  ],
  [
    "extensions/calendar",
    {
      id: "calendar",
      name: "Calendar Integration",
      version: "0.9.0",
      runtime: "node",
      capabilities: ["tools"],
      enabledByDefault: false,
      commands: [{ name: "schedule", description: "Manage calendar events", entrypoint: "./commands/schedule.js" }],
    },
  ],
  [
    "extensions/matrix",
    {
      id: "matrix",
      name: "Matrix Channel",
      version: "1.0.0",
      description: "Matrix messaging channel",
      runtime: "node",
      capabilities: ["channel"],
      enabledByDefault: true,
    },
  ],
  [
    "extensions/broken",
    {
      // Missing required fields — should fail validation
      version: "0.1.0",
    },
  ],
]);

console.log("Step 1: Discover and validate manifests\n");
const discovered = discoverPlugins(pluginDirs);

console.log(`\n  Discovered: ${discovered.length} valid plugins out of ${pluginDirs.size} directories\n`);

// User's config
const userConfig = {
  enabled: ["calendar"],  // explicitly enable calendar (overrides enabledByDefault: false)
  disabled: ["matrix"],   // explicitly disable matrix (overrides enabledByDefault: true)
};

console.log("Step 2: Plan activation (config overrides defaults)\n");
console.log(`  Config: enabled=[${userConfig.enabled}], disabled=[${userConfig.disabled}]\n`);

const plan = planActivation(discovered, userConfig);
for (const entry of plan) {
  const symbol = entry.shouldActivate ? "+" : "-";
  console.log(`  [${symbol}] ${entry.pluginId.padEnd(12)} ${entry.reason}`);
}

const active = plan.filter((p) => p.shouldActivate);
console.log(`\n  Will activate: ${active.map((p) => p.pluginId).join(", ") || "none"}`);
console.log(`  Code loading deferred until plugin is actually needed\n`);

console.log("Key takeaways:");
console.log("  1. Manifests are validated BEFORE any plugin code loads");
console.log("  2. A broken manifest (missing fields) can't crash the host");
console.log("  3. Config overrides manifest defaults (explicit enable/disable)");
console.log("  4. Capabilities are declared in metadata, not discovered at runtime");
console.log("  5. Code loading is lazy — only activated plugins get loaded");
console.log('  6. This is the "manifest-first control plane" pattern');
