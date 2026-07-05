/**
 * token-meter/record.ts — pure turn-record construction + aggregation (no I/O).
 *
 * Side-effect-free so it unit-tests without a live pi runtime: the timestamp and
 * turn index are injected. Returns null for any non-assistant message (only
 * assistant turns carry usage).
 */

import type { AssistantMessageLike, ModelTotals, TurnRecord } from "./types.ts";

export interface RecordContext {
  readonly ts: string;
  readonly turn: number;
  /** Provider fallback when the message omits its own `provider`. */
  readonly providerFallback: string;
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
  };
}

/** Serialize a record as one JSONL line (trailing newline included). */
export function toJsonl(record: TurnRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Fold turn records into per-model totals, sorted by descending totalTokens.
 * Malformed entries (missing model / non-object) are skipped, never thrown on —
 * a `message_end`-triggered append can be interrupted mid-line by a process kill.
 */
export function aggregateByModel(records: ReadonlyArray<Partial<TurnRecord>>): ModelTotals[] {
  const acc = new Map<string, {
    turns: number; input: number; cacheRead: number; cacheWrite: number;
    output: number; totalTokens: number; cost: number; costSeen: boolean;
  }>();
  for (const r of records) {
    if (!r || typeof r.model !== "string" || r.model === "") continue;
    const m = acc.get(r.model) ?? {
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
    acc.set(r.model, m);
  }
  return [...acc.entries()]
    .map(([model, m]): ModelTotals => ({
      model,
      turns: m.turns,
      input: m.input,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      output: m.output,
      totalTokens: m.totalTokens,
      costTotal: m.costSeen ? m.cost : null,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
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
