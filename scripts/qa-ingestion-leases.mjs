import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const schemaSource = read("convex/schema.ts");
const ingestionJobsSource = read("convex/ingestionJobs.ts");
const scrapedPostsSource = read("convex/scrapedPosts.ts");
const pipelineSource = read("lib/pipeline/run-instagram-ingestion.ts");
const cronIngestSource = read("app/api/cron/ingest-venues/route.ts");
const adminJobRouteSource = read("app/api/admin/scrape/jobs/[jobId]/route.ts");
const repairStaleJobsSource = read("scripts/repair-stale-ingestion-jobs.mjs");
const packageJson = JSON.parse(read("package.json"));
const releaseCheckSource = read("scripts/release-check.mjs");

for (const field of ["stateVersion", "leaseOwner", "leaseExpiresAt"]) {
  assert.match(schemaSource, new RegExp(`${field}: v\\.optional`), `schema should include ${field}.`);
  assert.match(ingestionJobsSource, new RegExp(field), `ingestionJobs functions should use ${field}.`);
}

for (const functionName of ["claimStep", "completeStep", "failStep"]) {
  assert.match(
    ingestionJobsSource,
    new RegExp(`export const ${functionName} = mutation`),
    `ingestionJobs should expose ${functionName}.`,
  );
  assert.match(
    ingestionJobsSource,
    new RegExp(`export const ${functionName} = [\\s\\S]*?requireAdminOrServiceSecret`),
    `${functionName} should require admin or service secret.`,
  );
}

assert.match(
  schemaSource,
  /postedAtMs: v\.optional\(v\.number\(\)\)/,
  "scrapedPosts should store sortable postedAtMs.",
);
assert.match(
  schemaSource,
  /sourceKey: v\.optional\(v\.string\(\)\)/,
  "scrapedPosts should store sourceKey.",
);
assert.match(
  scrapedPostsSource,
  /export const listByHandlePaginated = query/,
  "scrapedPosts should expose a paginated handle query.",
);
assert.match(
  scrapedPostsSource,
  /export const getManyByIds = query/,
  "scrapedPosts should expose bounded ID reads.",
);

assert.match(
  pipelineSource,
  /DEFAULT_INGESTION_POST_STEP_LIMIT = 8/,
  "ingestion should default to eight posts per step.",
);
assert.match(
  pipelineSource,
  /DEFAULT_SCRAPED_POST_PAGE_SIZE = 25/,
  "saved-post ingestion should default to 25-post pages.",
);
assert.match(
  pipelineSource,
  /currentScrapedPostIds\?: string\[\]/,
  "ingestion state should store scraped post IDs instead of full post arrays.",
);
assert.match(
  pipelineSource,
  /state\.currentHandlePosts = \[\]/,
  "ingestion should clear legacy currentHandlePosts before persisting state.",
);
assert.match(
  pipelineSource,
  /listScrapedPostsByHandlePaginatedQuery/,
  "saved-post ingestion should read posts through pagination.",
);
assert.match(
  pipelineSource,
  /getScrapedPostsManyByIdsQuery/,
  "saved-post ingestion should load the current bounded ID window.",
);

assert.doesNotMatch(
  cronIngestSource,
  /runInstagramIngestion\(/,
  "cron ingestion route should not run full ingestion inline.",
);
assert.match(
  cronIngestSource,
  /DEFAULT_CRON_MAX_STEPS_PER_REQUEST = 20/,
  "cron ingestion route should default to enough bounded steps for a full active-venue run.",
);
assert.match(
  cronIngestSource,
  /DEFAULT_BATCH_SIZE = 64/,
  "cron ingestion route should default to the maximum bounded handle batch size.",
);
assert.match(
  cronIngestSource,
  /findResumableCronJob/,
  "cron ingestion route should resume recent cron jobs instead of creating stale running jobs.",
);
assert.match(
  cronIngestSource,
  /claimStep/,
  "cron ingestion route should claim leased job steps.",
);
assert.match(
  cronIngestSource,
  /completeStep/,
  "cron ingestion route should complete leased job steps.",
);
assert.match(
  cronIngestSource,
  /failStep/,
  "cron ingestion route should fail leased job steps on errors.",
);
assert.match(
  adminJobRouteSource,
  /claimStep/,
  "admin job route should use leased job advancement.",
);
assert.match(
  repairStaleJobsSource,
  /CRON_SECRET/,
  "stale job repair should authenticate with the service secret.",
);
assert.match(
  repairStaleJobsSource,
  /claimStep/,
  "stale job repair should claim a lease before updating a job.",
);
assert.match(
  repairStaleJobsSource,
  /failStep/,
  "stale job repair should fail jobs through the leased mutation.",
);
assert.doesNotMatch(
  repairStaleJobsSource,
  /patchJob/,
  "stale job repair should not use blind job patching.",
);

assert.ok(
  packageJson.scripts["qa:ingestion-leases"]?.includes("qa-ingestion-leases.mjs"),
  "package.json should expose qa:ingestion-leases.",
);
assert.match(
  releaseCheckSource,
  /qa:ingestion-leases/,
  "Release gate should include ingestion lease QA.",
);

console.log("Ingestion lease QA passed.");
