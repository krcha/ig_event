import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import {
  buildReviewedFabrikaProgramEnrichmentPatch,
  FABRIKA_PROGRAM_REVIEWS,
  FABRIKA_WEEKLY_POST_URL,
} from "../lib/events/reviewed-fabrika-program-enrichment.ts";

const CONVEX_URL = "https://convex-events.ineedtofeedmyrabbit.com";
const OPERATION_ID = "reviewed-fabrika-direct-program-enrichment-20260924-v1";
const NOTE =
  "Reviewed Fabrika direct announcement confirms the program, artists and entry price for the existing weekly event card; both sources and receipt topologies remain intact.";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sourceVersion(source, occurrence) {
  assert(source?.link && source?.receipt && occurrence, "Source topology is incomplete.");
  return {
    linkId: source.link._id,
    linkUpdatedAt: source.link.updatedAt,
    receiptId: source.receipt._id,
    receiptUpdatedAt: source.receipt.updatedAt,
    occurrenceId: occurrence._id,
    occurrenceUpdatedAt: occurrence.updatedAt,
  };
}

async function getSingleOccurrence(client, eventId, serviceSecret) {
  const page = await client.query("sourceOccurrences:listByCanonicalEvent", {
    eventId,
    paginationOpts: { cursor: null, numItems: 2 },
    serviceSecret,
  });
  assert(page.isDone && page.page.length === 1, "Event occurrence topology changed.");
  return page.page[0];
}

