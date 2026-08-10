import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
for (const required of ["ingestionRuns", "ingestionRunChunks", "ingestionRunHandleReceipts", "by_run_handle"]) {
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
assert.match(executor, /processingPending: preserveAttempt/, "busy AI processing must remain an explicit retry, not a terminal fetch");
assert.match(executor, /retryAfterMs: 30_000/, "busy AI processing must back off instead of hot-looping");
assert.match(controller, /providerAttemptCount/);
assert.match(controller, /providerResultStatus/, "controller receipts must distinguish a charge from persisted source data");
assert.match(controller, /by_run_status_retryNotBeforeAt/, "receipt retries must be queryable without scanning all run rows");
assert.match(controller, /preserveAttempt/, "waiting for an AI lease must not consume the receipt retry limit");
assert.match(controller, /Selected profiles exceed this run's frozen budget/);
assert.match(controller, /markReceiptProviderAttemptStarted/);
assert.match(executor, /complete: state\?\.complete/, "workers must distinguish completion from a busy lease after restart");
assert.match(launcher, /for _ in \{1\.\.8\}/);
assert.match(launcher, /pids=\(\)/, "runner must track every worker PID");
assert.match(launcher, /for pid in "\$\{pids\[@\]\}"/, "runner must wait for every worker");
assert.match(launcher, /exit "\$failed"/, "a worker failure must reach systemd");
for (const reason of ["lease_expired_retry_limit", "retry_limit"]) {
  const offset = controller.indexOf(reason);
  assert.ok(offset >= 0, `missing ${reason} terminal branch`);
  const branch = controller.slice(Math.max(0, offset - 700), offset + 700);
  assert.match(branch, /finishRunIfTerminal/);
}
assert.match(controller, /MAX_HANDLES_PER_CHUNK = 1/);
assert.match(controller, /activeReceipts/);
assert.match(launcher, /"complete":true/, "busy workers must wait rather than treat an active lease as completion");
assert.match(dailyRoute, /mode: "daily"/);
assert.match(dailyRoute, /resumeDaily: true/);
assert.match(dailyRoute, /getActiveVenueHandles/);
assert.match(ingestionPipeline, /listLegacyVenueHandlesPageQuery/, "active snapshots must include scrape-active legacy venues");
assert.match(ingestionPipeline, /listActiveInstagramSourceHandlesPageQuery/, "active snapshots must include active instagram sources");
assert.match(ingestionPipeline, /const handles = new Set<string>\(\)/, "active snapshots must deduplicate the source union");
assert.match(dailyLauncher, /durable-ingestion\/daily/);
assert.match(dailyLauncher, /ig-event-durable-runner/);
assert.doesNotMatch(dailyLauncher, /ingest-venues/, "daily durable launcher must not use the legacy fan-out route");
assert.match(dailyService, /Restart=on-failure/);
assert.match(dailyService, /ig-event-durable-daily-runner/);
assert.match(dailyTimer, /09:00:00 Europe\/Belgrade/);
assert.match(dailyTimer, /Persistent=true/);
console.log("Durable ingestion controller QA passed.");
