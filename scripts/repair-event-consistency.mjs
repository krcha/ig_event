import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import {
  looksLikeBareDate,
  sanitizeTimeAgainstDate,
} from "../lib/events/event-validation.ts";

const DEFAULT_LIMIT = 200;
const DEFAULT_STATUSES = ["approved", "pending"];

function usage() {
  return [
    "Usage: npm run repair:event-consistency -- [--apply] [--limit N] [--status approved,pending]",
    "",
    "Dry-run is the default. Use --apply to patch matching events with events:updateEvent.",
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

function normalizeHandleText(value) {
  return String(value ?? "")
    .trim()
    .replace(/^@/u, "")
    .toLowerCase();
}

function isHandleDerivedTitle(event, normalizedFields) {
  const title = String(event.title ?? "").trim();
  if (!title) {
    return false;
  }

  if (normalizedFields?.titleSource === "handle_fallback") {
    return true;
  }

  const firstWord = normalizeHandleText(title.split(/\s+/u)[0]);
  const sourceHandle = normalizeHandleText(event.sourceHandle ?? event.instagramHandle);
  return Boolean(sourceHandle && firstWord === sourceHandle);
}

function normalizeDateCandidate(rawDate, fallbackIsoDate, postedAt) {
  const value = String(rawDate ?? "").trim();
  if (!value) {
    return "";
  }

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (isoMatch) {
    return value;
  }

  const ddmmMatch = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/.exec(value);
  if (!ddmmMatch) {
    return "";
  }

  const fallbackYear =
    fallbackIsoDate?.slice(0, 4) ||
    (postedAt && !Number.isNaN(new Date(postedAt).getTime())
      ? String(new Date(postedAt).getUTCFullYear())
      : "");
  const rawYear = ddmmMatch[3];
  const year = rawYear
    ? rawYear.length === 2
      ? `20${rawYear}`
      : rawYear
    : fallbackYear;
  if (!year) {
    return "";
  }

  return [
    year,
    String(Number(ddmmMatch[2])).padStart(2, "0"),
    String(Number(ddmmMatch[1])).padStart(2, "0"),
  ].join("-");
}

function cleanScheduleTitle(value) {
  const title = String(value ?? "")
    .replace(/^@/u, "")
    .trim();
  return title.length > 1 ? title : "";
}

function getScheduleEntries(rawExtraction) {
  const entries = Array.isArray(rawExtraction?.schedule_entries)
    ? rawExtraction.schedule_entries
    : [];
  return entries;
}

function findScheduleEntryForEvent(event, normalizedFields, rawExtraction) {
  const entries = getScheduleEntries(rawExtraction);
  const splitIndex = Number(normalizedFields?.splitEventIndex);
  if (Number.isInteger(splitIndex) && splitIndex >= 1 && splitIndex <= entries.length) {
    return entries[splitIndex - 1];
  }

  const matches = [];
  for (const entry of entries) {
    const entryDate = normalizeDateCandidate(entry?.date, event.date, event.sourcePostedAt);
    if (entryDate && entryDate === event.date) {
      matches.push(entry);
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

function getRowTitleFromScheduleEntry(entry) {
  const title = cleanScheduleTitle(entry?.title);
  if (title) {
    return title;
  }

  const artist = Array.isArray(entry?.artists)
    ? entry.artists.map(cleanScheduleTitle).find(Boolean)
    : "";
  if (artist) {
    return artist;
  }

  return "";
}

function getRowTimeFromScheduleEntry(entry) {
  const rawTime = String(entry?.time ?? "").trim();
  if (!rawTime) {
    return "";
  }

  return sanitizeTimeAgainstDate(rawTime, entry?.date);
}

function buildRepair(event) {
  const normalizedFields = parseJson(event.normalizedFieldsJson) ?? {};
  const rawExtraction = parseJson(event.rawExtractionJson);
  const scheduleEntry = findScheduleEntryForEvent(event, normalizedFields, rawExtraction);
  const patch = {};
  const repairs = [];
  const unrecoverable = [];

  if (scheduleEntry) {
    const rowDate = normalizeDateCandidate(
      scheduleEntry.date,
      event.date,
      event.sourcePostedAt,
    );
    const splitIndex = Number(normalizedFields?.splitEventIndex);
    if (rowDate && rowDate !== event.date && Number.isInteger(splitIndex)) {
      patch.date = rowDate;
      repairs.push({
        field: "date",
        from: event.date,
        to: rowDate,
        reason: "schedule_entry_date",
      });
    }
  }

  if (looksLikeBareDate(event.time)) {
    const rowTime = getRowTimeFromScheduleEntry(scheduleEntry);
    patch.time = rowTime || "";
    repairs.push({
      field: "time",
      from: event.time,
      to: patch.time,
      reason: rowTime ? "schedule_entry_time" : "date_shaped_time",
    });
  }

  if (isHandleDerivedTitle(event, normalizedFields)) {
    const replacementTitle = getRowTitleFromScheduleEntry(scheduleEntry);
    if (replacementTitle && replacementTitle !== event.title) {
      patch.title = replacementTitle;
      repairs.push({
        field: "title",
        from: event.title,
        to: replacementTitle,
        reason: "schedule_entry_title",
      });
    } else {
      unrecoverable.push({
        field: "title",
        value: event.title,
        reason: "handle_derived_title_without_schedule_entry",
      });
    }
  }

  if (repairs.length === 0) {
    return { patch: null, repairs, unrecoverable };
  }

  patch.normalizedFieldsJson = JSON.stringify({
    ...normalizedFields,
    consistencyRepair: {
      checkedAt: new Date().toISOString(),
      repairs,
      script: "scripts/repair-event-consistency.mjs",
    },
  });

  return { patch, repairs, unrecoverable };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required.");
  }

  const client = new ConvexHttpClient(convexUrl);
  const summary = {
    scanned: 0,
    repairable: 0,
    applied: 0,
    unrecoverable: 0,
    examples: [],
    unrecoverableExamples: [],
  };

  for (const status of options.statuses) {
    const events = await client.query(api.events.listByStatus, {
      status,
      limit: options.limit,
    });

    for (const event of events) {
      summary.scanned += 1;
      const { patch, repairs, unrecoverable } = buildRepair(event);
      if (unrecoverable.length > 0) {
        summary.unrecoverable += 1;
        if (summary.unrecoverableExamples.length < 20) {
          summary.unrecoverableExamples.push({
            id: event._id,
            status: event.status,
            title: event.title,
            date: event.date,
            unrecoverable,
          });
        }
      }
      if (!patch) {
        continue;
      }

      summary.repairable += 1;
      if (summary.examples.length < 20) {
        summary.examples.push({
          id: event._id,
          status: event.status,
          title: event.title,
          date: event.date,
          repairs,
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
