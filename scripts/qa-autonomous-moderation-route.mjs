import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as evidence from "../lib/events/focused-source-conflict-review.ts";
import { isAuthorizedCronRequestHeader } from "../lib/pipeline/cron-ingestion-config.ts";
import { isTransientSavedPostProcessingError } from "../lib/pipeline/durable-ingestion-execute.ts";

const SECRET = "qa-autonomous-route-secret";
const routePath = "app/api/cron/autonomous-moderation/route.ts", runnerPath = "lib/pipeline/focused-source-conflict-review.ts";
const [routeSource, runnerSource] = await Promise.all([readFile(routePath, "utf8"), readFile(runnerPath, "utf8")]);
function compile(source, fileName) { return ts.transpileModule(source, { compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName }).outputText; }
const compiledRoute = compile(routeSource, routePath), compiledRunner = compile(runnerSource, runnerPath);
function load(compiled, filename, mocks, env) {
  const module = { exports: {} };
  vm.runInNewContext(compiled, { Error, URL, Request, Response, process: { env }, exports: module.exports, module,
    require(name) { if (!mocks.has(name)) throw new Error("Unexpected QA dependency: " + name); return mocks.get(name); },
    fetch() { throw new Error("Route QA must never access a provider network."); } }, { filename });
  return module.exports;
}
const conflict = { field: "time", poster_value: "21:00", caption_value: "22:00", reason: "Different stated times." };
const caption = "Orbit Night\n17.10.2026\nStarts 22:00";
const raw = JSON.stringify({ is_event: true, source_conflicts: [conflict], schedule_entries: [], time_evidence: { source: "caption", exact_text: "Starts 22:00", status: "start_time_stated" } });
const context = { scrapedPostId: "source-1", sourceRevision: 3, sourceIdentity: "instagram-source-identity-v1:qa", sourceFingerprint: "fingerprint-1",
  instagramPostUrl: "https://www.instagram.com/p/qa/", caption, altText: "", locationName: "", postedAt: "2026-10-13T10:00:00Z", analysisResultJson: raw,
  retainedImages: [{ slideIndex: 0, sourceUrl: "https://fixture.example/poster.jpg", url: "https://fixture.example/retained", checksumSha256: "a".repeat(64), storageId: "storage-1" }],
  events: [{ id: "event-1", updatedAt: 100, status: "pending", title: "Orbit Night", date: "2026-10-17", time: "22:00", venue: "Orbit Club", artists: [], rawExtractionJson: raw,
    normalizedFieldsJson: JSON.stringify({ extractionSourceConflicts: [conflict], materialSourceConflicts: [conflict], extractionContractVersion: "event_evidence_v2",
      sourceConflictResolutionVersion: 1, title: "Orbit Night", normalizedDate: "2026-10-17", normalizedVenue: "Orbit Club", time: "22:00", artists: [],
      identityEvidenceVerified: true, dateEvidenceVerified: true, timeEvidenceVerified: true, venueEvidenceVerified: true, splitEventTotal: 1,
      multiEventSplitDetected: false, sourceAccountRole: "venue", sourceAccountName: "Orbit Club" }), sourceCaption: caption, sourceConflictFields: ["time"] }] };
const reviewResult = { policy_version: evidence.FOCUSED_SOURCE_CONFLICT_POLICY, events: [{ event_id: "event-1",
  selected_facts: { title: "Orbit Night", date: "2026-10-17", time: "22:00", venue: "Orbit Club", artists: [] }, resolutions: [{ event_id: "event-1", conflict_index: 0,
    field: "time", disposition: "separate_context", selected_value: "22:00", poster_quote: "Orbit Night 17.10.2026\nDoors 21:00", caption_quote: "Starts 22:00", slide_index: 0, reason: "Doors and performance start." }] }] };
