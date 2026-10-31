import assert from "node:assert/strict";
import { logGeneratorFailure } from "../lib/social/generator-diagnostics.ts";

const envName = "EVENTZEKA_DIAGNOSTICS_TEST_SECRET";
const originalEnv = process.env[envName];
const originalError = console.error;
const calls = [];
const secret = "diagnostic-private-value-9381";
const credential = "temporary.bearer-credential_21";
try {
  process.env[envName] = secret;
  console.error = (...args) => { calls.push(args); };
  const error = new Error(`Unsupported glyph; ${secret}; Bearer ${credential};\n${"x".repeat(600)}`);
  error.name = `LayoutError-${secret}`;
  error.stack = "PRIVATE STACK MUST NEVER BE LOGGED";
  logGeneratorFailure(error, {
    format: "story", publishDate: "2026-10-20", stage: "payload/layout", page: null,
    startedAt: Date.now() - 100,
  });
  const [label, record] = calls[0];
  assert.equal(label, "[social-generator-failure]");
  assert.deepEqual(Object.keys(record), ["format", "date", "stage", "page", "elapsedMs", "errorName", "message"]);
  assert.deepEqual([record.format, record.date, record.stage, record.page], ["story", "2026-10-20", "payload/layout", null]);
  assert.ok(record.elapsedMs >= 100 && record.elapsedMs < 10_000);
  assert.ok(record.message.length <= 384 && record.errorName.length <= 64);
  assert.match(record.message, /Unsupported glyph/);
  assert.match(record.message, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(record.message, /[\r\n\t]/);
  assert.ok(!JSON.stringify(calls).includes(secret));
  assert.ok(!JSON.stringify(calls).includes(credential));
  assert.ok(!JSON.stringify(calls).includes("PRIVATE STACK"));

  logGeneratorFailure({ message: secret, headers: { authorization: credential } }, {
    format: "carousel", publishDate: "2026-10-21", stage: "query", page: 3, startedAt: Date.now(),
  });
  assert.equal(calls[1][1].errorName, "UnknownError");
  assert.equal(calls[1][1].message, "Non-Error generator failure.");
  assert.equal(calls[1][1].page, 3);
  assert.ok(!JSON.stringify(calls).includes(secret));
  assert.ok(!JSON.stringify(calls).includes(credential));
} finally {
  console.error = originalError;
  if (originalEnv === undefined) delete process.env[envName];
  else process.env[envName] = originalEnv;
}
console.log("Generator diagnostics: context, bounded output, secret/Bearer redaction, and no stack/object logging passed.");
