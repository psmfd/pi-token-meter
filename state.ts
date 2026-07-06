/**
 * token-meter/state.ts — per-session append-only JSONL log + reader.
 *
 * Records land at ~/.pi/agent/extensions/token-meter/sessions/<session-id>.jsonl
 * (the per-extension subtree, ADR-0019/ADR-0030), reached in a dev checkout via
 * the setup.sh `~/.pi → repo` symlink and gitignored. `agentDir` is injectable
 * so the I/O unit-tests against a temp dir.
 *
 * Append-only is the ONLY concurrency-safe design here: pi runs parallel
 * subagents as separate processes, and whole-tree accounting has descendant
 * processes append to the ROOT session's file (see index.ts env propagation).
 * A single `fs.appendFile` is one `write()` on an O_APPEND fd — interleaving-safe
 * across processes. A mutable read-modify-write rollup would lose updates.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toJsonl } from "./record.ts";
import type { TierMap, TurnRecord } from "./types.ts";

const NAMESPACE = "token-meter";
const SESSIONS_DIR = "sessions";

/** Directory holding per-session logs. */
export function sessionsDir(agentDir?: string): string {
  const base = agentDir ?? join(homedir(), ".pi", "agent");
  return join(base, "extensions", NAMESPACE, SESSIONS_DIR);
}

/**
 * Sanitize a session id before it becomes a path component. `basename` strips any
 * directory portion; `.`/`..`/empty are rejected to a safe constant so a hostile
 * or malformed id can never traverse out of the sessions dir (OWASP path
 * traversal; same posture as compaction-optimizer's archive writer).
 */
export function safeSessionKey(id: string | undefined): string {
  const b = basename((id ?? "").trim());
  if (b === "" || b === "." || b === "..") return "unknown-session";
  return b;
}

/** Resolve the JSONL log path for one session. */
export function sessionLogPath(sessionId: string, agentDir?: string): string {
  return join(sessionsDir(agentDir), `${safeSessionKey(sessionId)}.jsonl`);
}

/** Append one turn record as a JSONL line, creating the directory as needed. */
export async function appendTurn(
  sessionId: string,
  record: TurnRecord,
  agentDir?: string,
): Promise<void> {
  const file = sessionLogPath(sessionId, agentDir);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.appendFile(file, toJsonl(record), "utf8");
}

/** Default location of the committed provider → tier map: next to this module. */
export function defaultTiersPath(): string {
  return fileURLToPath(new URL("tiers.json", import.meta.url));
}

/**
 * Load the provider → tier map from tiers.json (`{v:1, tiers:{...}}`).
 * Offline-safe and fail-quiet: a missing, unreadable, or malformed file yields
 * an empty map, which makes every provider aggregate as "unmapped" — visible in
 * the rollup rather than breaking metering. Non-string entries are dropped.
 */
export async function loadTierMap(path?: string): Promise<TierMap> {
  try {
    const raw = await fs.readFile(path ?? defaultTiersPath(), "utf8");
    const parsed = JSON.parse(raw) as { tiers?: unknown };
    if (parsed === null || typeof parsed !== "object" || typeof parsed.tiers !== "object" || parsed.tiers === null) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [provider, tier] of Object.entries(parsed.tiers)) {
      if (typeof tier === "string" && tier !== "") out[provider] = tier;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Read + parse one session's turn records. Skips any malformed/partial line
 * (a mid-line append interrupted by a process kill) rather than throwing, and
 * returns [] when the session has no log yet.
 */
export async function readSession(
  sessionId: string,
  agentDir?: string,
): Promise<Partial<TurnRecord>[]> {
  const file = sessionLogPath(sessionId, agentDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: Partial<TurnRecord>[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const rec = JSON.parse(t) as Partial<TurnRecord>;
      if (rec && typeof rec === "object") out.push(rec);
    } catch {
      // Skip a corrupt/partial trailing line; never throw on read.
    }
  }
  return out;
}
