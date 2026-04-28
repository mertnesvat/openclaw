/**
 * Tutorial 01 — Soul Context Loader
 *
 * How OpenClaw builds an agent's personality from workspace files.
 *
 * Real source: src/agents/system-prompt.ts (lines 39-100)
 *
 * Key insight: Context files are loaded in a FIXED priority order, not
 * alphabetically. SOUL.md (priority 20) comes before USER.md (priority 40).
 * This ensures personality is established before user-specific context.
 *
 * The system also splits content into "stable" (cacheable across turns) and
 * "dynamic" (changes frequently, like HEARTBEAT.md). A cache boundary marker
 * separates them so the LLM provider can cache the stable prefix and save
 * tokens on every subsequent turn.
 *
 * Run: bun run tutorial/01-soul-context-loader/main.ts
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ────────────────────────────────────────────────────────────────────
// Mirrors EmbeddedContextFile from src/agents/pi-embedded-helpers.ts

type ContextFile = {
  path: string;     // relative path like "SOUL.md"
  content: string;  // raw file content
};

// ── Priority Map ─────────────────────────────────────────────────────────────
// Exact copy from src/agents/system-prompt.ts:39-47
// Lower number = higher priority (injected earlier in the prompt)

const CONTEXT_FILE_ORDER = new Map<string, number>([
  ["agents.md", 10],    // Multi-agent setup instructions
  ["soul.md", 20],      // PRIMARY: Agent personality and tone
  ["identity.md", 30],  // Agent metadata (name, version, etc.)
  ["user.md", 40],      // User-specific context
  ["tools.md", 50],     // Tool usage guidance
  ["bootstrap.md", 60], // Startup directives
  ["memory.md", 70],    // Memory configuration
]);

// HEARTBEAT.md is special — it's "dynamic" content that changes frequently.
// It's kept BELOW the cache boundary so the stable prefix stays byte-identical
// across turns, maximizing prompt cache hits.
// See: src/agents/system-prompt.ts:49
const DYNAMIC_FILES = new Set(["heartbeat.md"]);

// ── Sorting ──────────────────────────────────────────────────────────────────
// From src/agents/system-prompt.ts:72-88

function sortContextFiles(files: ContextFile[]): ContextFile[] {
  return files.toSorted((a, b) => {
    const aBase = basename(a.path).toLowerCase();
    const bBase = basename(b.path).toLowerCase();
    const aOrder = CONTEXT_FILE_ORDER.get(aBase) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = CONTEXT_FILE_ORDER.get(bBase) ?? Number.MAX_SAFE_INTEGER;

    // Primary sort: by priority number
    if (aOrder !== bOrder) return aOrder - bOrder;
    // Secondary sort: alphabetical tiebreak for unknown files
    if (aBase !== bBase) return aBase.localeCompare(bBase);
    // Tertiary: full path tiebreak
    return a.path.localeCompare(b.path);
  });
}

// ── Classification ───────────────────────────────────────────────────────────

function isDynamic(file: ContextFile): boolean {
  return DYNAMIC_FILES.has(basename(file.path).toLowerCase());
}

// ── Sanitization ─────────────────────────────────────────────────────────────
// From src/agents/sanitize-for-prompt.ts — strip control chars and collapse whitespace

function sanitize(content: string): string {
  return content
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "") // strip control chars
    .replace(/\n{3,}/g, "\n\n")                       // collapse triple+ newlines
    .trim();
}

// ── Prompt Assembly ──────────────────────────────────────────────────────────
// This is the core of buildAgentSystemPrompt() from src/agents/system-prompt.ts

const CACHE_BOUNDARY = "\n<!-- SYSTEM_PROMPT_CACHE_BOUNDARY -->\n";

function buildSystemPrompt(files: ContextFile[]): string {
  const sorted = sortContextFiles(files);

  const stableFiles = sorted.filter((f) => !isDynamic(f));
  const dynamicFiles = sorted.filter((f) => isDynamic(f));

  const sections: string[] = [];

  // ── Stable section (cached across turns) ──────────────────────────
  sections.push("# Agent System Prompt\n");

  for (const file of stableFiles) {
    const name = basename(file.path).replace(".md", "").toUpperCase();
    const content = sanitize(file.content);

    // Special handling for SOUL.md — the personality directive
    // See: src/agents/system-prompt.ts (the buildProjectContextSection logic)
    if (basename(file.path).toLowerCase() === "soul.md") {
      sections.push(`## ${name} (Personality)`);
      sections.push(
        "If SOUL.md is present, embody its persona and tone. " +
          "Avoid stiff, generic replies; follow its guidance unless " +
          "higher-priority instructions override it.\n"
      );
    } else {
      sections.push(`## ${name}`);
    }

    sections.push(content);
    sections.push(""); // blank line separator
  }

  // ── Cache boundary ────────────────────────────────────────────────
  // Everything above this line is byte-identical across turns,
  // allowing the LLM provider to cache and reuse it.
  sections.push(CACHE_BOUNDARY);

  // ── Dynamic section (changes per turn) ────────────────────────────
  if (dynamicFiles.length > 0) {
    sections.push("## Dynamic Context (below cache boundary)\n");
    sections.push(
      "(This content may change between turns and is not cached.)\n"
    );
    for (const file of dynamicFiles) {
      const name = basename(file.path).replace(".md", "").toUpperCase();
      sections.push(`### ${name}`);
      sections.push(sanitize(file.content));
      sections.push("");
    }
  }

  return sections.join("\n");
}

// ── Demo ─────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceDir = resolve(__dirname, "..", "sample-workspace");

// Load all .md files from the sample workspace
const files: ContextFile[] = readdirSync(workspaceDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({
    path: f,
    content: readFileSync(join(workspaceDir, f), "utf-8"),
  }));

console.log("=== Tutorial 01: Soul Context Loader ===\n");
console.log(`Found ${files.length} context files in workspace:\n`);

// Show the sorting order
const sorted = sortContextFiles(files);
for (const file of sorted) {
  const base = basename(file.path).toLowerCase();
  const priority = CONTEXT_FILE_ORDER.get(base) ?? "none (default)";
  const dynamic = isDynamic(file) ? " [DYNAMIC]" : "";
  console.log(`  ${String(priority).padStart(4)}  ${file.path}${dynamic}`);
}

console.log("\n--- Assembled System Prompt ---\n");
console.log(buildSystemPrompt(files));
console.log("\n--- End of Prompt ---\n");

console.log("Key takeaways:");
console.log("  1. SOUL.md (priority 20) is injected FIRST after agents.md");
console.log("  2. HEARTBEAT.md goes below the cache boundary (dynamic)");
console.log("  3. The cache boundary lets providers skip re-processing stable content");
console.log("  4. SOUL.md gets a special 'embody its persona' instruction");
