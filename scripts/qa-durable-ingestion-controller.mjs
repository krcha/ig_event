import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DURABLE_INGESTION_CANARY_SIZE,
  DURABLE_INGESTION_FULL_PROFILE_BUDGET_MICROS,
  durableControlsFor,
  selectDeterministicCanary,
} from "../lib/pipeline/durable-ingestion-controller.ts";

const controller = readFileSync("convex/durableIngestionRuns.ts", "utf8");
const schema = readFileSync("convex/schema.ts", "utf8");
const executor = readFileSync("app/api/cron/durable-ingestion/execute/route.ts", "utf8");
const launcher = readFileSync("scripts/ig-event-durable-runner", "utf8");
const dailyRoute = readFileSync("app/api/cron/durable-ingestion/daily/route.ts", "utf8");
const dailyLauncher = readFileSync("scripts/ig-event-durable-daily-runner", "utf8");
const dailyService = readFileSync("ops/systemd/ig-event-durable-daily.service", "utf8");
const dailyTimer = readFileSync("ops/systemd/ig-event-durable-daily.timer", "utf8");
const ingestionPipeline = readFileSync("lib/pipeline/run-instagram-ingestion.ts", "utf8");

const handles = Array.from({ length: 632 }, (_, index) => `venue_${String(index).padStart(3, "0")}`);
const canary = selectDeterministicCanary(handles);
assert.equal(canary.length, DURABLE_INGESTION_CANARY_SIZE);
assert.equal(new Set(canary).size, DURABLE_INGESTION_CANARY_SIZE);
assert.deepEqual(canary, selectDeterministicCanary([...handles].reverse()));

assert.equal(durableControlsFor("canary").budgetMicros, 160_000);
assert.equal(durableControlsFor("daily").daysBack, 1);
assert.equal(durableControlsFor("catch_up").daysBack, undefined);
assert.equal(durableControlsFor("catch_up").budgetMicros, DURABLE_INGESTION_FULL_PROFILE_BUDGET_MICROS);
assert.ok(632 * durableControlsFor("catch_up").costPerProfileMicros <= durableControlsFor("catch_up").budgetMicros);

