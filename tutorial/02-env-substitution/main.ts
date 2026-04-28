/**
 * Tutorial 02 — Environment Variable Substitution
 *
 * How OpenClaw resolves ${VAR_NAME} references in configuration values.
 *
 * Real source: src/config/env-substitution.ts
 *
 * Key insight: Configuration often contains secrets (API keys, tokens) that
 * shouldn't be hardcoded. OpenClaw's config system supports ${VAR} syntax
 * that gets resolved at load time. This is NOT template literals — it's a
 * custom parser that:
 *   - Only matches UPPERCASE_VARS (prevents accidental JS expression eval)
 *   - Supports escaping: $${VAR} becomes literal ${VAR}
 *   - Walks the config tree recursively (objects, arrays, nested)
 *   - Reports missing vars with the full config path for debugging
 *
 * Run: bun run tutorial/02-env-substitution/main.ts
 */

// ── Types ────────────────────────────────────────────────────────────────────

type SubstitutionError = {
  path: string;      // e.g. "channels.telegram.botToken"
  variable: string;  // e.g. "TELEGRAM_BOT_TOKEN"
  message: string;
};

type SubstitutionResult = {
  value: unknown;
  errors: SubstitutionError[];
};

// ── Token Parser ─────────────────────────────────────────────────────────────
// Recognizes ${VAR_NAME} tokens in a string value.
// Only allows uppercase alphanumeric + underscore (no arbitrary expressions).
// Pattern from src/config/env-substitution.ts

const ENV_VAR_PATTERN = /\$\$?\{([A-Z_][A-Z0-9_]*)\}/g;

function substituteString(
  value: string,
  env: Record<string, string>,
  path: string,
  errors: SubstitutionError[]
): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName) => {
    // Escaped: $${VAR} → literal ${VAR}
    if (match.startsWith("$$")) {
      return `\${${varName}}`;
    }

    // Look up in environment
    const envValue = env[varName];
    if (envValue === undefined) {
      errors.push({
        path,
        variable: varName,
        message: `Missing environment variable: ${varName} (referenced at config path: ${path})`,
      });
      return match; // leave the token as-is so it's visible in error output
    }

    return envValue;
  });
}

// ── Recursive Walker ─────────────────────────────────────────────────────────
// Walks the entire config object tree, substituting env vars in string values.
// Handles: strings, arrays, nested objects. Skips numbers, booleans, null.

function substituteConfig(
  obj: unknown,
  env: Record<string, string>,
  path: string = "",
  errors: SubstitutionError[] = []
): SubstitutionResult {
  if (typeof obj === "string") {
    return { value: substituteString(obj, env, path, errors), errors };
  }

  if (Array.isArray(obj)) {
    const result = obj.map((item, i) =>
      substituteConfig(item, env, `${path}[${i}]`, errors).value
    );
    return { value: result, errors };
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = substituteConfig(val, env, childPath, errors).value;
    }
    return { value: result, errors };
  }

  // Primitives (number, boolean, null) pass through unchanged
  return { value: obj, errors };
}

// ── Demo ─────────────────────────────────────────────────────────────────────

console.log("=== Tutorial 02: Environment Variable Substitution ===\n");

// Simulate environment variables
const env: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-api03-xxxxxxxxxxxx",
  TELEGRAM_BOT_TOKEN: "7654321:AAFabcdefghijklmnop",
  OPENAI_API_KEY: "sk-proj-xxxxxxxxxxxx",
};

// Sample config with ${VAR} references
const rawConfig = {
  providers: {
    anthropic: {
      apiKey: "${ANTHROPIC_API_KEY}",
      model: "claude-sonnet-4-20250514", // no substitution needed
    },
    openai: {
      apiKey: "${OPENAI_API_KEY}",
    },
  },
  channels: {
    telegram: {
      botToken: "${TELEGRAM_BOT_TOKEN}",
      allowFrom: ["user123", "user456"],
    },
  },
  agent: {
    name: "Nova",
    // Escaped — should become literal ${VERSION}
    displayVersion: "$${VERSION}",
    // Missing env var — should produce an error
    webhook: "${WEBHOOK_SECRET}",
  },
};

console.log("Raw config (before substitution):");
console.log(JSON.stringify(rawConfig, null, 2));
console.log("");

const { value: resolved, errors } = substituteConfig(rawConfig, env);

console.log("Resolved config (after substitution):");
console.log(JSON.stringify(resolved, null, 2));
console.log("");

if (errors.length > 0) {
  console.log("Substitution errors:");
  for (const err of errors) {
    console.log(`  [${err.path}] ${err.message}`);
  }
  console.log("");
}

console.log("Key takeaways:");
console.log("  1. ${VAR} is resolved from environment at config load time");
console.log("  2. $${VAR} is an escape hatch — becomes literal ${VAR}");
console.log("  3. Only UPPERCASE_VARS are matched (prevents JS expression injection)");
console.log("  4. Missing vars report the full config path for easy debugging");
console.log("  5. Non-string values (numbers, booleans, arrays) pass through unchanged");
