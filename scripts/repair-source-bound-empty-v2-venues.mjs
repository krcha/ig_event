import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ConvexHttpClient } from "convex/browser";

// One-time, source-bound repair of exact IDs from an audited read-only
// manifest. Preview and apply both re-read live versions; the server mutation
// independently verifies the source post, venue claims, and occurrence proof.
const PRODUCTION_CONVEX_URL = "https://convex-events.ineedtofeedmyrabbit.com";
const MUTATION = "events:repairSourceBoundEmptyV2Venue";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const args = { apply: false, manifest: "", expectManifestSha256: "", expectPlanSha256: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    const key = {
      "--manifest": "manifest",
      "--expect-manifest-sha256": "expectManifestSha256",
      "--expect-plan-sha256": "expectPlanSha256",
    }[arg];
    assert(key && argv[index + 1], `Unknown or incomplete argument: ${arg}`);
    args[key] = argv[++index];
  }
  assert(args.manifest, "Pass --manifest with the reviewed candidate manifest path.");
  assert(/^[a-f0-9]{64}$/.test(args.expectManifestSha256), "Pass the reviewed manifest SHA-256.");
  assert(
    args.apply === Boolean(args.expectPlanSha256) &&
      (!args.expectPlanSha256 || /^[a-f0-9]{64}$/.test(args.expectPlanSha256)),
    "Preview first; apply with --apply --expect-plan-sha256 <preview hash>.",
  );
  return args;
}

function chunks(values, length) {
  return Array.from({ length: Math.ceil(values.length / length) }, (_, index) =>
    values.slice(index * length, (index + 1) * length));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim().replace(/\/$/, "");
  const serviceSecret = process.env.CRON_SECRET?.trim();
  assert(convexUrl === PRODUCTION_CONVEX_URL && serviceSecret, "Production Convex URL or service secret is unavailable.");
  const manifestBytes = await readFile(args.manifest);
  assert(sha256(manifestBytes) === args.expectManifestSha256, "Candidate manifest digest changed.");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert(manifest.schemaVersion === 1 && manifest.readOnly === true && Array.isArray(manifest.rows), "Candidate manifest contract changed.");
  const selected = manifest.rows.filter((row) => row.exactHandleVenueMatch === true);
  assert(selected.length === manifest.exactHandleVenueMatchCount && selected.length > 0 && selected.length <= 200, "Exact candidate count changed.");
  assert(new Set(selected.map((row) => row.eventId)).size === selected.length, "Duplicate candidate ID.");
  const client = new ConvexHttpClient(PRODUCTION_CONVEX_URL);
  const [venueRows, ...eventPages] = await Promise.all([
    client.query("venues:listVenues", { serviceSecret }),
    ...chunks(selected.map((row) => row.eventId), 50).map((ids) =>
      client.query("events:getManyByIds", { ids, serviceSecret })),
  ]);
  const venues = new Map(venueRows.map((venue) => [venue._id, venue]));
  const events = new Map(eventPages.flat().map((event) => [event._id, event]));
  const handles = [...new Set(selected.map((row) => row.sourceHandle))].sort();
  const sources = new Map();
  for (const batch of chunks(handles, 5)) {
    const rows = await Promise.all(batch.map((handle) =>
      client.query("instagramSources:getByHandle", { handle, serviceSecret })));
    rows.forEach((row, index) => sources.set(batch[index], row));
  }

  const entries = [];
  const skipped = [];
  for (const row of selected.sort((a, b) => a.eventId.localeCompare(b.eventId))) {
    const event = events.get(row.eventId);
    const venue = venues.get(row.catalogVenueId);
    const source = sources.get(row.sourceHandle);
    const exact = event && venue && source &&
      event.updatedAt === row.expectedUpdatedAt &&
      sha256(event.normalizedFieldsJson ?? "") === row.normalizedFieldsJsonSha256 &&
      sha256(event.rawExtractionJson ?? "") === row.rawExtractionJsonSha256 &&
      event.status === "approved" && !event.venue?.trim() && !event.venueId &&
      event.instagramPostUrl === row.sourcePostUrl &&
      event.instagramPostId === row.sourcePostId &&
      venue._id === row.catalogVenueId && venue.name === row.catalogVenueName &&
      source.handle === row.sourceHandle && source.active === true &&
      source.role === "venue" && source.venueId === venue._id &&
      Number.isSafeInteger(venue.updatedAt) && Number.isSafeInteger(source.updatedAt);
    if (!exact) {
      skipped.push({ eventId: row.eventId, reason: "live_version_or_identity_changed" });
      continue;
    }
    entries.push({
      id: event._id,
      expectedUpdatedAt: event.updatedAt,
      expectedNormalizedFieldsJson: event.normalizedFieldsJson,
      venueId: venue._id,
      expectedVenueUpdatedAt: venue.updatedAt,
      expectedSourceUpdatedAt: source.updatedAt,
    });
  }
  const planSha256 = sha256(JSON.stringify({
    schemaVersion: 1,
    convexUrl: PRODUCTION_CONVEX_URL,
    manifestSha256: args.expectManifestSha256,
    entries,
    skipped,
  }));
  if (!args.apply) {
    console.log(JSON.stringify({
      mode: "preview",
      manifestSha256: args.expectManifestSha256,
      exactCandidateCount: selected.length,
      readyCount: entries.length,
      skipped,
      planSha256,
    }, null, 2));
    return;
  }
  assert(planSha256 === args.expectPlanSha256, "Live repair plan changed after preview.");
  assert(entries.length > 0, "No exact source-bound candidates remain.");
  const results = [];
  for (const entry of entries) {
    try {
      const result = await client.mutation(MUTATION, {
        ...entry,
        moderationNote: "Verified saved venue-account schedule source and occurrence receipt repair, 2026-09-30.",
        serviceSecret,
      });
      results.push({ eventId: entry.id, updated: result.updated === true, status: result.status });
    } catch (error) {
      results.push({ eventId: entry.id, updated: false, error: error instanceof Error ? error.message : "unknown" });
    }
  }
  console.log(JSON.stringify({
    mode: "apply",
    manifestSha256: args.expectManifestSha256,
    planSha256,
    attempted: entries.length,
    updated: results.filter((result) => result.updated).length,
    failed: results.filter((result) => !result.updated),
  }, null, 2));
  if (results.some((result) => !result.updated)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unknown repair operator error.");
  process.exitCode = 1;
});
