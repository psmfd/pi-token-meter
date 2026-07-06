/**
 * token-meter/types.ts — structural shapes for per-session token accounting.
 *
 * The recorder reads the per-turn token `usage` pi attaches to assistant
 * messages on `message_end` (same fields cache-meter reads, verified against pi
 * v0.79.0). `usage.input` is FRESH (uncached) input only, so a turn's raw token
 * movement is `input + cacheRead + cacheWrite + output`. Cached input is priced
 * ~10x below fresh, so the breakdown is kept — never collapsed to one scalar.
 */

/** The per-turn token usage pi exposes on an assistant message. */
export interface MessageUsage {
  /** Fresh (uncached) input tokens. */
  readonly input?: number;
  readonly output?: number;
  /** Tokens served from the provider prompt cache. */
  readonly cacheRead?: number;
  /** Tokens written to the provider prompt cache (one-time warm cost). */
  readonly cacheWrite?: number;
  /** Provider-reported total for the turn, when present. */
  readonly totalTokens?: number;
  /** Realized dollar cost for this message; `total` is the sum. */
  readonly cost?: { readonly total?: number };
}

/** The slice of an assistant message the recorder reads. */
export interface AssistantMessageLike {
  readonly role: string;
  readonly model?: string;
  /** Message-level provider (read atomically with `model`, not from ctx). */
  readonly provider?: string;
  readonly usage?: MessageUsage;
}

/** One JSONL record appended per assistant turn. */
export interface TurnRecord {
  /** ISO-8601 UTC timestamp. */
  readonly ts: string;
  /** 1-based assistant-turn index within this process. */
  readonly turn: number;
  readonly model: string;
  readonly provider: string;
  /** Fresh input tokens (`usage.input`). */
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  /** Provider-reported total, or the sum of the four components when absent. */
  readonly totalTokens: number;
  /** Realized cost for the turn, or null when the provider omits it. */
  readonly costTotal: number | null;
  /**
   * Routing-policy tag (#521): the operator's A/B label from
   * TOKEN_METER_POLICY_TAG, normalized to "untagged" when unset. Distinct from
   * auto-router's candidate-selection policy — this is a session-scoped
   * measurement label, nothing routes on it.
   */
  readonly policy: string;
}

/** Per-model aggregate the reader/tool derives from the per-turn log. */
export interface ModelTotals {
  readonly model: string;
  readonly turns: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly totalTokens: number;
  /** Sum of realized cost across turns that reported it (null if none did). */
  readonly costTotal: number | null;
}

/**
 * Provider → tier classification, from the committed `tiers.json` next to the
 * extension (`{v:1, tiers:{...}}`). A provider absent from the map aggregates
 * under the reserved tier `"unmapped"` — never silently bucketed into a real
 * tier, so an unclassified provider is visible in every rollup.
 */
export interface TierMap {
  readonly [provider: string]: string;
}

/** Per-provider aggregate derived from the per-turn log. */
export interface ProviderTotals {
  readonly provider: string;
  readonly turns: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly totalTokens: number;
  /** Sum of realized cost across turns that reported it (null if none did). */
  readonly costTotal: number | null;
}

/** Per-policy (routing-policy tag / "untagged") aggregate derived from the per-turn log. */
export interface PolicyTotals {
  readonly policy: string;
  readonly turns: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly totalTokens: number;
  /** Sum of realized cost across turns that reported it (null if none did). */
  readonly costTotal: number | null;
}

/** Per-tier (frontier / local / unmapped) aggregate derived from the per-turn log. */
export interface TierTotals {
  readonly tier: string;
  readonly turns: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly totalTokens: number;
  /** Sum of realized cost across turns that reported it (null if none did). */
  readonly costTotal: number | null;
}
