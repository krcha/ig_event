import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FOCUSED_SOURCE_CONFLICT_POLICY, buildFocusedSourceConflictReviewKey,
  buildFocusedSourceConflictContextFingerprint, parseFocusedSourceConflictReviewResult,
  validateFocusedSourceConflictReviewResult, buildFocusedSourceConflictReviewSupplement,
} from "../lib/events/focused-source-conflict-review.ts";
import { reviewSourceConflicts, FOCUSED_SOURCE_CONFLICT_MAX_OUTPUT_TOKENS } from "../lib/ai/review-source-conflicts.ts";
import { runFocusedSourceConflictReview } from "../lib/pipeline/focused-source-conflict-review.ts";
import { eventEvidenceConflictIsBenign } from "../lib/events/event-evidence-conflict-policy.ts";
import { buildPendingSourceConflictContext } from "../lib/events/pending-source-conflict-reclassification.ts";
import { isOpenAiProviderBlockedError } from "../lib/ai/extract-event-data.ts";

const bytes = Buffer.from("retained-poster-orbit-night-doors-21");
const digest = createHash("sha256").update(bytes).digest("hex");
const conflict = { field: "time", poster_value: "21:00", caption_value: "22:00", reason: "Poster and caption give different times." };
function fixture() {
  const caption = "Orbit Night\n17.10.2026\nStarts 22:00";
  const raw = { is_event: true, source_conflicts: [conflict], schedule_entries: [],
    time_evidence: { source: "caption", exact_text: "Starts 22:00", status: "start_time_stated" } };
  const fields = { extractionSourceConflicts: [conflict], materialSourceConflicts: [conflict],
    extractionContractVersion: "event_evidence_v2", sourceConflictResolutionVersion: 1,
    title: "Orbit Night", normalizedDate: "2026-10-17", normalizedVenue: "Orbit Club", time: "22:00", artists: [],
    identityEvidenceVerified: true, dateEvidenceVerified: true, timeEvidenceVerified: true, venueEvidenceVerified: true,
    splitEventTotal: 1, multiEventSplitDetected: false, sourceAccountRole: "venue", sourceAccountName: "Orbit Club" };
  const event = { id: "event-1", updatedAt: 100, status: "pending", title: "Orbit Night", date: "2026-10-17",
    time: "22:00", venue: "Orbit Club", artists: [], rawExtractionJson: JSON.stringify(raw),
    normalizedFieldsJson: JSON.stringify(fields), sourceCaption: caption, sourceConflictFields: ["time"] };
  return { scrapedPostId: "source-1", sourceRevision: 1, sourceIdentity: "instagram-source-identity-v1:test",
    sourceFingerprint: "source-fingerprint-1", instagramPostUrl: "https://www.instagram.com/p/test/", caption,
    altText: "", locationName: "", postedAt: "2026-10-13T10:00:00Z", analysisResultJson: event.rawExtractionJson,
    retainedImages: [{ slideIndex: 0, sourceUrl: "https://cdn.example/poster.jpg", url: "https://storage.example/retained-poster",
      checksumSha256: digest, storageId: "storage-1" }], events: [event] };
}
function result(context) {
  const event = context.events[0];
  return { policy_version: FOCUSED_SOURCE_CONFLICT_POLICY, events: [{ event_id: event.id,
    selected_facts: { title: event.title, date: event.date, time: event.time, venue: event.venue, artists: event.artists },
    resolutions: [{ event_id: event.id, conflict_index: 0, field: "time", disposition: "separate_context",
      selected_value: event.time, poster_quote: "Orbit Night 17.10.2026\nDoors 21:00", caption_quote: "Starts 22:00",
      slide_index: 0, reason: "Poster labels this occurrence's doors; caption labels its performance start." }] }] };
}

const context = fixture(), original = JSON.stringify(context), review = result(context);
assert.equal(eventEvidenceConflictIsBenign(conflict, buildPendingSourceConflictContext(context.events[0],
  JSON.parse(context.events[0].normalizedFieldsJson), JSON.parse(context.events[0].rawExtractionJson))), false);
