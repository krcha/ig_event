import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";

// Preview with production NEXT_PUBLIC_CONVEX_URL and CRON_SECRET set:
//   node scripts/repair-reviewed-fabrika-vinyl-venue.mjs
// Apply only the reviewed preview:
//   node scripts/repair-reviewed-fabrika-vinyl-venue.mjs --apply --expect-plan-sha256 <preview hash>
const CONVEX_URL = "https://convex-events.ineedtofeedmyrabbit.com";
const EVENT_ID = "j570d4ngc6xahwa03e5nmzvb618ewwvv";
const OLD_EVENT_UPDATED_AT = 1790061814254;
const OLD_VENUE_ID = "k17bp4t9435fgrfxkbpjb7ax3h897rjd";
const TARGET_VENUE_ID = "k178xx56eaadyf9x5tarervn3h8993zc";
const SOURCE_LINK_ID = "kx7frw5bsjm8681dbj3z7bmhfh8ew5x7";
const RECEIPT_ID = "mh7amvj4xgnkxwyhc49hpz4n2n8ewpnx";
const OCCURRENCE_ID = "pd74g6dyes5nwbh4krydr5vd1d8ew52d";
const SOURCE_IDENTITY = "instagram-source-identity-v1:Ddi7AbOtCTO";
const SOURCE_ROW = "SREDA 21:00 - 01:00 OPEN VINYL NIGHT";
const TARGET_VENUE_NAME = "Fabrika Alternativne Kulturne Scene";
const TARGET_VENUE_HANDLE = "faks_beograd";
const EVIDENCE =
  "Večernji program u Fabrici Alternativne Kulturne Scene će se svake nedelje održavati prema ovom rasporedu. Radnička 5N, Ada Ciganlija. Row: SREDA 21:00 - 01:00 OPEN VINYL NIGHT.";
const REVIEW_NOTE =
  "Reviewed Fabrika weekly program: OPEN VINYL NIGHT is an event title at Fabrika, not a separate Vinyl venue.";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase();
}

function buildPlan(venues, context) {
  const targetVenue = venues.find((venue) => venue._id === TARGET_VENUE_ID);
  assert(
    targetVenue?.name === TARGET_VENUE_NAME &&
      normalize(targetVenue.instagramHandle) === TARGET_VENUE_HANDLE &&
      targetVenue.publicStatus === "published" &&
      Number.isSafeInteger(targetVenue.updatedAt),
    "Fabrika target venue changed or is not public.",
  );
  const { event, sources } = context;
  assert(event?._id === EVENT_ID && event.status === "approved", "The reviewed event changed status or identity.");
  assert(
    normalize(event.title) === "open vinyl night" &&
      event.date === "2026-09-23" &&
      event.time === "21:00-01:00",
    "The reviewed event title, date, or time changed.",
  );
  assert(sources?.length === 1, "The reviewed event source-link count changed.");
  const { sourceLink, receipt, occurrence } = sources[0];
  assert(
    sourceLink._id === SOURCE_LINK_ID &&
      sourceLink.sourceIdentity === SOURCE_IDENTITY &&
      receipt._id === RECEIPT_ID &&
      occurrence._id === OCCURRENCE_ID &&
      (!sourceLink.sourceOccurrenceId || sourceLink.sourceOccurrenceId === OCCURRENCE_ID) &&
      occurrence.canonicalEventId === EVENT_ID &&
      occurrence.state === "satisfied" &&
      receipt.sourceFingerprint === sourceLink.sourceFingerprint &&
      occurrence.sourceFingerprint === sourceLink.sourceFingerprint,
    "The reviewed source link, receipt, or occurrence changed.",
  );
  const expected = receipt.expectedOccurrences?.filter((item) =>
    item.key === sourceLink.sourceOccurrenceKey) ?? [];
  const satisfied = receipt.satisfiedOccurrences?.filter((item) =>
    item.key === sourceLink.sourceOccurrenceKey && item.eventId === EVENT_ID) ?? [];
  assert(expected.length === 1 && satisfied.length === 1, "The reviewed receipt occurrence changed.");
  let fields;
  let raw;
  let normalizedOccurrence;
  try {
    fields = JSON.parse(event.normalizedFieldsJson);
    raw = JSON.parse(event.rawExtractionJson);
    normalizedOccurrence = JSON.parse(occurrence.normalizedOccurrenceJson);
  } catch {
    throw new Error("The reviewed evidence JSON is missing or malformed.");
  }
  assert(
    fields.extractionContractVersion === "event_evidence_v2" &&
      fields.sourceGroundingInstagramHandle === TARGET_VENUE_HANDLE &&
      fields.splitEventIndex === 3 &&
      fields.rowSourceText === SOURCE_ROW &&
      raw.extraction_contract_version === "event_evidence_v2" &&
      raw.schedule_entries?.filter((entry) => entry.source_text === SOURCE_ROW).length === 1,
    "The reviewed immutable Fabrika schedule evidence changed.",
  );

  const done = event.venueId === TARGET_VENUE_ID && event.venue === TARGET_VENUE_NAME;
  if (done) {
    assert(
      fields.normalizedVenue === TARGET_VENUE_NAME &&
        expected[0].venue === TARGET_VENUE_NAME &&
        occurrence.venueId === TARGET_VENUE_ID &&
        normalizedOccurrence.venue === TARGET_VENUE_NAME &&
        normalizedOccurrence.venueId === TARGET_VENUE_ID,
      "Fabrika event changed venue but receipt or occurrence was not rebound.",
    );
    return { status: "done", planSha256: null, operation: null };
  }
  assert(
    event.updatedAt === OLD_EVENT_UPDATED_AT &&
      event.venueId === OLD_VENUE_ID &&
      event.venue === "Vinyl" &&
      fields.normalizedVenue === "Vinyl" &&
      fields.rawVenue === "Vinyl" &&
      expected[0].venue === "Vinyl" &&
      occurrence.venueId === OLD_VENUE_ID &&
      normalizedOccurrence.venue === "Vinyl" &&
      normalizedOccurrence.venueId === OLD_VENUE_ID,
    "The reviewed old venue or event revision changed; review again before repair.",
  );
  const operation = {
    functionName: "events:repairReviewedMultiSourceEventVenue",
    args: {
      id: EVENT_ID,
      expectedUpdatedAt: event.updatedAt,
      expectedNormalizedFieldsJson: event.normalizedFieldsJson,
      expectedSources: [{
        sourceLinkId: SOURCE_LINK_ID,
        sourceLinkUpdatedAt: sourceLink.updatedAt,
        receiptId: RECEIPT_ID,
        receiptUpdatedAt: receipt.updatedAt,
      }],
      nextVenue: TARGET_VENUE_NAME,
      targetVenueId: TARGET_VENUE_ID,
      expectedTargetVenueUpdatedAt: targetVenue.updatedAt,
      expectedTargetVenueHandle: TARGET_VENUE_HANDLE,
      venueEvidence: EVIDENCE,
      moderationNote: REVIEW_NOTE,
    },
  };
  const planSha256 = crypto.createHash("sha256")
    .update(JSON.stringify({ version: 1, operation }))
    .digest("hex");
  return { status: "pending", planSha256, operation };
}

