/**
 * token-meter/record.ts — pure turn-record construction + aggregation (no I/O).
 *
 * Side-effect-free so it unit-tests without a live pi runtime: the timestamp and
 * turn index are injected. Returns null for any non-assistant message (only
 * assistant turns carry usage).
 */

import type {
  AssistantMessageLike, ModelTotals, PolicyTotals, ProviderTotals, TierMap, TierTotals, TurnRecord,
} from "./types.ts";

/**
 * Sentinel for a missing routing-policy tag (#521). MUST stay in lockstep with
 * the `.policy // "untagged"` jq default in scripts/token-meter.sh — a drift
 * would split pre-#521 records and untagged records into two buckets.
 * Deliberately NOT "unknown" (this codebase's other absent-field sentinel):
 * the spec's contract is "untagged", and the CLI renders it verbatim.
 */
export const UNTAGGED = "untagged";

export interface RecordContext {
  readonly ts: string;
  readonly turn: number;
  /** Provider fallback when the message omits its own `provider`. */
  readonly providerFallback: string;
  /** Routing-policy tag, already normalized ("untagged" when unset). */
  readonly policyTag: string;
}

/** Build a {@link TurnRecord} from an assistant message, or null if not applicable. */
export function buildRecord(
  message: AssistantMessageLike | undefined,
  ctx: RecordContext,
): TurnRecord | null {
  if (!message || message.role !== "assistant") return null;
  const usage = message.usage ?? {};
  const input = numberOr(usage.input, 0);
  const cacheRead = numberOr(usage.cacheRead, 0);
  const cacheWrite = numberOr(usage.cacheWrite, 0);
  const output = numberOr(usage.output, 0);
  // Prefer the provider's own total; fall back to the component sum. Model and
  // provider are read from the message itself so the pair is atomic (avoids a
  // race with a mid-session model switch reading provider from ctx separately).
  const reported = numberOr(usage.totalTokens, NaN);
  return {
    ts: ctx.ts,
    turn: ctx.turn,
    model: message.model ?? "unknown",
    provider: message.provider ?? ctx.providerFallback,
    input,
    cacheRead,
    cacheWrite,
    output,
    totalTokens: Number.isFinite(reported) ? reported : input + cacheRead + cacheWrite + output,
    costTotal: typeof usage.cost?.total === "number" ? usage.cost.total : null,
    policy: ctx.policyTag === "" ? UNTAGGED : ctx.policyTag,
  };
}

/** Serialize a record as one JSONL line (trailing newline included). */
export function toJsonl(record: TurnRecord): string {
  return `${JSON.stringify(record)}\n`;
}

interface GroupAcc {
  turns: number; input: number; cacheRead: number; cacheWrite: number;
  output: number; totalTokens: number; cost: number; costSeen: boolean;
}

/**
 * Fold turn records into per-key totals, sorted by descending totalTokens.
 * `keyOf` returning null skips the record. Malformed entries are skipped, never
 * thrown on — a `message_end`-triggered append can be interrupted mid-line by a
 * process kill.
 */