assert.equal(validateFocusedSourceConflictReviewResult(context, review)[0].disposition, "deterministic_reclassification");
assert.deepEqual(buildFocusedSourceConflictReviewSupplement(context, review, "event-1"), {
  posterTexts: [{ slideIndex: 0, text: "Orbit Night 17.10.2026" }, { slideIndex: 0, text: "Doors 21:00" }],
  captionQuotes: ["Starts 22:00"],
});
for (const patch of [{ caption_quote: "Starts 23:00" }, { poster_quote: "Doors 20:00" },
  { poster_quote: "Doors 21:00" }, { poster_quote: "Unrelated Show 18.10.2026\nDoors 21:00" },
  { slide_index: 1 }, { disposition: "unresolved" }, { disposition: "extraction_error" }]) {
  const tampered = structuredClone(review); Object.assign(tampered.events[0].resolutions[0], patch);
  assert.equal(validateFocusedSourceConflictReviewResult(context, tampered)[0].disposition, "unresolved");
}
const changed = structuredClone(review); changed.events[0].selected_facts.time = "21:00";
assert.equal(validateFocusedSourceConflictReviewResult(context, changed)[0].disposition, "requires_saved_post_reprocess");
const duplicate = structuredClone(review); duplicate.events[0].resolutions.push({ ...duplicate.events[0].resolutions[0] });
assert.throws(() => validateFocusedSourceConflictReviewResult(context, duplicate), /each original conflict/);
assert.throws(() => parseFocusedSourceConflictReviewResult({ ...review, policy_version: "unknown" }), /invalid schema/);
const wrongRaw = structuredClone(context); wrongRaw.events[0].rawExtractionJson = "{}";
assert.throws(() => validateFocusedSourceConflictReviewResult(wrongRaw, review), /not bound/);
const trueDate = fixture();
const dateConflict = { field: "date", poster_value: "17.10.2026", caption_value: "18.10.2026", reason: "Different event dates." };
trueDate.caption = trueDate.events[0].sourceCaption = "Orbit Night\n18.10.2026\nStarts 22:00";
const dateFields = JSON.parse(trueDate.events[0].normalizedFieldsJson); dateFields.extractionSourceConflicts = [dateConflict];
trueDate.events[0].normalizedFieldsJson = JSON.stringify(dateFields);
trueDate.events[0].rawExtractionJson = JSON.stringify({ is_event: true, source_conflicts: [dateConflict] });
trueDate.analysisResultJson = trueDate.events[0].rawExtractionJson;
const dateResult = result(trueDate);
Object.assign(dateResult.events[0].resolutions[0], { field: "date", selected_value: "2026-10-17",
  poster_quote: "Orbit Night 17.10.2026", caption_quote: "18.10.2026" });
assert.equal(validateFocusedSourceConflictReviewResult(trueDate, dateResult)[0].disposition, "unresolved");
const timestampOnly = structuredClone(context); timestampOnly.events[0].updatedAt = 200;
assert.equal(buildFocusedSourceConflictReviewKey(timestampOnly), buildFocusedSourceConflictReviewKey(context));
assert.equal(buildFocusedSourceConflictContextFingerprint(timestampOnly), buildFocusedSourceConflictContextFingerprint(context));
const changedTimestamp = structuredClone(context); changedTimestamp.postedAt = "2026-10-14T10:00:00Z";
assert.notEqual(buildFocusedSourceConflictReviewKey(changedTimestamp), buildFocusedSourceConflictReviewKey(context));
assert.equal(JSON.stringify(context), original);

let transports = 0, starts = 0;
const download = async (url, options) => { assert.equal(options.maxAttempts, 1);
  return { imageBuffer: bytes, contentType: "image/jpeg", sourceUrl: url }; };
const normalize = async (buffer) => ({ imageBuffer: buffer, mimeType: "image/jpeg", wasConverted: false });
const fetchMock = async (url, request) => {
  transports += 1; assert.equal(url, "https://api.openai.com/v1/responses");
  const body = JSON.parse(request.body); assert.equal(body.max_output_tokens, FOCUSED_SOURCE_CONFLICT_MAX_OUTPUT_TOKENS);
  assert.equal(body.text.format.strict, true); const content = body.input[1].content;
  assert.equal(content.filter((item) => item.type === "input_image").length, 1);
  assert.ok(content.find((item) => item.type === "input_image").image_url.startsWith("data:image/jpeg;base64,"));
  assert.ok(content.find((item) => item.type === "input_text" && item.text.startsWith("SLIDE 0")));
  return new Response(JSON.stringify({ id: "response-1", status: "completed", model: "qa-model",
    output_text: JSON.stringify(review), usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 } }), { status: 200 });
};
const transportOptions = { apiKey: "qa-placeholder", model: "qa-model", download, normalize,
  fetch: fetchMock, beforeTransport: async () => { starts += 1; } };
const transport = await reviewSourceConflicts(context, transportOptions);
assert.equal(transports, 1); assert.equal(starts, 1); assert.equal(transport.responseId, "response-1");
assert.equal(transport.usage.totalTokens, 300); assert.deepEqual(transport.result, review);
await assert.rejects(reviewSourceConflicts(context, { ...transportOptions,
  download: async () => ({ imageBuffer: Buffer.from("wrong"), contentType: "image/jpeg", sourceUrl: "retained" }) }), /checksum changed/);