async function loadPlan(client, serviceSecret) {
  const [venues, context] = await Promise.all([
    client.query("venues:listVenues", { serviceSecret }),
    client.query("events:getReviewedVenueRepairContext", { id: EVENT_ID, serviceSecret }),
  ]);
  return buildPlan(venues, context);
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const hashFlag = argv.indexOf("--expect-plan-sha256");
  const expectedHash = hashFlag < 0 ? null : argv[hashFlag + 1];
  if (
    argv.some((arg, index) => arg !== "--apply" && arg !== "--expect-plan-sha256" &&
      !(index > 0 && argv[index - 1] === "--expect-plan-sha256")) ||
    (apply && !/^[0-9a-f]{64}$/u.test(expectedHash ?? "")) ||
    (!apply && expectedHash !== null)
  ) {
    throw new Error("Preview first; apply with --apply --expect-plan-sha256 <preview hash>.");
  }
  const configuredUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim().replace(/\/$/u, "");
  const serviceSecret = process.env.CRON_SECRET?.trim();
  if (configuredUrl !== CONVEX_URL || !serviceSecret) {
    throw new Error("Production Convex URL or CRON_SECRET is missing or differs from the reviewed target.");
  }
  const client = new ConvexHttpClient(CONVEX_URL);
  const before = await loadPlan(client, serviceSecret);
  if (!apply) {
    console.log(JSON.stringify({ mode: "preview", status: before.status, planSha256: before.planSha256 }, null, 2));
    return;
  }
  assert(before.operation && before.planSha256 === expectedHash, "The live plan changed after preview or was already applied.");
  await client.mutation(before.operation.functionName, {
    ...before.operation.args,
    serviceSecret,
  });
  const after = await loadPlan(client, serviceSecret);
  assert(after.status === "done", "Mutation returned but postwrite verification failed; inspect before retrying.");
  console.log(JSON.stringify({ mode: "applied", status: after.status, eventId: EVENT_ID }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    const secret = process.env.CRON_SECRET?.trim();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Reviewed Fabrika venue repair stopped: ${secret ? message.replaceAll(secret, "[redacted]") : message}`);
    process.exitCode = 1;
  }
}