function foldBy(
  records: ReadonlyArray<Partial<TurnRecord>>,
  keyOf: (r: Partial<TurnRecord>) => string | null,
): Array<{ key: string } & GroupAcc> {
  const acc = new Map<string, GroupAcc>();
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const key = keyOf(r);
    if (key === null) continue;
    const m = acc.get(key) ?? {
      turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, cost: 0, costSeen: false,
    };
    m.turns += 1;
    m.input += numberOr(r.input, 0);
    m.cacheRead += numberOr(r.cacheRead, 0);
    m.cacheWrite += numberOr(r.cacheWrite, 0);
    m.output += numberOr(r.output, 0);
    m.totalTokens += numberOr(r.totalTokens, 0);
    if (typeof r.costTotal === "number" && Number.isFinite(r.costTotal)) {
      m.cost += r.costTotal;
      m.costSeen = true;
    }
    acc.set(key, m);
  }
  return [...acc.entries()]
    .map(([key, m]) => ({ key, ...m }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * The provider key for the provider/tier views. Records with a model but no
 * provider bucket under "unknown" (the field is always written by buildRecord,
 * so this only covers hand-edited or foreign log lines); records with neither
 * are skipped like the model view skips model-less records.
 */
function providerKey(r: Partial<TurnRecord>): string | null {
  const provider = typeof r.provider === "string" && r.provider !== "" ? r.provider : null;
  if (provider) return provider;
  return typeof r.model === "string" && r.model !== "" ? "unknown" : null;
}

/**
 * The policy key for policy views (#521): a missing/empty tag buckets under
 * "untagged" and is NEVER skipped — unlike providerKey's null-skip convention,
 * every record (including pre-#521 lines with no `policy` field at all) must
 * appear in a policy rollup, per the spec's "absent tag renders untagged,
 * never dropped."
 */
function policyKey(r: Partial<TurnRecord>): string {
  return typeof r.policy === "string" && r.policy !== "" ? r.policy : UNTAGGED;
}

/** Fold turn records into per-policy totals, sorted by descending totalTokens. */
export function aggregateByPolicy(records: ReadonlyArray<Partial<TurnRecord>>): PolicyTotals[] {
  return foldBy(records, policyKey)
    .map(({ key, cost, costSeen, ...m }): PolicyTotals => ({
      policy: key, ...m, costTotal: costSeen ? cost : null,
    }));
}

/** Fold turn records into per-model totals, sorted by descending totalTokens. */
export function aggregateByModel(records: ReadonlyArray<Partial<TurnRecord>>): ModelTotals[] {
  return foldBy(records, (r) => (typeof r.model === "string" && r.model !== "" ? r.model : null))
    .map(({ key, cost, costSeen, ...m }): ModelTotals => ({
      model: key, ...m, costTotal: costSeen ? cost : null,
    }));
}

/** Fold turn records into per-provider totals, sorted by descending totalTokens. */
export function aggregateByProvider(records: ReadonlyArray<Partial<TurnRecord>>): ProviderTotals[] {
  return foldBy(records, providerKey)
    .map(({ key, cost, costSeen, ...m }): ProviderTotals => ({
      provider: key, ...m, costTotal: costSeen ? cost : null,
    }));
}

/**
 * Fold turn records into per-tier totals using the provider → tier map from
 * tiers.json. A provider absent from the map lands in the reserved "unmapped"
 * tier so unclassified spend is always visible, never mislabeled.
 */
export function aggregateByTier(
  records: ReadonlyArray<Partial<TurnRecord>>,
  tiers: TierMap,
): TierTotals[] {
  return foldBy(records, (r) => {
    const provider = providerKey(r);
    if (provider === null) return null;
    const tier = tiers[provider];
    return typeof tier === "string" && tier !== "" ? tier : "unmapped";
  }).map(({ key, cost, costSeen, ...m }): TierTotals => ({
    tier: key, ...m, costTotal: costSeen ? cost : null,
  }));
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const commas = (n: number): string => Math.round(n).toLocaleString("en-US");
const dollars = (c: number | null): string => (c === null ? "n/a" : `$${c.toFixed(2)}`);

/** Sum a token category and the cost across all models. */
export function grandTotals(totals: ReadonlyArray<ModelTotals>): {
  turns: number; totalTokens: number; costTotal: number | null;
} {
  let turns = 0, totalTokens = 0, cost = 0, costSeen = false;
  for (const t of totals) {
    turns += t.turns;
    totalTokens += t.totalTokens;
    if (t.costTotal !== null) { cost += t.costTotal; costSeen = true; }
  }
  return { turns, totalTokens, costTotal: costSeen ? cost : null };
}

/** One-line summary for the in-session tool's terse default. */
export function formatTerse(totals: ReadonlyArray<ModelTotals>): string {
  if (totals.length === 0) return "Session tokens: none recorded yet.";
  const g = grandTotals(totals);
  const parts = totals.map((t) => `${commas(t.totalTokens)} (${t.model})`).join(" + ");
  return `Session tokens: ${parts} = ${commas(g.totalTokens)} total · ${dollars(g.costTotal)}`;
}

/** Compact token count for the footer status: 999, 412k, 1.2M. */
function compact(n: number): string {
  const r = Math.round(n);
  if (r < 1000) return String(r);
  if (r < 1_000_000) return `${Math.round(r / 1000)}k`;
  return `${(r / 1_000_000).toFixed(1)}M`;
}

/**
 * One-segment footer status line with live whole-tree totals. Falls back to
 * the plain "on" indicator until the first record lands. Cost is omitted
 * (never rendered $0) when no turn reported one — same absence≠zero honesty
 * as the tier section.
 */
export function formatStatus(totals: ReadonlyArray<ModelTotals>): string {
  if (totals.length === 0) return "📊 token-meter: on";
  const g = grandTotals(totals);
  const models = `${totals.length} model${totals.length === 1 ? "" : "s"}`;
  const cost = g.costTotal === null ? "" : ` · ${dollars(g.costTotal)}`;
  return `📊 ${compact(g.totalTokens)} tok${cost} · ${models}`;
}

/** Multi-line per-model breakdown (verbose tool output; also the CLI reuses the shape). */
export function formatTable(totals: ReadonlyArray<ModelTotals>): string {
  if (totals.length === 0) return "No token usage recorded for this session yet.";
  const g = grandTotals(totals);
  const lines = [
    "model                       turns     input  cacheRead     output       total      cost",
  ];
  for (const t of totals) {
    lines.push(
      `${t.model.padEnd(24)}  ${String(t.turns).padStart(5)}  ${commas(t.input).padStart(8)}  ` +
      `${commas(t.cacheRead).padStart(9)}  ${commas(t.output).padStart(9)}  ` +
      `${commas(t.totalTokens).padStart(10)}  ${dollars(t.costTotal).padStart(8)}`,
    );
  }
  lines.push(`TOTAL — ${g.turns} turns, ${commas(g.totalTokens)} tokens, ${dollars(g.costTotal)}`);
  return lines.join("\n");
}

/** Shared row shape for the provider/tier breakdown sections. */
interface BreakdownRow {
  readonly name: string;
  readonly turns: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly output: number;
  readonly totalTokens: number;
  readonly costTotal: number | null;
}

function formatBreakdown(heading: string, rows: ReadonlyArray<BreakdownRow>): string {
  if (rows.length === 0) return `${heading}: none recorded yet.`;
  const lines = [
    `${heading.padEnd(24)}   turns     input  cacheRead     output       total      cost`,
  ];
  for (const r of rows) {
    lines.push(
      `${r.name.padEnd(24)}  ${String(r.turns).padStart(5)}  ${commas(r.input).padStart(8)}  ` +
      `${commas(r.cacheRead).padStart(9)}  ${commas(r.output).padStart(9)}  ` +
      `${commas(r.totalTokens).padStart(10)}  ${dollars(r.costTotal).padStart(8)}`,
    );
  }
  return lines.join("\n");
}

/** Per-provider breakdown section (verbose tool output). */
export function formatProviderSection(totals: ReadonlyArray<ProviderTotals>): string {
  return formatBreakdown("provider", totals.map((t) => ({ ...t, name: t.provider })));
}

/**
 * Per-tier breakdown section (verbose tool output). Dollar figures stay honest:
 * a tier whose turns never reported cost (typical for local models) renders
 * "n/a", never a fabricated $0 — so a frontier-vs-local comparison is
 * token-count-based unless every provider reports cost.
 */
export function formatTierSection(totals: ReadonlyArray<TierTotals>): string {
  return formatBreakdown("tier", totals.map((t) => ({ ...t, name: t.tier })));
}