assert.equal(transports, 1); assert.equal(starts, 1);
await assert.rejects(reviewSourceConflicts(context, { ...transportOptions,
  beforeTransport: async () => { throw new Error("stale durable claim"); } }), /stale durable claim/);
assert.equal(transports, 1);
let blockedCalls = 0;
await assert.rejects(reviewSourceConflicts(context, { ...transportOptions, fetch: async () => {
  blockedCalls += 1; return new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 401 });
} }), (error) => isOpenAiProviderBlockedError(error) && typeof error.rawResponseJson === "string");
assert.equal(blockedCalls, 1);
let cached, reviewCalls = 0, markCalls = 0, completeCalls = 0;
const failures = [];
const deps = {
  claim: async () => cached ? { status: "cached", resultJson: cached.resultJson, contextJson: JSON.stringify(context) } : { status: "claimed" },
  markStarted: async () => { markCalls += 1; }, complete: async (_key, output) => { completeCalls += 1; cached = output; },
  fail: async (_key, failure) => { failures.push(failure); },
  review: async (_source, options) => { reviewCalls += 1; await options.beforeTransport(); return transport; },
};
assert.equal((await runFocusedSourceConflictReview(context, deps)).status, "completed");
assert.equal((await runFocusedSourceConflictReview(timestampOnly, deps)).status, "cached");
assert.equal(reviewCalls, 1); assert.equal(markCalls, 1); assert.equal(completeCalls, 1); assert.equal(failures.length, 0);
const stale = structuredClone(context); stale.events[0].title = "Different Event";
assert.equal((await runFocusedSourceConflictReview(stale, deps)).status, "deferred");
assert.equal(reviewCalls, 1);
assert.equal((await runFocusedSourceConflictReview(context, { ...deps,
  claim: async () => ({ status: "deferred", reason: "budget_exhausted" }) })).status, "deferred");
assert.equal(reviewCalls, 1);
assert.equal((await runFocusedSourceConflictReview(context, { ...deps, claim: async () => ({ status: "claimed" }),
  markStarted: async () => { throw new Error("atomic start denied"); }, review: async (_source, options) => {
    await options.beforeTransport(); throw new Error("unreachable transport"); },
})).status, "failed");
assert.equal(failures.at(-1).transportStarted, false);
assert.equal((await runFocusedSourceConflictReview(context, { ...deps, claim: async () => ({ status: "claimed" }),
  review: async (_source, options) => { await options.beforeTransport(); throw new Error("ambiguous provider timeout"); },
})).status, "failed");
assert.equal(failures.at(-1).transportStarted, true);
assert.equal((await runFocusedSourceConflictReview(context, { ...deps, claim: async () => ({ status: "claimed" }),
  review: async (_source, options) => { await options.beforeTransport(); return { ...transport, result: duplicate }; },
})).status, "failed");
assert.equal(failures.at(-1).rawResponseJson, transport.rawResponseJson);
assert.equal((await runFocusedSourceConflictReview(context, { ...deps, claim: async () => ({ status: "claimed" }),
  complete: async () => { throw new Error("result persistence failed"); },
})).status, "failed");
assert.equal(failures.at(-1).rawResponseJson, transport.rawResponseJson);
assert.equal(JSON.stringify(context), original);
const multi = structuredClone(context), second = structuredClone(context.events[0]); second.id = "event-2"; multi.events.push(second);
const multiReview = structuredClone(review), secondReview = structuredClone(review.events[0]); secondReview.event_id = "event-2";
for (const resolution of secondReview.resolutions) resolution.event_id = "event-2"; multiReview.events.push(secondReview);
const remaining = structuredClone(multi); remaining.events = [structuredClone(second)]; remaining.events[0].updatedAt = 300;
const cachedSubsetDeps = { ...deps, claim: async () => ({ status: "cached", resultJson: JSON.stringify(multiReview), contextJson: JSON.stringify(multi) }),
  review: async () => { throw new Error("Cached subset must not send provider transport."); } };
const subset = await runFocusedSourceConflictReview(remaining, cachedSubsetDeps);
assert.equal(subset.status, "cached"); assert.equal(subset.validation.length, 1);
assert.equal(subset.validation[0].eventId, "event-2"); assert.equal(subset.validation[0].expectedUpdatedAt, 300);
const unknownChild = structuredClone(remaining); unknownChild.events[0].id = "event-3";
assert.equal((await runFocusedSourceConflictReview(unknownChild, cachedSubsetDeps)).status, "deferred");
console.log("Focused source-conflict review QA passed.");
