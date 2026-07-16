import { ConvexHttpClient } from "convex/browser";
import { pathToFileURL } from "node:url";
import { api } from "../convex/_generated/api.js";
import { sanitizeTimeAgainstDate } from "../lib/events/event-validation.ts";
import { markModelDerivedRepairPending } from "./source-grounding-guard.mjs";

const DEFAULT_LIMIT = 1000;
const DEFAULT_STATUSES = ["approved", "pending"];

function usage() {
  return [
    "Usage: npm run repair:event-schedule-entries -- [--apply] [--limit N] [--status approved,pending]",
    "",
    "Dry-run is the default. Creates or updates events from stored rawExtractionJson.schedule_entries.",
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

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeIsoDate(year, month, day) {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function inferYear(sourceEvent) {
  const sourcePostedAt = new Date(sourceEvent.sourcePostedAt ?? "");
  if (!Number.isNaN(sourcePostedAt.getTime())) {
    return sourcePostedAt.getUTCFullYear();
  }
  const eventYear = String(sourceEvent.date ?? "").match(/^(\d{4})-/u)?.[1];
  return eventYear ? Number(eventYear) : null;
}

function normalizeEntryDate(rawDate, sourceEvent) {
  const value = String(rawDate ?? "").trim();
  if (!value) {
    return null;
  }

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (isoMatch) {
    return normalizeIsoDate(
      Number(isoMatch[1]),
      Number(isoMatch[2]),
      Number(isoMatch[3]),
    );
  }

  const numericMatch = value.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\.?$/u);
  if (!numericMatch) {
    return null;
  }

  const rawYear = numericMatch[3];
  const year = rawYear
    ? rawYear.length === 2
      ? 2000 + Number(rawYear)
      : Number(rawYear)
    : inferYear(sourceEvent);
  if (!year) {
    return null;
  }

  return normalizeIsoDate(Number(numericMatch[1]), Number(numericMatch[2]), year);
}

function normalizeEntryTime(rawTime, rawDate) {
  const value = String(rawTime ?? "")
    .trim()
    .replace(/\b(\d{1,2}):(\d{2})\s*h\b/giu, "$1:$2");
  if (!value) {
    return "";
  }

  const rangeHourMatch = value.match(/^(\d{1,2})\s*h?\s*[-–—]\s*(\d{1,2})\s*h?$/iu);
  if (rangeHourMatch) {
    const start = rangeHourMatch[1].padStart(2, "0");
    const end = rangeHourMatch[2].padStart(2, "0");
    return sanitizeTimeAgainstDate(`${start}:00-${end}:00`, rawDate);
  }

  const hourMatch = value.match(/^(\d{1,2})\s*h$/iu);
  if (hourMatch) {
    return sanitizeTimeAgainstDate(`${hourMatch[1].padStart(2, "0")}:00`, rawDate);
  }

  return sanitizeTimeAgainstDate(value.replace(/\b(\d{1,2})\.(\d{2})\b/gu, "$1:$2"), rawDate);
}

function normalizeArtists(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((artist) => String(artist ?? "").trim().replace(/^@/u, ""))
      .filter(Boolean),
  )];
}

function entryIdentity(entry, sourceEvent) {
  const date = normalizeEntryDate(entry.date, sourceEvent);
  const title = String(entry.title ?? "").trim();
  if (!date || !title) {
    return null;
  }
  return `${date}:${normalizeText(title)}`;
}

function chooseSourceEvent(events) {
  return [...events].sort((left, right) => {
    const leftRaw = parseJson(left.rawExtractionJson);
    const rightRaw = parseJson(right.rawExtractionJson);
    const leftEntries = Array.isArray(leftRaw?.schedule_entries)
      ? leftRaw.schedule_entries.length
      : 0;
    const rightEntries = Array.isArray(rightRaw?.schedule_entries)
      ? rightRaw.schedule_entries.length
      : 0;
    return rightEntries - leftEntries || right.updatedAt - left.updatedAt;
  })[0];
}

