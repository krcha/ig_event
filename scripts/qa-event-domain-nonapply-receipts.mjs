import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const operatorPath = join(repositoryRoot, "scripts/event-domain-rollout-operator.mjs");
const operatorSource = await readFile(operatorPath, "utf8");
assert.equal(operatorSource.match(/^await main\(\);$/gmu)?.length, 1);

// Execute the actual initializer/parser/writer, not a rewritten receipt model.
// Only automatic main() is removed and test exports are appended in memory.
// This is private-filesystem QA, not a CLI/database/production rollout test.
const exposedSource = operatorSource.replace(/^await main\(\);$/mu, `
export { parseArgs, initializeReceipt, writeReceipt, CUTOVER_CONFIRMATIONS };
`);
const savedSpawn = childProcess.spawn;
const savedFetch = globalThis.fetch;
let forbiddenServiceCalls = 0;
const rejectServiceCall = () => {
  forbiddenServiceCalls += 1;
  throw new Error("Receipt initialization must not invoke a service or CLI.");
};
childProcess.spawn = rejectServiceCall;
globalThis.fetch = rejectServiceCall;
syncBuiltinESMExports();

const qaRoot = await mkdtemp(join(tmpdir(), "event-zeka-nonapply-receipts-"));
await chmod(qaRoot, 0o700);
const counts = { freshNonapply: 0, resumedNonapply: 0, applyMetadata: 0,
  resumedApply: 0, rejectedNonapplyFlags: 0, rejectedApplyFences: 0,
  rejectedResumeChanges: 0 };

