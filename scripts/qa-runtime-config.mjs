import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const envExample = read(".env.example");
const envProductionExample = read(".env.production.example");
const dockerComposeSource = read("docker-compose.yml");
const dockerComposeRuntimeSource = read("docker-compose.runtime.yml");
const envUtilsSource = read("lib/utils/env.ts");
const middlewareSource = read("middleware.ts");
const readinessSource = read("lib/config/readiness.ts");
const readyRouteSource = read("app/api/ready/route.ts");
const healthRouteSource = read("app/api/health/route.ts");
const extractSource = read("lib/ai/extract-event-data.ts");
const reviewSource = read("lib/ai/review-approved-events.ts");
const packageJson = JSON.parse(read("package.json"));
const releaseCheckSource = read("scripts/release-check.mjs");

for (const envName of [
  "CLERK_JWT_ISSUER_DOMAIN",
  "CLERK_AUTHORIZED_PARTIES",
  "ADMIN_CLERK_USER_IDS",
  "CRON_SECRET",
  "INGESTION_POST_STEP_LIMIT=8",
  "SCRAPED_POST_PAGE_SIZE=25",
  "CRON_INGESTION_MAX_STEPS=20",
  "CRON_INGESTION_BATCH_SIZE=64",
  "OPENAI_VISION_MODEL=gpt-4.1-mini",
  "OPENAI_REVIEW_MODEL=gpt-4.1-mini",
]) {
  assert.ok(envExample.includes(envName), `.env.example should include ${envName}.`);
  assert.ok(
    envProductionExample.includes(envName),
    `.env.production.example should include ${envName}.`,
  );
}

for (const composeValue of [
  "CLERK_JWT_ISSUER_DOMAIN",
  "CLERK_AUTHORIZED_PARTIES",
  "INGESTION_POST_STEP_LIMIT: ${INGESTION_POST_STEP_LIMIT:-8}",
  "SCRAPED_POST_PAGE_SIZE: ${SCRAPED_POST_PAGE_SIZE:-25}",
  "CRON_INGESTION_MAX_STEPS: ${CRON_INGESTION_MAX_STEPS:-20}",
  "CRON_INGESTION_BATCH_SIZE: ${CRON_INGESTION_BATCH_SIZE:-64}",
  "CRON_RESULTS_LIMIT: ${CRON_RESULTS_LIMIT:-1}",
  "CRON_MAX_HANDLES_PER_RUN: ${CRON_MAX_HANDLES_PER_RUN:-600}",
  "CRON_FULL_SCRAPE_COOLDOWN_HOURS: ${CRON_FULL_SCRAPE_COOLDOWN_HOURS:-23}",
]) {
  assert.ok(dockerComposeSource.includes(composeValue), `docker-compose.yml should include ${composeValue}.`);
}

assert.ok(
  dockerComposeRuntimeSource.includes(
    "CLERK_AUTHORIZED_PARTIES: ${CLERK_AUTHORIZED_PARTIES:-https://events.ineedtofeedmyrabbit.com}",
  ),
  "docker-compose.runtime.yml should provide the production Clerk authorized party default.",
);

assert.match(
  envUtilsSource,
  /export function getOpenAiModelEnv/,
  "env helper should centralize OpenAI model defaults.",
);
assert.match(
  envUtilsSource,
  /export function getClerkAuthorizedParties/,
  "env helper should centralize Clerk authorized parties.",
);
assert.match(
  middlewareSource,
  /authorizedParties/,
  "Clerk middleware should verify configured authorized parties.",
);
assert.match(
  envUtilsSource,
  /Missing required production environment variable/,
  "production should fail fast when model env vars are missing.",
);
assert.match(
  envUtilsSource,
  /return "gpt-4\.1-mini"/,
  "local OpenAI model fallback should be gpt-4.1-mini.",
);
assert.match(
  extractSource,
  /getOpenAiModelEnv\("OPENAI_VISION_MODEL"\)/,
  "event extraction should use the shared model env helper.",
);
assert.doesNotMatch(
  extractSource,
  /^const openAiVisionModel = getOpenAiModelEnv\("OPENAI_VISION_MODEL"\);/m,
  "event extraction should not read production model env vars at module import time.",
);
assert.match(
  reviewSource,
  /getOpenAiModelEnv\("OPENAI_REVIEW_MODEL"\)/,
  "approved-event review should use the shared model env helper.",
);
assert.doesNotMatch(
  reviewSource,
  /^const approvedEventsReviewModel = getOpenAiModelEnv\("OPENAI_REVIEW_MODEL"\);/m,
  "approved-event review should not read production model env vars at module import time.",
);
assert.match(
  readinessSource,
  /CLERK_JWT_ISSUER_DOMAIN/,
  "readiness should check Clerk JWT issuer config.",
);
assert.match(
  readinessSource,
  /CLERK_AUTHORIZED_PARTIES/,
  "production readiness should check Clerk authorized parties config.",
);
assert.match(
  readinessSource,
  /OPENAI_VISION_MODEL/,
  "readiness should check production model envs.",
);
assert.match(
  readyRouteSource,
  /getReadinessStatus/,
  "/api/ready should use the shared readiness status.",
);
assert.doesNotMatch(
  healthRouteSource,
  /getReadinessStatus/,
  "/api/health should remain lightweight liveness.",
);
assert.ok(
  packageJson.scripts["qa:runtime-config"]?.includes("qa-runtime-config.mjs"),
  "package.json should expose qa:runtime-config.",
);
assert.match(
  releaseCheckSource,
  /qa:runtime-config/,
  "Release gate should include runtime config QA.",
);

console.log("Runtime config QA passed.");