for (const required of ["terminalReceiptCount", "lease_expired_requeued", "Another durable ingestion run is already active", "concurrency"]) {
  assert.match(controller, new RegExp(required), `controller must retain ${required}`);
}
for (const required of [
  "ingestionRuns",
  "ingestionDailySnapshots",
  "ingestionRunChunks",
  "ingestionRunHandleReceipts",
  "by_mode_dailyDayKey",
  "by_status_dayKey",
  "by_run_handle",
]) {
  assert.match(schema, new RegExp(required), `schema must retain ${required}`);
}
assert.match(executor, /noAgeCutoff/);
assert.match(executor, /skipPinnedPosts/);
assert.match(executor, /ignoreCheckpoint/);
assert.match(executor, /ignoreCooldown/);
assert.match(executor, /legacy singleton paid-fetch lease/);
assert.match(executor, /persistScrapedPostsForHandle/);
assert.match(executor, /provider_completed_without_post/);
assert.match(executor, /markReceiptProviderAttemptStarted/);
assert.match(executor, /outcome: "deferred"/);
assert.match(executor, /alreadyFetched/, "a resumed receipt must not repeat its paid provider request");
assert.match(executor, /provider_attempt_persistence_unconfirmed/, "a charged but unpersisted provider result must never be reported as fetched");
assert.match(executor, /markPostsPersisted/, "the route must confirm persistence after saving provider posts");
assert.match(executor, /claimProcessing/, "the existing route must drive the durable single AI consumer");
assert.match(executor, /processSavedScrapedPostForDurableReceipt/, "AI work must target the receipt-linked post, not a handle backlog page");
assert.match(executor, /processingPending: !released\.terminal/, "busy AI processing must remain an explicit nonterminal retry");
assert.match(executor, /retryAfterMs: 30_000/, "busy AI processing must back off instead of hot-looping");
assert.doesNotMatch(executor, /runInstagramIngestion\(/, "the durable route must not process an unrelated saved-post page");
assert.match(controller, /providerAttemptCount/);
assert.match(controller, /providerResultStatus/, "controller receipts must distinguish a charge from persisted source data");
assert.match(controller, /processing_pending/, "persisted posts need an explicit nonterminal AI queue state");
assert.match(controller, /scrapedPostId/, "the selected saved post must be tied to its original receipt");
const activeSemaphoreOffset = controller.indexOf("const activeCandidates = await ctx.db");
assert.ok(activeSemaphoreOffset >= 0, "the AI queue must retain its indexed active-consumer semaphore");
const activeSemaphore = controller.slice(activeSemaphoreOffset, activeSemaphoreOffset + 1_100);
assert.match(activeSemaphore, /withIndex\("by_run_status"/, "the active semaphore must stay run/status indexed");
assert.match(activeSemaphore, /\.take\(run\.selectedHandleCount \+ 1\)/, "the active semaphore must remain bounded");
assert.doesNotMatch(activeSemaphore, /\.collect\(/, "the active semaphore must never collect the run receipt table");
assert.match(activeSemaphore, /for \(const activeReceipt of activeCandidates\)/, "the active semaphore must inspect every bounded candidate");
assert.match(activeSemaphore, /\(activeReceipt\.leaseExpiresAt \?\? 0\) <= now/, "only expired leases may bypass the normal active-receipt block");
assert.match(
  activeSemaphore,
  /hasDedicatedLegacyDefinitiveOutputRecoveryMarker/,
  "only an allowlisted reserved recovery marker with an expired lease may bypass an active receipt",
);
assert.match(activeSemaphore, /if \(!isExpiredDedicatedRecovery\) return null/, "all live or ordinary processing receipts must still block a second consumer");
const genericProcessingClaimOffset = controller.indexOf(
  "export const claimNextProcessingReceipt",
);
const dedicatedProcessingClaimOffset = controller.indexOf(
  "export const claimLegacyDefinitiveOutputRecoveryReceipt",
);
assert.ok(
  genericProcessingClaimOffset >= 0 &&
    dedicatedProcessingClaimOffset > genericProcessingClaimOffset,
  "generic and dedicated processing claims must both remain exported",
);
const genericProcessingClaim = controller.slice(
  genericProcessingClaimOffset,
  dedicatedProcessingClaimOffset,
);
assert.equal(
  (
    genericProcessingClaim.match(
      /hasDedicatedLegacyDefinitiveOutputRecoveryMarker/g,
    ) ?? []
  ).length,
  5,
  "every generic recovery skip path must use the broad fail-closed reservation marker",
);
assert.doesNotMatch(
  genericProcessingClaim,
  /isDedicatedLegacyDefinitiveOutputRecoveryReceipt/,
  "the generic consumer must not release a malformed reserved row into AI processing",
);
const dedicatedProcessingClaim = controller.slice(
  dedicatedProcessingClaimOffset,
  controller.indexOf(
    "export const releaseProcessingReceiptForRetry",
    dedicatedProcessingClaimOffset,
  ),
);
assert.match(
  dedicatedProcessingClaim,
  /isDedicatedLegacyDefinitiveOutputRecoveryReceipt/,
  "the dedicated claimant must require the exact recovery provenance fence",
);
assert.match(controller, /by_run_status_executionSlot_retryNotBeforeAt/, "receipt retries must be queryable inside a fixed worker lane without scanning all run rows");
assert.match(controller, /preserveAttempt/, "waiting for an AI lease must not consume the receipt retry limit");
assert.match(controller, /Selected profiles exceed this run's frozen budget/);
assert.match(controller, /markReceiptProviderAttemptStarted/);
assert.match(executor, /complete: state\?\.complete/, "workers must distinguish completion from a busy lease after restart");
assert.match(launcher, /for slot in \{0\.\.5\}/);
assert.match(launcher, /pids=\(\)/, "runner must track every worker PID");
assert.match(launcher, /for pid in "\$\{pids\[@\]\}"/, "runner must wait for every worker");
assert.match(
  launcher,
  /runner_exit_status="\$failed"[\s\S]*exit "\$runner_exit_status"/,
  "a worker failure must reach systemd after cleanup",
);
const retryDeferredOffset = launcher.indexOf(`'"retryDeferred":true'`);
assert.ok(retryDeferredOffset >= 0, "runner must recognize a durably deferred executor response");
assert.match(
  launcher.slice(retryDeferredOffset, retryDeferredOffset + 700),
  /back_off[\s\S]*continue/,
  "runner must back off a deferred lane without restarting all workers",
);
assert.match(launcher, /--config "\$config_file"/, "runner must keep the bearer token out of curl argv");
assert.doesNotMatch(launcher, /curl[^\n]*Authorization/, "runner must never pass the bearer token in curl argv");
assert.match(launcher, /5\|6\|7\|18\|28\|35\|47\|52\|55\|56\|92/);
assert.match(launcher, /408\|425\|429\|5\[0-9\]\[0-9\]/);
assert.match(launcher, /retry_delay_seconds=60/, "transient transport backoff must be capped at 60 seconds");
assert.match(launcher, /kill -USR1 "\$RUNNER_PARENT_PID"/, "a fatal lane must notify its supervisor");
for (const reason of ["lease_expired_retry_limit", "retry_limit"]) {
  const offset = controller.indexOf(reason);
  assert.ok(offset >= 0, `missing ${reason} terminal branch`);
  const branch = controller.slice(Math.max(0, offset - 700), offset + 700);
  assert.match(branch, /finishRunIfTerminal/);
}
assert.match(controller, /MAX_HANDLES_PER_CHUNK = 1/);
assert.match(controller, /activeInLane/);
assert.match(launcher, /"complete":true/, "busy workers must wait rather than treat an active lease as completion");
assert.match(dailyRoute, /mode: "daily"/);
assert.match(dailyRoute, /durableIngestionRuns:queueDailyRun/);
assert.match(dailyRoute, /followUpRequired/);
assert.match(dailyRoute, /executeRequired/);
assert.match(dailyRoute, /getActiveVenueHandles/);
assert.match(ingestionPipeline, /listLegacyVenueHandlesPageQuery/, "active snapshots must include scrape-active legacy venues");
assert.match(ingestionPipeline, /listActiveInstagramSourceHandlesPageQuery/, "active snapshots must include active instagram sources");
assert.match(ingestionPipeline, /const handles = new Set<string>\(\)/, "active snapshots must deduplicate the source union");
assert.match(dailyLauncher, /durable-ingestion\/daily/);
assert.match(dailyLauncher, /ig-event-durable-runner/);
assert.match(dailyLauncher, /follow_up_required/);
assert.match(dailyLauncher, /MAX_DRAINED_RUNS/);
assert.doesNotMatch(dailyLauncher, /ingest-venues/, "daily durable launcher must not use the legacy fan-out route");
assert.match(dailyLauncher, /curl --disable --config "\$config_file"/);
assert.doesNotMatch(dailyLauncher, /curl[^\n]*Authorization/, "daily launcher must keep the bearer token out of curl argv");
assert.match(dailyLauncher, /unset CRON_SECRET/, "daily curl must not inherit the bearer token");
assert.match(dailyService, /Restart=on-failure/);
assert.match(dailyService, /ig-event-durable-daily-runner/);
assert.match(dailyTimer, /09:00:00 Europe\/Belgrade/);
assert.match(dailyTimer, /Persistent=true/);

function runDurableRunnerFixture(mode, expectedStatus) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ig-event-durable-runner-"));
  const fakeBin = join(fixtureRoot, "bin");
  const runtimeDir = join(fixtureRoot, "runtime");
  const stateDir = join(fixtureRoot, "state");
  const argvLog = join(fixtureRoot, "curl-argv.log");
  const blockedPidLog = join(fixtureRoot, "curl-blocked-pids.log");
  const fileModeLog = join(fixtureRoot, "curl-file-modes.log");
  const inheritedSecretLog = join(fixtureRoot, "curl-secret-env.log");
  const validationLog = join(fixtureRoot, "curl-validation.log");
  const sleepLog = join(fixtureRoot, "sleep.log");
  const envFile = join(fixtureRoot, "cron.env");

  mkdirSync(fakeBin);
  mkdirSync(runtimeDir);
  mkdirSync(stateDir);
  writeFileSync(envFile, [
    "APP_ORIGIN=https://public.invalid",
    "CRON_SECRET=fixture-super-secret",
    "",
  ].join("\n"), { mode: 0o600 });
  for (const logFile of [
    argvLog,
    blockedPidLog,
    fileModeLog,
    inheritedSecretLog,
    validationLog,
    sleepLog,
  ]) {
    writeFileSync(logFile, "", { mode: 0o600 });
  }

  const fakeCurl = join(fakeBin, "curl");
  writeFileSync(fakeCurl, [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    'argv="$*"',
    'config_file=""',
    'while [[ "$#" -gt 0 ]]; do',
    '  case "$1" in',
    '    --config) config_file="$2"; shift 2 ;;',
    '    *) shift ;;',
    "  esac",
    "done",
    '[[ -n "$config_file" && -r "$config_file" ]]',
    'printf "%s\\n" "$argv" >> "$FAKE_CURL_ARGV_LOG"',
    '[[ -z "${CRON_SECRET:-}" ]] || printf "leaked\\n" >> "$FAKE_CURL_SECRET_ENV_LOG"',
    'config_mode="$(stat -c %a "$config_file" 2>/dev/null || stat -f %Lp "$config_file")"',
    "body_file=\"$(sed -nE 's/^output = \\\"(.*)\\\"$/\\1/p' \"$config_file\")\"",
    'body_mode="$(stat -c %a "$body_file" 2>/dev/null || stat -f %Lp "$body_file")"',
    'printf "%s:%s\\n" "$config_mode" "$body_mode" >> "$FAKE_CURL_FILE_MODE_LOG"',
    "slot=\"$(sed -nE 's/.*workerSlot=([0-5])\\\"$/\\1/p' \"$config_file\")\"",
    'if [[ -z "$slot" ]] || ! grep -Fq "Authorization: Bearer fixture-super-secret" "$config_file" || ! grep -Fq "url = \\"http://127.0.0.1:3999/api/cron/durable-ingestion/execute?runId=fixture_run&workerSlot=${slot}\\"" "$config_file"; then',
    '  printf "invalid\\n" >> "$FAKE_CURL_VALIDATION_LOG"',
    "  exit 2",
    "fi",
    'first_attempt=0',
    'if mkdir "$FAKE_CURL_STATE/${FAKE_CURL_MODE}-${slot}" 2>/dev/null; then first_attempt=1; fi',
    'case "$FAKE_CURL_MODE" in',
    "  http_502)",
    "    if [[ \"$first_attempt\" == \"1\" ]]; then printf '{\"error\":\"bad_gateway\"}' > \"$body_file\"; printf \"502\"; exit 0; fi",
    "    ;;",
    "  timeout)",
    '    if [[ "$first_attempt" == "1" ]]; then : > "$body_file"; printf "000"; exit 28; fi',
    "    ;;",
    "  one_401)",
    "    if [[ \"$slot\" == \"0\" ]]; then printf '{\"error\":\"unauthorized\"}' > \"$body_file\"; printf \"401\"; exit 0; fi",
    "    printf '{\"claimed\":false,\"complete\":false}' > \"$body_file\"; printf \"200\"; exit 0",
    "    ;;",
    "  one_401_blocked)",
    "    if [[ \"$slot\" == \"0\" ]]; then printf '{\"error\":\"unauthorized\"}' > \"$body_file\"; printf \"401\"; exit 0; fi",
    '    printf "%s\\n" "$$" >> "$FAKE_CURL_BLOCKED_PID_LOG"',
    "    exec /bin/sleep 60",
    "    ;;",
    "esac",
    "printf '{\"claimed\":false,\"complete\":true}' > \"$body_file\"",
    'printf "200"',
    "",
  ].join("\n"), { mode: 0o755 });
  chmodSync(fakeCurl, 0o755);

  const fakeSleep = join(fakeBin, "sleep");
  writeFileSync(fakeSleep, [
    "#!/usr/bin/env bash",
    'printf "%s\\n" "${1:-}" >> "$FAKE_SLEEP_LOG"',
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  chmodSync(fakeSleep, 0o755);

  try {
    const result = spawnSync("bash", ["scripts/ig-event-durable-runner", "fixture_run"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CRON_SECRET: "must-be-replaced-by-fixture",
        FAKE_CURL_ARGV_LOG: argvLog,
        FAKE_CURL_BLOCKED_PID_LOG: blockedPidLog,
        FAKE_CURL_FILE_MODE_LOG: fileModeLog,
        FAKE_CURL_MODE: mode,
        FAKE_CURL_SECRET_ENV_LOG: inheritedSecretLog,
        FAKE_CURL_STATE: stateDir,
        FAKE_CURL_VALIDATION_LOG: validationLog,
        FAKE_SLEEP_LOG: sleepLog,
        IG_EVENT_CRON_ENV: envFile,
        IG_EVENT_DURABLE_EXECUTOR_ORIGIN: "http://127.0.0.1:3999",
        IG_EVENT_DURABLE_RUNTIME_DIR: runtimeDir,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      timeout: 10_000,
    });
    assert.equal(
      result.status,
      expectedStatus,
      `${mode} runner status; stdout=${result.stdout}; stderr=${result.stderr}`,
    );
    const argv = readFileSync(argvLog, "utf8");
    assert.doesNotMatch(argv, /fixture-super-secret|must-be-replaced-by-fixture/);
    assert.match(argv, /^--disable --config /m, "curl must disable curlrc before its root-only config path");
    assert.equal(
      readFileSync(inheritedSecretLog, "utf8"),
      "",
      "curl children must not inherit CRON_SECRET",
    );
    assert.equal(
      readFileSync(validationLog, "utf8"),
      "",
      "every retry must preserve the exact run and worker-slot URL",
    );
    for (const modes of readFileSync(fileModeLog, "utf8").trim().split("\n")) {
      assert.equal(modes, "600:600", "curl config and response body must stay mode 0600");
    }
    if (mode === "http_502" || mode === "timeout") {
      assert.match(readFileSync(sleepLog, "utf8"), /^5$/m, `${mode} should use the first five-second backoff`);
    }
    if (mode === "one_401_blocked") {
      const blockedPids = readFileSync(blockedPidLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number);
      assert.ok(blockedPids.length > 0, "fixture must block at least one sibling curl");
      for (const pid of blockedPids) {
        assert.throws(
          () => process.kill(pid, 0),
          (error) => error?.code === "ESRCH",
          `blocked curl ${pid} must be terminated and reaped`,
        );
      }
    }
    assert.deepEqual(
      readdirSync(runtimeDir),
      [],
      `${mode} must clean every sensitive worker file`,
    );
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

runDurableRunnerFixture("http_502", 0);
runDurableRunnerFixture("timeout", 0);
runDurableRunnerFixture("one_401", 1);
runDurableRunnerFixture("one_401_blocked", 1);
console.log("Durable ingestion controller QA passed.");
