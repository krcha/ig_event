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
assert.match(launcher, /for _ in \{1\.\.8\}/);
console.log("Durable ingestion controller QA passed.");
