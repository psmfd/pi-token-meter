/**
 * token-meter — per-session, per-model token-usage counter for pi (ADR-0073).
 *
 * A `message_end` handler appends one JSONL record per assistant turn to
 * ~/.pi/agent/extensions/token-meter/sessions/<session-id>.jsonl, and the
 * `token_usage` tool + scripts/token-meter.sh aggregate those records by model.
 *
 * Toggle (hybrid, inert by default):
 *   - persistent default: extensionSettings.tokenMeter.enabled in
 *     ~/.pi/agent/settings.json (USER layer only — a project layer cannot flip
 *     metering, closing the "hostile repo hides its cost" trust gap);
 *   - per-session: `--token-meter` launch flag or `/token-meter on|off|status`.
 *
 * Whole-tree accounting: when enabled the ROOT process exports TOKEN_METER_SESSION
 * (its own session id) and TOKEN_METER_ENABLED=1 into process.env. pi spawns
 * subagents as child processes inheriting env, so every descendant records to the
 * ROOT session's file — the session total includes all subagent usage.
 *
 * Invariants (carried from cache-meter / ADR-0034): the `message_end` handler is
 * OBSERVATIONAL — always returns undefined, never a replacement `{ message }`
 * (rewriting the message would churn the provider's cached prefix). No network
 * calls; only numeric usage + model/provider strings are read — never message
 * content — and no secret ever transits a log line.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { aggregateByModel, buildRecord, formatTable, formatTerse } from "./record.ts";
import { appendTurn, readSession, safeSessionKey } from "./state.ts";
import type { AssistantMessageLike } from "./types.ts";

interface MessageEndEvent {
  message?: AssistantMessageLike;
}
interface ModelContext {
  model?: { provider?: string };
  sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined };
}

const ENV_SESSION = "TOKEN_METER_SESSION";
const ENV_ENABLED = "TOKEN_METER_ENABLED";

/** Read the USER-layer settings toggle only (project layer is untrusted here). */
async function readSettingsEnabled(): Promise<boolean> {
  try {
    const p = join(homedir(), ".pi", "agent", "settings.json");
    const j = JSON.parse(await fs.readFile(p, "utf8")) as {
      extensionSettings?: { tokenMeter?: { enabled?: unknown } };
    };
    return j?.extensionSettings?.tokenMeter?.enabled === true;
  } catch {
    return false;
  }
}

/** Resolve this process's session key: an inherited root id (child) or our own. */
function resolveSessionKey(ctx: ExtensionContext): string {
  const inherited = process.env[ENV_SESSION]?.trim();
  if (inherited) return safeSessionKey(inherited);
  const sm = (ctx as unknown as ModelContext).sessionManager;
  const own = sm?.getSessionId?.() ?? sm?.getSessionFile?.()?.replace(/\.jsonl$/, "");
  return safeSessionKey(own);
}

export default function tokenMeter(pi: ExtensionAPI): void {
  // A child (subagent) process inherits enablement + the root session key.
  let enabled = process.env[ENV_ENABLED] === "1";
  let sessionKey = "unknown-session";
  let turn = 0;

  // Export env so subagent child processes inherit enablement + the root key.
  // Only the ROOT stamps the session id (guarded) — descendants keep the root's.
  const propagate = (): void => {
    if (!process.env[ENV_SESSION]) process.env[ENV_SESSION] = sessionKey;
    process.env[ENV_ENABLED] = "1";
  };

  pi.registerFlag("token-meter", {
    description: "Count per-model token usage for this session",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    turn = 0;
    sessionKey = resolveSessionKey(ctx);
    if (!enabled) {
      enabled = (await readSettingsEnabled()) || pi.getFlag("token-meter") === true;
    }
    if (enabled) {
      propagate();
      if (ctx.hasUI) ctx.ui.setStatus("token-meter", "📊 token-meter: on");
    }
  });

  pi.registerCommand("token-meter", {
    description: "Token counter: /token-meter [on|off|status]",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "on") {
        enabled = true;
        propagate();
        if (ctx.hasUI) ctx.ui.setStatus("token-meter", "📊 token-meter: on");
      } else if (sub === "off") {
        enabled = false;
        process.env[ENV_ENABLED] = "0";
        if (ctx.hasUI) ctx.ui.setStatus("token-meter", "");
      }
      let summary = "no usage recorded yet";
      try {
        summary = formatTerse(aggregateByModel(await readSession(sessionKey)));
      } catch {
        /* status still reported below */
      }
      ctx.ui.notify(`token-meter: ${enabled ? "ON" : "OFF"} — ${summary}`, "info");
    },
  });

  pi.on("message_end", async (event, ctx) => {
    // Observational only — never return a replacement message (no prefix churn).
    try {
      if (!enabled) return undefined;
      const message = (event as unknown as MessageEndEvent).message;
      if (!message || message.role !== "assistant") return undefined;
      turn += 1;
      const record = buildRecord(message, {
        ts: new Date().toISOString(),
        turn,
        providerFallback: (ctx as unknown as ModelContext).model?.provider ?? "unknown",
      });
      if (record) await appendTurn(sessionKey, record);
    } catch {
      // Accounting must never disturb a turn.
    }
    return undefined;
  });

  pi.registerTool({
    name: "token_usage",
    label: "Token Usage",
    description:
      "Report token usage for the current pi session, broken down by model. " +
      "Reads token-meter's local per-session log; requires token-meter to be enabled. " +
      "Returns a terse one-line total by default, or a per-model table with verbose:true.",
    promptSnippet: "Report this session's token usage with token_usage (per-model totals).",
    promptGuidelines: [
      "token_usage reports THIS session's token counts by model from a local log; it makes no network call.",
      "token_usage returns nothing meaningful unless token-meter is enabled (settings or /token-meter on).",
    ],
    parameters: Type.Object({
      verbose: Type.Optional(
        Type.Boolean({ description: "Return the full per-model table instead of a one-line total." }),
      ),
    }),
    async execute(_toolCallId, params) {
      let totals;
      try {
        totals = aggregateByModel(await readSession(sessionKey));
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `token_usage: could not read the session log — ${(err as Error).message}` }],
          details: undefined,
          isError: true,
        };
      }
      const text = params.verbose ? formatTable(totals) : formatTerse(totals);
      return {
        content: [{ type: "text" as const, text }],
        details: { enabled, session: sessionKey, models: totals.length },
      };
    },
  });
}