try {
  const operator = await import(
    `data:text/javascript;base64,${Buffer.from(exposedSource).toString("base64")}`
  );
  const families = Object.entries(operator.CUTOVER_CONFIRMATIONS);
  assert.deepEqual(families.map(([workflow]) => workflow).sort(), [
    "saved-read-cutover", "saved-write-cutover", "saved-cutover-rollback",
    "publication-read-cutover", "publication-cutover-rollback",
    "reconciliation-disable", "reconciliation-abandon",
    "reconciliation-authorize", "reconciliation-ingestion-enable",
  ].sort());
  const envFile = join(qaRoot, "synthetic.env");
  await writeFile(envFile, "CONVEX_SELF_HOSTED_URL=http://127.0.0.1:1\nCONVEX_SELF_HOSTED_ADMIN_KEY=qa-noncredential\n", { mode: 0o600 });
  const target = { actualUrl: "http://127.0.0.1:1",
    originDigestSha256: "a".repeat(64), envFileDigestSha256: "b".repeat(64) };
  const binary = { digestSha256: "c".repeat(64) };
  const baseArgs = (receiptDir, workflow) => [
    "--env-file", envFile, "--expected-url", target.actualUrl,
    "--receipt-dir", receiptDir, "--workflow", workflow,
  ];
  const context = (options, initialized) => ({ options, target,
    convexBinary: binary, secrets: ["qa-noncredential"], ...initialized });
  const persist = async (options, initialized) => {
    await operator.writeReceipt(context(options, initialized));
    const file = await stat(initialized.receiptPath);
    const directory = await stat(options.receiptDir);
    assert.equal(file.mode & 0o777, 0o600);
    assert.equal(directory.mode & 0o777, 0o700);
    assert.deepEqual(await readdir(options.receiptDir), [
      initialized.receiptPath.slice(options.receiptDir.length + 1),
    ]);
    const receipt = JSON.parse(await readFile(initialized.receiptPath, "utf8"));
    assert.equal(receipt.status, "running");
    assert.deepEqual(receipt.commands, []);
    assert.deepEqual(receipt.gates, []);
    return receipt;
  };
  const rejectsResume = async (options) => {
    await assert.rejects(operator.initializeReceipt(options, target, binary, null),
      (error) => error.code === "E_RESUME");
    counts.rejectedResumeChanges += 1;
  };

  for (const [workflow, confirmation] of families) {
    for (const mode of ["preview", "status"]) {
      const receiptDir = join(qaRoot, `${workflow}-${mode}`);
      const args = [mode, ...baseArgs(receiptDir, workflow)];
      const options = operator.parseArgs(args);
      assert.equal(options.note, undefined);
      assert.equal(options.operator, undefined);
      const fresh = await operator.initializeReceipt(options, target, binary, null);
      assert.equal(Object.hasOwn(fresh.receipt, "review"), false);
      assert.equal(Object.hasOwn(fresh.receipt, "reviewedStatusReceipt"), false);
      const first = await persist(options, fresh);
      counts.freshNonapply += 1;

      const resumeOptions = operator.parseArgs([...args, "--resume", fresh.receiptPath]);
      const resumed = await operator.initializeReceipt(resumeOptions, target, binary, null);
      const second = await persist(resumeOptions, resumed);
      assert.equal(second.runId, first.runId);
      assert.equal(second.resumeCount, 1);
      assert.equal(Object.hasOwn(second, "review"), false);
      counts.resumedNonapply += 1;
      for (const [flag, value] of [["--note", "not an authorization"],
        ["--operator", "qa-operator"], ["--confirm", confirmation],
        ["--expected-state-updated-at", "42"]]) {
        assert.throws(() => operator.parseArgs([...args, flag, value]),
          (error) => error.code === "E_ARGS");
        counts.rejectedNonapplyFlags += 1;
      }
      await rejectsResume({ ...resumeOptions, maxPages: options.maxPages + 1 });
      resumed.receipt.review = { noteDigestSha256: "d".repeat(64), operator: "invented" };
      await persist(resumeOptions, resumed);
      await rejectsResume(resumeOptions);
    }

    const receiptDir = join(qaRoot, `${workflow}-apply`);
    const reviewArgs = ["--confirm", confirmation, "--expected-state-updated-at", "42",
      "--operator", "  qa-reviewer  ", "--note", "  QA explicitly reviews this transition.  "];
    if (workflow.startsWith("reconciliation-")) {
      reviewArgs.push("--expected-evidence-digest", "d".repeat(64),
        "--expected-verification-run-id", "synthetic-verification-run");
    }
    if (["reconciliation-authorize", "reconciliation-ingestion-enable"].includes(workflow)) {
      reviewArgs.push("--reviewed-status-receipt", join(qaRoot, "synthetic-status.json"));
    }
    const args = ["apply", ...baseArgs(receiptDir, workflow), ...reviewArgs];
    const options = operator.parseArgs(args);
    const fresh = await operator.initializeReceipt(options, target, binary, null);
    const expectedReview = {
      expectedStateUpdatedAt: 42,
      expectedEvidenceDigest: options.expectedEvidenceDigest ?? null,
      expectedVerificationRunId: options.expectedVerificationRunId ?? null,
      reviewedStatusReceiptDigestSha256: null,
      noteDigestSha256: createHash("sha256").update(options.note).digest("hex"),
      operator: "qa-reviewer",
    };
    assert.deepEqual(fresh.receipt.review, expectedReview);
    await persist(options, fresh);
    counts.applyMetadata += 1;
    const resumeOptions = operator.parseArgs([...args, "--resume", fresh.receiptPath]);
    const resumed = await operator.initializeReceipt(resumeOptions, target, binary, null);
    const second = await persist(resumeOptions, resumed);
    assert.deepEqual(second.review, expectedReview);
    assert.equal(second.resumeCount, 1);
    counts.resumedApply += 1;
    await rejectsResume({ ...resumeOptions, note: `${options.note} Changed.` });
    await rejectsResume({ ...resumeOptions, operator: "another-reviewer" });
    await rejectsResume({ ...resumeOptions, expectedStateUpdatedAt: 43 });
    await rejectsResume({ ...resumeOptions, mode: "preview" });
    for (const flag of ["--confirm", "--expected-state-updated-at", "--operator", "--note"]) {
      const removed = [...args];
      removed.splice(removed.indexOf(flag), 2);
      assert.throws(() => operator.parseArgs(removed), (error) =>
        error.code === (flag === "--confirm" ? "E_CONFIRMATION" : "E_ARGS"));
      counts.rejectedApplyFences += 1;
    }
    const wrongConfirmation = [...args];
    wrongConfirmation[wrongConfirmation.indexOf("--confirm") + 1] = "WRONG_CONFIRMATION";
    assert.throws(() => operator.parseArgs(wrongConfirmation),
      (error) => error.code === "E_CONFIRMATION");
    counts.rejectedApplyFences += 1;
  }
  assert.equal(forbiddenServiceCalls, 0);
  assert.deepEqual(counts, { freshNonapply: 18, resumedNonapply: 18,
    applyMetadata: 9, resumedApply: 9, rejectedNonapplyFlags: 72,
    rejectedApplyFences: 45, rejectedResumeChanges: 72 });
  console.log(JSON.stringify({ status: "passed", workflows: families.length, ...counts,
    serviceCalls: forbiddenServiceCalls, modelLimit:
      "Actual parser/initializer/writer on synthetic private files; no CLI, database transaction, or production recovery exercised." }));
} catch (error) {
  console.error(`Nonapply receipt QA failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  childProcess.spawn = savedSpawn;
  globalThis.fetch = savedFetch;
  syncBuiltinESMExports();
  await rm(qaRoot, { recursive: true, force: true });
}
