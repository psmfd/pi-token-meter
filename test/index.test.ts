/**
 * token-meter — extension-wiring tests for the env-propagation invariant (#807).
 *
 * The regression under test: the policy-tag env write must NOT run when
 * token-meter is disabled ("inert by default" — ADR-0073). It rides propagate()
 * (the enabled-only stamp) alongside TOKEN_METER_ENABLED/TOKEN_METER_SESSION.
 *
 * Hermetic: HOME is redirected to an empty temp dir so readSettingsEnabled()
 * (reads ~/.pi/agent/settings.json) resolves to `false` regardless of the
 * operator's real settings; all TOKEN_METER_* env vars are saved and restored.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import tokenMeter from "../index.ts";
import { UNTAGGED } from "../record.ts";

const ENV_ENABLED = "TOKEN_METER_ENABLED";
const ENV_SESSION = "TOKEN_METER_SESSION";
const ENV_POLICY_TAG = "TOKEN_METER_POLICY_TAG";
const TOUCHED = [ENV_ENABLED, ENV_SESSION, ENV_POLICY_TAG, "HOME"] as const;

interface SessionStartHandler {
  (event: unknown, ctx: unknown): Promise<void> | void;
}

// Fake pi capturing the session_start handler and the token-meter flag value.
function loadExtension(flagValue: boolean): {
  fireSessionStart: (hasUI?: boolean) => Promise<void>;
} {
  const handlers: Record<string, SessionStartHandler> = {};
  const pi = {
    registerFlag() {},
    registerCommand() {},
    registerTool() {},
    getFlag: (name: string) => (name === "token-meter" ? flagValue : undefined),
    on(event: string, handler: SessionStartHandler) {
      handlers[event] = handler;
    },
  };
  tokenMeter(pi as never);
  const handler = handlers["session_start"];
  if (!handler) throw new Error("session_start handler was not registered");
  return {
    fireSessionStart: async (hasUI = false) => {
      const ctx = {
        hasUI,
        sessionManager: { getSessionId: () => "test-session" },
      };
      await handler(undefined, ctx);
    },
  };
}

const saved: Record<string, string | undefined> = {};
let tmpHome: string;

beforeEach(() => {
  for (const k of TOUCHED) saved[k] = process.env[k];
  for (const k of TOUCHED) delete process.env[k];
  tmpHome = mkdtempSync(join(tmpdir(), "token-meter-home-"));
  process.env.HOME = tmpHome; // os.homedir() → empty dir → no settings.json
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

test("disabled load + session_start writes NOTHING to the environment (#807)", async () => {
  const ext = loadExtension(false); // flag off, no ENV_ENABLED, no settings
  await ext.fireSessionStart();
  assert.equal(
    process.env[ENV_POLICY_TAG],
    undefined,
    "policy tag must not be written when disabled",
  );
  assert.equal(process.env[ENV_ENABLED], undefined);
  assert.equal(process.env[ENV_SESSION], undefined);
});

test("enabled via flag stamps the policy tag (and enablement) on the enabled path", async () => {
  const ext = loadExtension(true); // /token-meter flag on
  await ext.fireSessionStart();
  assert.equal(process.env[ENV_POLICY_TAG], UNTAGGED);
  assert.equal(process.env[ENV_ENABLED], "1");
  assert.equal(process.env[ENV_SESSION], "test-session");
});

test("an enabled child preserves the inherited policy-tag literal", async () => {
  // Child process: root exported ENABLED=1 and a concrete tag. propagate() must
  // re-stamp the same literal so the whole descendant tree stays consistent.
  process.env[ENV_ENABLED] = "1";
  process.env[ENV_POLICY_TAG] = "mixed-local";
  const ext = loadExtension(false);
  await ext.fireSessionStart();
  assert.equal(process.env[ENV_POLICY_TAG], "mixed-local");
  assert.equal(process.env[ENV_ENABLED], "1");
});
