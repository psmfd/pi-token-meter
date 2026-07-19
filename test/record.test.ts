import assert from "node:assert/strict";
import { test } from "node:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  aggregateByModel,
  aggregateByPolicy,
  buildRecord,
  formatStatus,
  formatTable,
  formatTerse,
  grandTotals,
  toJsonl,
  UNTAGGED,
} from "../record.ts";
import type { AssistantMessageLike, TurnRecord } from "../types.ts";

const CTX = { ts: "2026-07-04T00:00:00.000Z", turn: 3, providerFallback: "anthropic", policyTag: "untagged" };

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
    policy: "untagged",
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

test("formatStatus renders the plain indicator, compact totals, and honest cost absence", () => {
  assert.equal(formatStatus([]), "📊 token-meter: on");
  const one = aggregateByModel([{ model: "sonnet", totalTokens: 412_345, input: 800, cacheRead: 4000, output: 300, costTotal: 1.234 }]);
  assert.equal(formatStatus(one), "📊 412k tok · $1.23 · 1 model");
  const two = aggregateByModel([
    { model: "sonnet", totalTokens: 900_000, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costTotal: null },
    { model: "haiku", totalTokens: 300_000, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costTotal: null },
  ]);
  // No turn reported cost → the dollar segment is omitted, never $0.00.
  assert.equal(formatStatus(two), "📊 1.2M tok · 2 models");
  const small = aggregateByModel([{ model: "m", totalTokens: 999, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costTotal: null }]);
  assert.equal(formatStatus(small), "📊 999 tok · 1 model");
});

test("toJsonl appends a trailing newline", () => {
  assert.ok(toJsonl({ ts: "t", turn: 1, model: "m", provider: "p", input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, costTotal: null, policy: "untagged" }).endsWith("\n"));
});

// --- #521: routing-policy tag ------------------------------------------------

test("buildRecord stamps the policy tag and normalizes empty to UNTAGGED (#521)", () => {
  const msg = { role: "assistant", model: "m", provider: "p" };
  assert.equal(buildRecord(msg, { ...CTX, policyTag: "mixed-local" })!.policy, "mixed-local");
  assert.equal(buildRecord(msg, { ...CTX, policyTag: "" })!.policy, UNTAGGED);
});

test("aggregateByPolicy buckets records with no policy field as untagged — never dropped (#521)", () => {
  const rows = aggregateByPolicy([
    { model: "a", provider: "p", totalTokens: 100, input: 80, cacheRead: 0, cacheWrite: 0, output: 20, costTotal: 0.1, policy: "mixed-local" },
    { model: "b", provider: "p", totalTokens: 50, input: 40, cacheRead: 0, cacheWrite: 0, output: 10, costTotal: null, policy: "mixed-local" },
    // pre-#521 log line: no policy key at all
    { model: "c", provider: "p", totalTokens: 30, input: 20, cacheRead: 0, cacheWrite: 0, output: 10, costTotal: null },
  ]);
  assert.equal(rows.length, 2);
  const tagged = rows.find((r) => r.policy === "mixed-local")!;
  assert.equal(tagged.turns, 2);
  assert.equal(tagged.totalTokens, 150);
  const untagged = rows.find((r) => r.policy === UNTAGGED)!;
  assert.equal(untagged.turns, 1);
  assert.equal(untagged.totalTokens, 30);
});

test("UNTAGGED sentinel is in lockstep with the jq default in scripts/token-meter.sh (#521)", () => {
  // A drift here silently splits pre-#521 and untagged records into two CLI
  // buckets — assert the literal appears in the script's jq program.
  const script = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "scripts", "token-meter.sh"), "utf8");
  assert.ok(script.includes(`"${UNTAGGED}"`), "token-meter.sh must default missing .policy to the UNTAGGED literal");
});