async function loadPlan(client, serviceSecret, night) {
  const review = FABRIKA_PROGRAM_REVIEWS[night];
  const [context, primaryOccurrence, directOccurrence] =
    await Promise.all([
      client.query("events:getReviewedCrossPostScheduleFoldContext", {
        operationId: `${OPERATION_ID}:${night}`,
        primaryId: review.primaryId,
        duplicateId: review.directId,
        serviceSecret,
      }),
      getSingleOccurrence(client, review.primaryId, serviceSecret),
      getSingleOccurrence(client, review.directId, serviceSecret),
    ]);
  const posts = await client.query("scrapedPosts:getManyByIds", {
    ids: [primaryOccurrence.sourceDocumentId, directOccurrence.sourceDocumentId],
    serviceSecret,
  });
  const weeklyPost = posts.find((post) => post._id === primaryOccurrence.sourceDocumentId);
  const directPost = posts.find((post) => post._id === directOccurrence.sourceDocumentId);
  assert(
    context.primary?._id === review.primaryId &&
      context.duplicate?._id === review.directId &&
      context.primarySources?.length === 1 &&
      context.duplicateSources?.length === 1 &&
      weeklyPost?.caption === context.primary.sourceCaption &&
      directPost?.caption === context.duplicate.sourceCaption &&
      weeklyPost.handle === "faks_beograd" &&
      directPost.handle === "faks_beograd" &&
      weeklyPost.instagramPostUrl === FABRIKA_WEEKLY_POST_URL &&
      directPost.instagramPostUrl === review.directUrl &&
      weeklyPost.analysisResultJson === context.primary.rawExtractionJson &&
      directPost.analysisResultJson === context.duplicate.rawExtractionJson &&
      weeklyPost.analysisRevision === (weeklyPost.sourceRevision ?? 1) &&
      directPost.analysisRevision === (directPost.sourceRevision ?? 1) &&
      weeklyPost.analysisContractVersion === "event_evidence_v2" &&
      directPost.analysisContractVersion === "event_evidence_v2" &&
      weeklyPost.analysisIsEvent === true &&
      directPost.analysisIsEvent === true &&
      weeklyPost.postedAt === context.primary.sourcePostedAt &&
      directPost.postedAt === context.duplicate.sourcePostedAt &&
      primaryOccurrence._id === context.primarySources[0].link.sourceOccurrenceId &&
      directOccurrence._id === context.duplicateSources[0].link.sourceOccurrenceId,
    "Reviewed Fabrika source evidence changed.",
  );
  const weeklyFields = JSON.parse(context.primary.normalizedFieldsJson);
  const directFields = JSON.parse(context.duplicate.normalizedFieldsJson);
  const weeklyExtraction = JSON.parse(context.primary.rawExtractionJson);
  const selectedRow = weeklyExtraction.schedule_entries?.[weeklyFields.splitEventIndex - 1];
  assert(
    context.primary.publicationState === "publishable" &&
      context.duplicate.publicationState === "hidden" &&
      weeklyFields.sourceGroundingInstagramHandle === "faks_beograd" &&
      directFields.sourceGroundingInstagramHandle === "faks_beograd" &&
      weeklyFields.dateEvidenceVerified === true &&
      weeklyFields.timeEvidenceVerified === true &&
      directFields.dateEvidenceVerified === true &&
      directFields.timeEvidenceVerified === true &&
      directFields.venueEvidenceVerified === true &&
      selectedRow?.source_text === weeklyFields.rowSourceText &&
      selectedRow?.date === review.date &&
      selectedRow?.time === review.primaryTime &&
      selectedRow?.title === review.primaryTitle,
    "Reviewed Fabrika schedule-row or verified source evidence changed.",
  );
  const patch = buildReviewedFabrikaProgramEnrichmentPatch(
    night,
    context.primary,
    context.duplicate,
    directPost.caption,
  );
  if (patch.alreadyDone) {
    return {
      status: "done",
      planSha256: null,
      operation: null,
      publicEventId: review.primaryId,
      pendingDirectEventId: review.directId,
    };
  }
  const operation = {
    functionName: "events:enrichReviewedFabrikaProgram",
    args: {
      night,
      primaryId: review.primaryId,
      directId: review.directId,
      expectedPrimaryUpdatedAt: context.primary.updatedAt,
      expectedPrimaryNormalizedFieldsJson: context.primary.normalizedFieldsJson,
      expectedDirectUpdatedAt: context.duplicate.updatedAt,
      expectedDirectNormalizedFieldsJson: context.duplicate.normalizedFieldsJson,
      primarySource: sourceVersion(context.primarySources[0], primaryOccurrence),
      directSource: sourceVersion(context.duplicateSources[0], directOccurrence),
      moderationNote: NOTE,
    },
  };
  const evidence = {
    version: 1,
    operation,
    primary: context.primary,
    direct: context.duplicate,
    primarySource: context.primarySources[0],
    directSource: context.duplicateSources[0],
    primaryOccurrence,
    directOccurrence,
    weeklyPost,
    directPost,
    patch,
  };
  const planSha256 = crypto.createHash("sha256")
    .update(JSON.stringify(evidence))
    .digest("hex");
  return {
    status: "pending",
    planSha256,
    operation,
    publicEventId: review.primaryId,
    pendingDirectEventId: review.directId,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const nightFlag = argv.indexOf("--night");
  const night = nightFlag < 0 ? null : argv[nightFlag + 1];
  const apply = argv.includes("--apply");
  const hashFlag = argv.indexOf("--expect-plan-sha256");
  const expectedHash = hashFlag < 0 ? null : argv[hashFlag + 1];
  assert(
    night && Object.hasOwn(FABRIKA_PROGRAM_REVIEWS, night) &&
      argv.every((arg, index) =>
        arg === "--apply" || arg === "--night" || arg === "--expect-plan-sha256" ||
        (index > 0 && ["--night", "--expect-plan-sha256"].includes(argv[index - 1])),
      ) &&
      (!apply ? expectedHash === null : /^[0-9a-f]{64}$/u.test(expectedHash ?? "")),
    "Preview with --night thursday|friday|saturday; apply with --apply --expect-plan-sha256 <preview hash>.",
  );
  const configuredUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim().replace(/\/$/u, "");
  const serviceSecret = process.env.CRON_SECRET?.trim();
  assert(
    configuredUrl === CONVEX_URL && Boolean(serviceSecret),
    "Production Convex URL or CRON_SECRET is unavailable.",
  );
  const client = new ConvexHttpClient(CONVEX_URL);
  const before = await loadPlan(client, serviceSecret, night);
  if (!apply) {
    console.log(JSON.stringify({
      mode: "preview",
      night,
      status: before.status,
      planSha256: before.planSha256,
      publicEventId: before.publicEventId,
      pendingDirectEventId: before.pendingDirectEventId,
    }, null, 2));
    return;
  }
  assert(
    before.operation && before.planSha256 === expectedHash,
    "Reviewed Fabrika plan changed after preview or was already applied.",
  );
  const result = await client.mutation(before.operation.functionName, {
    ...before.operation.args,
    serviceSecret,
  });
  assert(result.applied === true && result.directStatus === "pending", "Enrichment did not apply exactly once.");
  const after = await loadPlan(client, serviceSecret, night);
  assert(after.status === "done", "Enrichment returned but postwrite verification failed.");
  console.log(JSON.stringify({
    mode: "applied",
    night,
    status: "done",
    publicEventId: result.primaryId,
    pendingDirectEventId: FABRIKA_PROGRAM_REVIEWS[night].directId,
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    const secret = process.env.CRON_SECRET?.trim();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Reviewed Fabrika program enrichment stopped: ${secret ? message.replaceAll(secret, "[redacted]") : message}`);
    process.exitCode = 1;
  }
}
