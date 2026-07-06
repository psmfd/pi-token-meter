import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendTurn, readSession, safeSessionKey, sessionLogPath } from "../state.ts";
import type { TurnRecord } from "../types.ts";

const rec = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  ts: "2026-07-04T00:00:00.000Z", turn: 1, model: "m", provider: "p",
  input: 10, cacheRead: 20, cacheWrite: 0, output: 5, totalTokens: 35, costTotal: 0.01, policy: "untagged", ...over,
});

test("safeSessionKey strips directory parts and rejects traversal", () => {
  assert.equal(safeSessionKey("abc123"), "abc123");
  assert.equal(safeSessionKey("../../etc/passwd"), "passwd"); // basename only
  assert.equal(safeSessionKey("/a/b/c"), "c");
  assert.equal(safeSessionKey(".."), "unknown-session");
  assert.equal(safeSessionKey("."), "unknown-session");
  assert.equal(safeSessionKey(""), "unknown-session");
  assert.equal(safeSessionKey(undefined), "unknown-session");
});

test("sessionLogPath places a sanitized per-session file under the sessions dir", () => {
  const p = sessionLogPath("../evil", "/tmp/agent");
  assert.equal(p, join("/tmp/agent", "extensions", "token-meter", "sessions", "evil.jsonl"));
});

test("appendTurn creates the dir and readSession round-trips", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "token-meter-"));
  await appendTurn("sessA", rec({ model: "sonnet", turn: 1 }), dir);
  await appendTurn("sessA", rec({ model: "haiku", turn: 2 }), dir);
  const rows = await readSession("sessA", dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].model, "sonnet");
  assert.equal(rows[1].model, "haiku");
});

test("readSession returns [] for an unknown session", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "token-meter-"));
  assert.deepEqual(await readSession("nope", dir), []);
});

test("readSession skips a corrupt/partial trailing line, never throws", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "token-meter-"));
  await appendTurn("s", rec(), dir);
  // Simulate a process kill mid-append: a partial JSON line with no newline.
  await fs.appendFile(sessionLogPath("s", dir), '{"ts":"x","model":"m","inp', "utf8");
  const rows = await readSession("s", dir);
  assert.equal(rows.length, 1); // the one good line; the partial line skipped
});
