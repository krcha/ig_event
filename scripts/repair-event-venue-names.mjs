import { existsSync, readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { loadVenueNameOverridesByHandle } from "../lib/pipeline/venue-name-overrides.ts";
import {
  buildCanonicalVenueNamesByHandle,
  canonicalizeVenueNameDetailed,
  normalizeVenueComparableText,
} from "../lib/pipeline/venue-normalization.ts";

const DEFAULT_LIMIT = 1000;
const DEFAULT_STATUSES = ["approved", "pending"];

function usage() {
  return [
    "Usage: npm run repair:event-venue-names -- [--apply] [--limit N] [--status approved,pending]",
    "",
    "Dry-run is the default. Renames events.venue only when a venue resolves to a known canonical/preferred name.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    apply: false,
    limit: DEFAULT_LIMIT,
    statuses: DEFAULT_STATUSES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--limit") {
      const next = argv[index + 1];
      index += 1;
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --limit value: ${next}`);
      }
      options.limit = Math.trunc(parsed);
      continue;
    }
    if (arg === "--status") {
      const next = argv[index + 1];
      index += 1;
      const statuses = (next ?? "")
        .split(",")
        .map((status) => status.trim())
        .filter(Boolean);
      const invalid = statuses.filter(
        (status) => !["approved", "pending", "rejected"].includes(status),
      );
      if (statuses.length === 0 || invalid.length > 0) {
        throw new Error(`Invalid --status value: ${next}`);
      }
      options.statuses = statuses;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function loadEnvFiles() {
  for (const envFile of [".env.local", ".env"]) {
    if (!existsSync(envFile)) {
      continue;
    }
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] ??= value;
    }
  }
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function sameVenueName(left, right) {
  return normalizeVenueComparableText(left) === normalizeVenueComparableText(right);
}

function buildPatch(event, canonicalization) {
  const from = normalizeString(event.venue);
  const to = normalizeString(canonicalization.venue);
  if (!from || !to || sameVenueName(from, to)) {
    return null;
  }

  const normalizedFields = parseJson(event.normalizedFieldsJson) ?? {};
  const repairedNormalizedFields = {
    ...normalizedFields,
    normalizedVenue: to,
    venueCanonicalizationRepair: {
      checkedAt: new Date().toISOString(),
      from,
      to,
      reason: canonicalization.reason,
      handle: canonicalization.handle,
      matchedVenue: canonicalization.matchedVenue,
      matchedAlias: canonicalization.matchedAlias ?? null,
      script: "scripts/repair-event-venue-names.mjs",
    },
  };

  return {
    venue: to,
    normalizedFieldsJson: JSON.stringify(repairedNormalizedFields),
  };
}

function addGroupedChange(groups, from, to, reason) {
  const key = `${from}\u0000${to}\u0000${reason}`;
  const existing = groups.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  groups.set(key, { from, to, reason, count: 1 });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  loadEnvFiles();
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required.");
  }

  const client = new ConvexHttpClient(convexUrl);
  const venues = await client.query(api.venues.listVenues, {});
  const canonicalVenueNamesByHandle = buildCanonicalVenueNamesByHandle(venues);
  const venueNameOverridesByHandle = await loadVenueNameOverridesByHandle();
  const groupedChanges = new Map();
  const unresolvedByVenue = new Map();
  const summary = {
    scanned: 0,
    unchanged: 0,
    repairable: 0,
    applied: 0,
    unresolved: 0,
    examples: [],
    unresolvedExamples: [],
  };

  for (const status of options.statuses) {
    const events = await client.query(api.events.listByStatus, {
      status,
      limit: options.limit,
    });

    for (const event of events) {
      summary.scanned += 1;
      const venue = normalizeString(event.venue);
      const canonicalization = canonicalizeVenueNameDetailed(
        venue,
        canonicalVenueNamesByHandle,
        {
          handleVenueNamesByHandle: venueNameOverridesByHandle,
        },
      );

      if (!canonicalization) {
        summary.unresolved += 1;
        const unresolvedCount = unresolvedByVenue.get(venue) ?? 0;
        unresolvedByVenue.set(venue, unresolvedCount + 1);
        if (summary.unresolvedExamples.length < 30) {
          summary.unresolvedExamples.push({
            id: event._id,
            status: event.status,
            title: event.title,
            date: event.date,
            venue,
          });
        }
        continue;
      }

      const patch = buildPatch(event, canonicalization);
      if (!patch) {
        summary.unchanged += 1;
        continue;
      }

      summary.repairable += 1;
      addGroupedChange(groupedChanges, venue, patch.venue, canonicalization.reason);
      if (summary.examples.length < 30) {
        summary.examples.push({
          id: event._id,
          status: event.status,
          title: event.title,
          date: event.date,
          from: venue,
          to: patch.venue,
          reason: canonicalization.reason,
          handle: canonicalization.handle,
        });
      }

      if (options.apply) {
        await client.mutation(api.events.updateEvent, {
          id: event._id,
          patch,
        });
        summary.applied += 1;
      }
    }
  }

  const unresolvedVenues = [...unresolvedByVenue.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 30)
    .map(([venue, count]) => ({ venue, count }));
  const grouped = [...groupedChanges.values()]
    .sort((left, right) => right.count - left.count || left.from.localeCompare(right.from));

  console.log(
    JSON.stringify(
      {
        mode: options.apply ? "apply" : "dry-run",
        statuses: options.statuses,
        limitPerStatus: options.limit,
        ...summary,
        groupedChanges: grouped,
        unresolvedVenues,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