export function buildNormalizedFields(sourceEvent, entry, index, total, date, time) {
  const normalizedFields = parseJson(sourceEvent.normalizedFieldsJson) ?? {};
  normalizedFields.time = time || null;
  normalizedFields.title = String(entry.title ?? "").trim();
  normalizedFields.titleSource = "poster_schedule";
  normalizedFields.titleUsedFallback = false;
  normalizedFields.titleDerivedFromContext = false;
  normalizedFields.titleContextCandidate = null;
  normalizedFields.rawDate = String(entry.date ?? "").trim();
  normalizedFields.rawExtractedDateText = String(entry.date ?? "").trim();
  normalizedFields.normalizedDate = date;
  normalizedFields.dateSource = "model";
  normalizedFields.dateReason = null;
  normalizedFields.artists = normalizeArtists(entry.artists);
  normalizedFields.description = String(entry.description ?? "").trim() || null;
  normalizedFields.dateRangeExpanded = false;
  normalizedFields.dateRangeExpandedCount = 1;
  normalizedFields.multiEventSplitDetected = true;
  normalizedFields.multiEventSplitCount = total;
  normalizedFields.splitEventIndex = index + 1;
  normalizedFields.splitEventTotal = total;
  normalizedFields.splitSource = "poster_schedule";
  normalizedFields.splitSourceLine = String(entry.source_text ?? "").trim() || null;
  normalizedFields.rowSourceText = String(entry.source_text ?? "").trim() || null;
  normalizedFields.expandedDateIndex = index + 1;
  normalizedFields.expandedDateTotal = total;
  normalizedFields.normalizedIsValid = true;
  normalizedFields.normalizedInvalidReason = null;
  normalizedFields.scheduleEntryRepair = {
    checkedAt: new Date().toISOString(),
    sourceEventId: sourceEvent._id,
    script: "scripts/repair-event-schedule-entries.mjs",
  };
  return JSON.stringify(
    markModelDerivedRepairPending(
      normalizedFields,
      "scripts/repair-event-schedule-entries.mjs",
    ),
  );
}

export function buildPatch(sourceEvent, entry, index, total) {
  const date = normalizeEntryDate(entry.date, sourceEvent);
  const title = String(entry.title ?? "").trim();
  if (!date || !title) {
    return null;
  }

  const time = normalizeEntryTime(entry.time, entry.date);
  const description = String(entry.description ?? "").trim();
  const artists = normalizeArtists(entry.artists);
  return {
    title,
    date,
    ...(time ? { time } : {}),
    venue: sourceEvent.venue,
    artists,
    ...(description ? { description } : {}),
    ...(sourceEvent.imageUrl ? { imageUrl: sourceEvent.imageUrl } : {}),
    ...(sourceEvent.instagramPostUrl ? { instagramPostUrl: sourceEvent.instagramPostUrl } : {}),
    ...(sourceEvent.instagramPostId ? { instagramPostId: sourceEvent.instagramPostId } : {}),
    ...(sourceEvent.ticketPrice ? { ticketPrice: sourceEvent.ticketPrice } : {}),
    eventType: sourceEvent.eventType,
    ...(sourceEvent.sourceCaption ? { sourceCaption: sourceEvent.sourceCaption } : {}),
    ...(sourceEvent.sourcePostedAt ? { sourcePostedAt: sourceEvent.sourcePostedAt } : {}),
    ...(sourceEvent.rawExtractionJson ? { rawExtractionJson: sourceEvent.rawExtractionJson } : {}),
    normalizedFieldsJson: buildNormalizedFields(sourceEvent, entry, index, total, date, time),
    status: "pending",
  };
}

function hasMaterialPatch(existing, patch) {
  const hasPatchField = (field) => Object.prototype.hasOwnProperty.call(patch, field);
  return (
    normalizeText(existing.title) !== normalizeText(patch.title) ||
    existing.date !== patch.date ||
    (hasPatchField("time") && String(existing.time ?? "") !== String(patch.time ?? "")) ||
    normalizeText(existing.venue) !== normalizeText(patch.venue) ||
    (hasPatchField("artists") &&
      JSON.stringify(existing.artists ?? []) !== JSON.stringify(patch.artists ?? [])) ||
    (hasPatchField("description") &&
      String(existing.description ?? "") !== String(patch.description ?? ""))
  );
}

function needsScheduleMetadataPatch(existing) {
  const normalizedFields = parseJson(existing.normalizedFieldsJson) ?? {};
  return (
    normalizedFields.multiEventSplitDetected !== true ||
    typeof normalizedFields.multiEventSplitCount !== "number" ||
    typeof normalizedFields.splitEventIndex !== "number"
  );
}