const work = { holdId: "hold-1", eventId: "event-1", expectedUpdatedAt: 100, category: "source_conflict_review", sourcePostId: "source-1", sourceRevision: 3, handle: "qa_club" };
function harness({ idle = false, category = "source_conflict_review", enabled = true, claimDeferred, persistenceFailure = false,
  cachedResult = { state: "terminal", outcome: "receipt_complete", transportAttempted: false } } = {}) {
  const calls = [], processing = [], env = { NODE_ENV: "production", CRON_SECRET: SECRET, AUTONOMOUS_MODERATION_AI_ENABLED: enabled ? "true" : "false", AUTONOMOUS_MODERATION_REVIEW_DAILY_LIMIT: "500" };
  let transportCalls = 0, createdClients = 0, started = false, retained = null;
  const convex = {
    async query(reference, args) { calls.push({ reference, args }); assert.equal(reference, "sourceConflictReviews:getContext"); return { context: structuredClone(context) }; },
    async mutation(reference, args) {
      calls.push({ reference, args }); assert.equal(args.serviceSecret, SECRET);
      switch (reference) {
        case "autonomousModeration:claimNextWork": return idle || category === "source_conflict_review" && !args.allowFocusedReviews ? null : { ...work, category };
        case "autonomousModeration:completeWork": return { recorded: true };
        case "sourceConflictReviews:claim":
          assert.equal(args.dailyReviewLimit, 50); assert.equal(args.globalDailyLimit, 17); assert.equal(args.expectedContextFingerprint, evidence.buildFocusedSourceConflictContextFingerprint(context));
          if (claimDeferred) return { status: "deferred", reason: claimDeferred };
          if (retained) return { status: "cached", resultJson: retained.resultJson, contextJson: JSON.stringify(context) };
          return started ? { status: "deferred", reason: "source_review_already_attempted" } : { status: "claimed" };
        case "sourceConflictReviews:markStarted": started = true; return { started: true };
        case "sourceConflictReviews:finish": if (persistenceFailure) throw new Error("Review persistence unavailable."); if (args.resultJson) retained = { resultJson: args.resultJson }; return { recorded: true };
        case "sourceConflictReviews:applyCompleted": assert.ok(retained); return [{ eventId: work.eventId, outcome: "repaired", reason: "verified_benign_source_conflicts" }];
        default: throw new Error("Unexpected mutation: " + reference);
      }
    } };
  const runner = load(compiledRunner, runnerPath, new Map([
    ["@/lib/events/focused-source-conflict-review", evidence], ["@/lib/ai/extract-event-data", { isOpenAiProviderBlockedError: () => false }],
    ["@/lib/ai/review-source-conflicts", { reviewSourceConflicts: async (_context, options) => { await options.beforeTransport(); transportCalls += 1;
      return { result: structuredClone(reviewResult), rawResponseJson: JSON.stringify({ id: "response-1", output_text: JSON.stringify(reviewResult) }), responseId: "response-1", usage: { totalTokens: 10 } }; } }] ]), env);
  const route = load(compiledRoute, routePath, new Map([
    ["node:crypto", { randomUUID: () => "qa-owner" }],
    ["next/server", { NextResponse: { json(body, init) { return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "content-type": "application/json" } }); } } }],
    ["@/lib/convex/server", { createConvexHttpClient: () => { createdClients += 1; return convex; }, requireServiceSecret: () => SECRET }],
    ["@/lib/pipeline/cron-ingestion-config", { isAuthorizedCronRequestHeader: (header) => isAuthorizedCronRequestHeader(header, env) }],
    ["@/lib/pipeline/instagram-ingestion-durability", { getOpenAiDailyPostLimit: () => 17 }],
    ["@/lib/pipeline/ingestion/durable-saved-posts", { processSavedScrapedPostForDurableReceipt: async (args) => { processing.push(args); return cachedResult; } }],
    ["@/lib/pipeline/durable-ingestion-execute", { isTransientSavedPostProcessingError }], ["@/lib/pipeline/focused-source-conflict-review", runner],
    ["@/lib/events/focused-source-conflict-review", evidence] ]), env);
  return { calls, processing, get transports() { return transportCalls; }, get createdClients() { return createdClients; },
    POST: (authorized = true) => route.POST(new Request("https://fixture.example/api/cron/autonomous-moderation", { method: "POST", headers: authorized ? { authorization: "Bearer " + SECRET } : {} })),
    completions: () => calls.filter(call => call.reference === "autonomousModeration:completeWork").map(call => call.args) };
}
{ const h = harness(), response = await h.POST(false); assert.equal(response.status, 401); assert.equal(h.calls.length, 0); assert.equal(h.createdClients, 0); assert.equal(h.transports, 0); }
{ const h = harness({ idle: true }); assert.equal((await (await h.POST()).json()).state, "idle"); assert.equal(h.calls.length, 1); assert.equal(h.processing.length, 0); assert.equal(h.transports, 0); }
{ const h = harness({ category: "occurrence_completion", enabled: false }); assert.equal((await (await h.POST()).json()).state, "terminal"); assert.equal(h.processing.length, 1); assert.equal(h.transports, 0);
  const args = h.processing[0]; assert.equal(args.requireCachedAnalysisOnly, true); assert.equal(args.scrapedPostId, work.sourcePostId); assert.equal(args.expectedSourceRevision, work.sourceRevision);
  assert.equal(args.handle, work.handle); assert.equal(args.serviceSecret, SECRET); assert.match(args.workOwner, /^autonomous-moderation:/u); assert.equal(h.completions()[0].outcome, "repaired"); }
{ const h = harness({ category: "occurrence_completion", cachedResult: { state: "pending", reason: "OpenAI provider execution lease is busy.", transportAttempted: false } });
  await h.POST(); assert.equal(h.completions()[0].outcome, "retry"); assert.equal(h.completions()[0].attempted, false); assert.equal(h.transports, 0); }
{ const h = harness({ enabled: false }); assert.equal((await (await h.POST()).json()).state, "idle"); assert.equal(h.calls[0].args.allowFocusedReviews, false); assert.equal(h.transports, 0); }
{ const h = harness({ claimDeferred: "budget_exhausted" }); assert.equal((await (await h.POST()).json()).state, "deferred"); assert.equal(h.calls[0].args.allowFocusedReviews, true);
  assert.equal(h.transports, 0); assert.equal(h.completions()[0].outcome, "retry"); assert.equal(h.completions()[0].attempted, false); assert.equal(h.completions()[0].reason, "budget_exhausted"); }
{ const h = harness(); assert.equal((await (await h.POST()).json()).state, "completed"); assert.equal((await (await h.POST()).json()).state, "cached"); assert.equal(h.transports, 1); assert.equal(h.processing.length, 0);
  assert.equal(h.calls.filter(call => call.reference === "sourceConflictReviews:markStarted").length, 1); assert.equal(h.calls.filter(call => call.reference === "sourceConflictReviews:applyCompleted").length, 2);
  assert.equal(h.calls.filter(call => call.reference === "sourceConflictReviews:finish").length, 1); assert.ok(h.completions().every(args => args.outcome === "repaired")); }
{ const h = harness({ persistenceFailure: true }), first = await h.POST(); assert.equal(first.status, 202); assert.equal((await first.json()).state, "deferred");
  assert.equal((await (await h.POST()).json()).state, "deferred"); assert.equal(h.transports, 1); assert.equal(h.calls.filter(call => call.reference === "sourceConflictReviews:markStarted").length, 1);
  assert.equal(h.calls.filter(call => call.reference === "sourceConflictReviews:applyCompleted").length, 0); assert.equal(h.completions().at(-1).outcome, "held"); assert.equal(h.completions().at(-1).attempted, false); }
console.log("Autonomous moderation route QA passed.");
