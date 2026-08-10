import assert from "node:assert/strict";

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

console.log("durable execute-route lease classification QA passed");
