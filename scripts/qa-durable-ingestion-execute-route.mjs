import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.CRON_SECRET = "qa-durable-execute-route-secret";

const { isTransientSavedPostProcessingError } = await import(
  "../lib/pipeline/durable-ingestion-execute.ts"
);

for (const leaseContention of [
  "OpenAI provider execution lease is busy.",
  "OpenAI provider execution lease could not be acquired.",
  "Saved post processing is busy; retry this saved post later.",
  "Saved post processing is deferred.",
]) {
  assert.equal(
    isTransientSavedPostProcessingError(leaseContention),
    true,
    `lease contention must preserve the provider attempt: ${leaseContention}`,
  );
}

assert.equal(
  isTransientSavedPostProcessingError("Apify request failed with status 500."),
  false,
  "a real provider failure must remain an explicit retryable failure",
);

const routeSource = await readFile(
  new URL("../app/api/cron/durable-ingestion/execute/route.ts", import.meta.url),
  "utf8",
);
const transientResponseCount = routeSource.match(/status: preserveAttempt \? 202 : 503/g)?.length ?? 0;
assert.equal(
  transientResponseCount,
  2,
  "both returned and thrown AI-lease contention paths must return 202 and preserve the attempt",
);

console.log("durable execute-route lease classification QA passed");