export function buildSafeUpdatePatch(existing, patch) {
  return {
    title: patch.title,
    date: patch.date,
    ...(patch.time ? { time: patch.time } : {}),
    venue: patch.venue,
    artists: patch.artists.length > 0 ? patch.artists : existing.artists ?? [],
    ...(patch.description ? { description: patch.description } : {}),
    ...(patch.imageUrl ? { imageUrl: patch.imageUrl } : {}),
    ...(patch.instagramPostUrl ? { instagramPostUrl: patch.instagramPostUrl } : {}),
    ...(patch.instagramPostId ? { instagramPostId: patch.instagramPostId } : {}),
    ...(patch.ticketPrice ? { ticketPrice: patch.ticketPrice } : {}),
    eventType: patch.eventType,
    ...(patch.sourceCaption ? { sourceCaption: patch.sourceCaption } : {}),
    ...(patch.sourcePostedAt ? { sourcePostedAt: patch.sourcePostedAt } : {}),
    ...(patch.rawExtractionJson ? { rawExtractionJson: patch.rawExtractionJson } : {}),
    normalizedFieldsJson: patch.normalizedFieldsJson,
    status: "pending",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required.");
  }

  const client = new ConvexHttpClient(convexUrl);
  const eventsBySource = new Map();
  const summary = {
    scanned: 0,
    sourcesWithSchedules: 0,
    expectedRows: 0,
    existingRows: 0,
    repairableCreates: 0,
    repairableUpdates: 0,
    appliedCreates: 0,
    appliedUpdates: 0,
    skippedInvalidEntries: 0,
    examples: [],
  };

  for (const status of options.statuses) {
    const events = await client.query(api.events.listByStatus, {
      status,
      limit: options.limit,
    });

    for (const event of events) {
      summary.scanned += 1;
      const key = event.instagramPostUrl || event.instagramPostId || event._id;
      if (!key) {
        continue;
      }
      const rawExtraction = parseJson(event.rawExtractionJson);
      const entries = Array.isArray(rawExtraction?.schedule_entries)
        ? rawExtraction.schedule_entries
        : [];
      if (entries.length < 2) {
        continue;
      }
      const group = eventsBySource.get(key) ?? [];
      group.push(event);
      eventsBySource.set(key, group);
    }
  }

  for (const events of eventsBySource.values()) {
    const sourceEvent = chooseSourceEvent(events);
    const rawExtraction = parseJson(sourceEvent.rawExtractionJson);
    const entries = Array.isArray(rawExtraction?.schedule_entries)
      ? rawExtraction.schedule_entries
      : [];
    const validEntries = entries.filter((entry) => entryIdentity(entry, sourceEvent));
    if (validEntries.length < 2) {
      summary.skippedInvalidEntries += entries.length - validEntries.length;
      continue;
    }

    summary.sourcesWithSchedules += 1;
    summary.expectedRows += validEntries.length;
    const existingByIdentity = new Map();
    const sourceMatches = sourceEvent.instagramPostUrl
      ? await client.query(api.events.listByInstagramPostUrl, {
          instagramPostUrl: sourceEvent.instagramPostUrl,
        })
      : events;

    for (const existing of sourceMatches) {
      existingByIdentity.set(`${existing.date}:${normalizeText(existing.title)}`, existing);
    }
    summary.existingRows += existingByIdentity.size;

    for (const [index, entry] of entries.entries()) {
      const identity = entryIdentity(entry, sourceEvent);
      if (!identity) {
        summary.skippedInvalidEntries += 1;
        continue;
      }

      const patch = buildPatch(sourceEvent, entry, index, entries.length);
      if (!patch) {
        summary.skippedInvalidEntries += 1;
        continue;
      }
      const existing = existingByIdentity.get(identity);
      if (!existing) {
        summary.repairableCreates += 1;
        if (summary.examples.length < 20) {
          summary.examples.push({
            action: "create",
            sourceEventId: sourceEvent._id,
            instagramPostUrl: sourceEvent.instagramPostUrl,
            title: patch.title,
            date: patch.date,
            time: patch.time ?? null,
            venue: patch.venue,
          });
        }
        if (options.apply) {
          const createdId = await client.mutation(api.events.createEvent, patch);
          summary.appliedCreates += 1;
          existingByIdentity.set(identity, { _id: createdId, ...patch });
        }
        continue;
      }

      const updatePatch = buildSafeUpdatePatch(existing, patch);
      if (!hasMaterialPatch(existing, updatePatch) && !needsScheduleMetadataPatch(existing)) {
        continue;
      }

      summary.repairableUpdates += 1;
      if (summary.examples.length < 20) {
        summary.examples.push({
          action: "update",
          id: existing._id,
          from: {
            title: existing.title,
            date: existing.date,
            time: existing.time ?? null,
            artists: existing.artists,
          },
          to: {
            title: updatePatch.title,
            date: updatePatch.date,
            time: updatePatch.time ?? existing.time ?? null,
            artists: updatePatch.artists,
          },
        });
      }
      if (options.apply) {
        await client.mutation(api.events.updateEvent, {
          id: existing._id,
          patch: updatePatch,
        });
        summary.appliedUpdates += 1;
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: options.apply ? "apply" : "dry-run",
        statuses: options.statuses,
        limitPerStatus: options.limit,
        ...summary,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
