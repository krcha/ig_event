import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { parseVenueHoursJson } from "../lib/venues/venue-hours-cache.ts";
import { isVenueScrapeActive } from "../lib/venues/venue-lifecycle.ts";

const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const DEFAULT_LIMIT = 25;
const DEFAULT_DELAY_MS = 300;
const DEFAULT_REGION = "Belgrade, Serbia";

function usage() {
  return [
    "Usage: node --import ./scripts/register-ts-paths.mjs --experimental-strip-types \\",
    "  scripts/resolve-venue-place-ids.mjs -- [--apply] [--all] [--force] [--limit N] [--delay-ms N]",
    "",
    "Dry-run by default. Resolves a Google place_id per venue via Text Search (cheapest SKU)",
    "and stores it with --apply. place_id is the only field Google permits storing indefinitely.",
    "",
    "  --all    resolve for every active venue (default: only venues with no usable OSM/manual hours)",
    "  --force  re-resolve venues that already have a googlePlaceId",
    "",
    "Requires GOOGLE_MAPS_API_KEY, NEXT_PUBLIC_CONVEX_URL, and CRON_SECRET.",
  ].join("\n");
}

function readPositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label} value: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    all: false,
    apply: false,
    delayMs: DEFAULT_DELAY_MS,
    force: false,
    limit: DEFAULT_LIMIT,
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
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--limit") {
      options.limit = readPositiveInteger(argv[index + 1], "--limit");
      index += 1;
      continue;
    }
    if (arg === "--delay-ms") {
      options.delayMs = Math.max(0, readPositiveInteger(argv[index + 1], "--delay-ms"));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function hasUsableHours(venue) {
  if (venue.hoursSource !== "osm" && venue.hoursSource !== "manual") {
    return false;
  }
  const hoursJson = parseVenueHoursJson(venue.hoursJson);
  return Boolean(hoursJson && hoursJson.weekly.some((day) => day.windows.length > 0));
}

function isEligibleForPlaceIdResolution(venue) {
  return (
    typeof venue._id === "string" &&
    venue._id.length > 0 &&
    typeof venue.name === "string" &&
    venue.name.trim().length > 0 &&
    isVenueScrapeActive(venue)
  );
}

function selectVenues(venues, options) {
  return venues
    .filter(isEligibleForPlaceIdResolution)
    .filter((venue) => options.force || !venue.googlePlaceId)
    .filter((venue) => options.all || !hasUsableHours(venue))
    .slice(0, options.limit);
}

function buildQuery(venue) {
  const name = venue.name.trim();
  const location = (venue.location ?? "").trim();
  return location ? `${name}, ${location}` : `${name}, ${DEFAULT_REGION}`;
}

async function resolvePlaceId(venue, apiKey) {
  const response = await fetch(TEXT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
    },
    body: JSON.stringify({
      textQuery: buildQuery(venue),
      maxResultCount: 1,
      regionCode: "RS",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`text_search_${response.status}${body ? `:${body.slice(0, 200)}` : ""}`);
  }

  const data = await response.json();
  const place = data.places?.[0];
  if (!place?.id) {
    return null;
  }
  return {
    address: place.formattedAddress ?? null,
    matched: place.displayName?.text ?? null,
    placeId: place.id,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required.");
  }
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY is required.");
  }
  const serviceSecret = process.env.CRON_SECRET?.trim();
  if (!serviceSecret) {
    throw new Error("CRON_SECRET is required.");
  }

  const client = new ConvexHttpClient(convexUrl);
  const venues = await client.query(api.venues.listVenues, { serviceSecret });
  const selected = selectVenues(venues, options);
  const summary = {
    applied: 0,
    failed: 0,
    limit: options.limit,
    mode: options.apply ? "apply" : "dry-run",
    notFound: 0,
    results: [],
    scope: options.all ? "all-active" : "missing-hours-only",
    selected: selected.length,
    totalVenues: venues.length,
  };

  for (const venue of selected) {
    try {
      const resolved = await resolvePlaceId(venue, apiKey);
      if (!resolved) {
        summary.notFound += 1;
        summary.results.push({ id: venue._id, name: venue.name, status: "not_found" });
      } else {
        if (options.apply) {
          await client.mutation(api.venues.patchVenueHours, {
            id: venue._id,
            patch: { googlePlaceId: resolved.placeId },
            serviceSecret,
          });
          summary.applied += 1;
        }
        summary.results.push({
          id: venue._id,
          matched: resolved.matched,
          name: venue.name,
          placeId: resolved.placeId,
          status: options.apply ? "stored" : "would_store",
        });
      }
    } catch (error) {
      summary.failed += 1;
      summary.results.push({
        error: error instanceof Error ? error.message : "Unknown error.",
        id: venue._id,
        name: venue.name,
        status: "failed",
      });
    }

    if (options.delayMs > 0) {
      await delay(options.delayMs);
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
