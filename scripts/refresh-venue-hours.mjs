import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { parseVenueHoursJson } from "../lib/venues/venue-hours-cache.ts";
import { fetchVenueHoursPatch } from "../lib/venues/venue-hours-fetcher.ts";
import {
  getActiveVenueHoursRefreshTargets,
  getDueVenueHoursRefreshTargets,
  sortVenueHoursRefreshTargets,
} from "../lib/venues/venue-hours-refresh.ts";

const DEFAULT_LIMIT = 25;
const DEFAULT_DELAY_MS = 1_000;

function usage() {
  return [
    "Usage: npm run repair:venue-hours -- [--apply] [--force] [--limit N] [--delay-ms N]",
    "",
    "Dry-run is the default. Fetches OSM venue hours and stores them only with --apply.",
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
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--limit") {
      const next = argv[index + 1];
      index += 1;
      options.limit = readPositiveInteger(next, "--limit");
      continue;
    }
    if (arg === "--delay-ms") {
      const next = argv[index + 1];
      index += 1;
      options.delayMs = Math.max(0, readPositiveInteger(next, "--delay-ms"));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function summarizePatch(patch) {
  const hoursJson = parseVenueHoursJson(patch.hoursJson);
  const windows = hoursJson?.weekly
    .flatMap((day) =>
      day.windows.map((window) => ({
        day: day.day,
        end: window.end,
        start: window.start,
      })),
    )
    .slice(0, 4);

  return {
    error: patch.hoursError || null,
    expiresAt: new Date(patch.hoursExpiresAt).toISOString(),
    source: patch.hoursSource,
    windows: windows ?? [],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required.");
  }

  const client = new ConvexHttpClient(convexUrl);
  const venues = await client.query(api.venues.listVenues, {});
  const now = Date.now();
  const activeVenues = getActiveVenueHoursRefreshTargets(venues);
  const dueVenues = options.force
    ? activeVenues
    : getDueVenueHoursRefreshTargets(venues, now);
  const selectedVenues = sortVenueHoursRefreshTargets(dueVenues, now).slice(0, options.limit);
  const summary = {
    activeVenues: activeVenues.length,
    applied: 0,
    checked: 0,
    dueVenues: dueVenues.length,
    failed: 0,
    limit: options.limit,
    mode: options.apply ? "apply" : "dry-run",
    results: [],
    selectedVenues: selectedVenues.length,
    skippedNoPatch: 0,
  };

  for (const venue of selectedVenues) {
    summary.checked += 1;
    try {
      const patch = await fetchVenueHoursPatch(venue, {
        force: options.force,
        now,
      });
      if (!patch) {
        summary.skippedNoPatch += 1;
        summary.results.push({
          id: venue._id,
          name: venue.name,
          status: "skipped",
        });
        continue;
      }

      if (options.apply) {
        await client.mutation(api.venues.patchVenueHours, {
          id: venue._id,
          patch,
        });
        summary.applied += 1;
      }

      summary.results.push({
        id: venue._id,
        name: venue.name,
        status: options.apply ? "patched" : "would_patch",
        ...summarizePatch(patch),
      });
    } catch (error) {
      summary.failed += 1;
      summary.results.push({
        error: error instanceof Error ? error.message : "Unknown venue-hours error.",
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
