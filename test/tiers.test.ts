import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  aggregateByProvider,
  aggregateByTier,
  formatProviderSection,
  formatTierSection,
} from "../record.ts";
import { defaultTiersPath, loadTierMap } from "../state.ts";
import type { TurnRecord } from "../types.ts";

const TIERS = { anthropic: "frontier", "github-copilot": "frontier", omlx: "local" };

const RECORDS: Partial<TurnRecord>[] = [
  { model: "claude-sonnet-5", provider: "anthropic", input: 100, cacheRead: 400, cacheWrite: 0, output: 50, totalTokens: 550, costTotal: 0.02 },
  { model: "claude-sonnet-5", provider: "anthropic", input: 50, cacheRead: 200, cacheWrite: 0, output: 25, totalTokens: 275, costTotal: 0.01 },
  { model: "gpt-5-mini", provider: "github-copilot", input: 200, cacheRead: 0, cacheWrite: 0, output: 100, totalTokens: 300, costTotal: 0.03 },
  { model: "coding-workhorse", provider: "omlx", input: 400, cacheRead: 0, cacheWrite: 0, output: 200, totalTokens: 600, costTotal: null },
  { model: "mystery", provider: "acme", input: 10, cacheRead: 0, cacheWrite: 0, output: 5, totalTokens: 15, costTotal: null },
];

test("aggregateByProvider folds turns per provider, sorted by totalTokens", () => {
  const totals = aggregateByProvider(RECORDS);
  assert.deepEqual(
    totals.map((t) => [t.provider, t.turns, t.totalTokens]),
    [["anthropic", 2, 825], ["omlx", 1, 600], ["github-copilot", 1, 300], ["acme", 1, 15]],
  );
  const anthropic = totals.find((t) => t.provider === "anthropic")!;
  assert.equal(anthropic.costTotal, 0.02 + 0.01);
});

test("aggregateByProvider keeps null cost as null, never $0", () => {
  const omlx = aggregateByProvider(RECORDS).find((t) => t.provider === "omlx")!;
  assert.equal(omlx.costTotal, null);
});

test("aggregateByProvider buckets provider-less records as unknown, skips junk", () => {
  const totals = aggregateByProvider([
    { model: "m1", input: 5, totalTokens: 5 }, // provider missing → unknown
    {}, // junk (no model, no provider) → skipped, matching the model view
    { provider: "anthropic", model: "m2", totalTokens: 10 },
  ]);
  assert.deepEqual(
    totals.map((t) => [t.provider, t.turns]),
    [["anthropic", 1], ["unknown", 1]],
  );
});

test("aggregateByTier maps providers through the tier map", () => {
  const totals = aggregateByTier(RECORDS, TIERS);
  assert.deepEqual(
    totals.map((t) => [t.tier, t.turns, t.totalTokens]),
    [["frontier", 3, 1125], ["local", 1, 600], ["unmapped", 1, 15]],
  );
  const frontier = totals.find((t) => t.tier === "frontier")!;
  assert.equal(frontier.costTotal! > 0.059 && frontier.costTotal! < 0.061, true);
});

test("aggregateByTier: unlisted provider lands in unmapped; local-only cost stays null", () => {
  const totals = aggregateByTier(RECORDS, TIERS);
  assert.equal(totals.find((t) => t.tier === "local")!.costTotal, null);
  assert.equal(totals.find((t) => t.tier === "unmapped")!.costTotal, null);
});

test("aggregateByTier with an empty map puts everything in unmapped", () => {
  const totals = aggregateByTier(RECORDS, {});
  assert.deepEqual(totals.map((t) => t.tier), ["unmapped"]);
  assert.equal(totals[0].turns, 5);
});

test("formatProviderSection and formatTierSection render rows with n/a for null cost", () => {
  const provider = formatProviderSection(aggregateByProvider(RECORDS));
  assert.match(provider, /provider\s+turns/);
  assert.match(provider, /omlx\s+1\s+400\s+0\s+0\s+200\s+600\s+n\/a/); // input cacheRead cacheWrite output total
  const tier = formatTierSection(aggregateByTier(RECORDS, TIERS));
  assert.match(tier, /tier\s+turns/);
  assert.match(tier, /frontier\s+3/);
  assert.match(tier, /local\s+1\s+400\s+0\s+0\s+200\s+600\s+n\/a/); // input cacheRead cacheWrite output total
});

test("formatTierSection with no rows says none recorded", () => {
  assert.equal(formatTierSection([]), "tier: none recorded yet.");
});

test("loadTierMap reads a valid tiers.json and drops non-string entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "token-meter-tiers-"));
  try {
    const p = join(dir, "tiers.json");
    await writeFile(p, JSON.stringify({ v: 1, tiers: { omlx: "local", bad: 7, empty: "" } }), "utf8");
    assert.deepEqual(await loadTierMap(p), { omlx: "local" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadTierMap degrades to an empty map on missing or corrupt files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "token-meter-tiers-"));
  try {
    assert.deepEqual(await loadTierMap(join(dir, "absent.json")), {});
    const corrupt = join(dir, "corrupt.json");
    await writeFile(corrupt, "{not json", "utf8");
    assert.deepEqual(await loadTierMap(corrupt), {});
    const noTiers = join(dir, "no-tiers.json");
    await writeFile(noTiers, JSON.stringify({ v: 1 }), "utf8");
    assert.deepEqual(await loadTierMap(noTiers), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the committed tiers.json parses and classifies the known providers", async () => {
  const map = await loadTierMap(defaultTiersPath());
  assert.equal(map["anthropic"], "frontier");
  assert.equal(map["github-copilot"], "frontier");
  assert.equal(map["omlx"], "local");
});
