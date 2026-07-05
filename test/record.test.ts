import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateByModel,
  buildRecord,
  formatTable,
  formatTerse,
  grandTotals,
  toJsonl,
} from "../record.ts";
import type { AssistantMessageLike, TurnRecord } from "../types.ts";

const CTX = { ts: "2026-07-04T00:00:00.000Z", turn: 3, providerFallback: "anthropic" };

test("buildRecord returns null for non-assistant messages", () => {
  assert.equal(buildRecord({ role: "user" }, CTX), null);
  assert.equal(buildRecord({ role: "toolResult" }, CTX), null);
  assert.equal(buildRecord(undefined, CTX), null);
});

test("buildRecord reads model + provider atomically from the message", () => {
  const msg: AssistantMessageLike = {
    role: "assistant",
    model: "claude-sonnet-5",
    provider: "anthropic",
    usage: { input: 812, output: 340, cacheRead: 4200, cacheWrite: 0, totalTokens: 5352, cost: { total: 0.0193 } },
  };
  assert.deepEqual(buildRecord(msg, CTX), {
    ts: CTX.ts, turn: 3, model: "claude-sonnet-5", provider: "anthropic",
    input: 812, cacheRead: 4200, cacheWrite: 0, output: 340, totalTokens: 5352, costTotal: 0.0193,
  });
});

test("buildRecord falls back to ctx provider and computes totalTokens when absent", () => {
  const msg: AssistantMessageLike = {
    role: "assistant", model: "gpt-x",
    usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
  };
  const r = buildRecord(msg, CTX)!;
  assert.equal(r.provider, "anthropic"); // fallback (message.provider absent)
  assert.equal(r.totalTokens, 165); // 100 + 10 + 5 + 50
  assert.equal(r.costTotal, null); // cost absent ≠ 0
});

test("buildRecord coerces NaN/Infinity/absent token fields to 0", () => {
  const r = buildRecord({ role: "assistant", model: "m", usage: { input: NaN, output: Infinity } as never }, CTX)!;
  assert.equal(r.input, 0);
  assert.equal(r.output, 0);
});

test("aggregateByModel groups per model, sums, and sorts by totalTokens desc", () => {
  const rows: Partial<TurnRecord>[] = [
    { model: "haiku", input: 100, cacheRead: 0, cacheWrite: 0, output: 50, totalTokens: 150, costTotal: 0.01 },
    { model: "sonnet", input: 800, cacheRead: 4000, cacheWrite: 0, output: 300, totalTokens: 5100, costTotal: 0.1 },
    { model: "haiku", input: 200, cacheRead: 0, cacheWrite: 0, output: 60, totalTokens: 260, costTotal: null },
  ];
  const t = aggregateByModel(rows);
  assert.equal(t.length, 2);
  assert.equal(t[0].model, "sonnet"); // higher totalTokens first
  assert.equal(t[1].model, "haiku");
  assert.equal(t[1].turns, 2);
  assert.equal(t[1].totalTokens, 410);
  assert.equal(t[1].costTotal, 0.01); // one turn had cost, one null → sum of the reported one
});

test("aggregateByModel skips malformed rows (no model)", () => {
  const t = aggregateByModel([{ input: 5 } as Partial<TurnRecord>, { model: "", output: 3 }, { model: "m", output: 1 }]);
  assert.equal(t.length, 1);
  assert.equal(t[0].model, "m");
});

test("grandTotals returns null cost only when no model reported cost", () => {
  assert.equal(grandTotals([{ model: "m", turns: 1, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 1, costTotal: null }]).costTotal, null);
});

test("formatTerse and formatTable render totals; empty states are handled", () => {
  assert.match(formatTerse([]), /none recorded/i);
  assert.match(formatTable([]), /No token usage/i);
  const rows = aggregateByModel([{ model: "sonnet", totalTokens: 5100, input: 800, cacheRead: 4000, output: 300, costTotal: 0.1 }]);
  assert.match(formatTerse(rows), /5,100 \(sonnet\).*\$0\.10/);
  assert.match(formatTable(rows), /TOTAL — 1 turns, 5,100 tokens, \$0\.10/);
});

test("toJsonl appends a trailing newline", () => {
  assert.ok(toJsonl({ ts: "t", turn: 1, model: "m", provider: "p", input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, costTotal: null }).endsWith("\n"));
});
