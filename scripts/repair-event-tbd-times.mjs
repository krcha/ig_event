import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { TBD_EVENT_TIME } from "../lib/events/event-time.ts";
import {
  CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  normalizeConfidenceScore,
} from "../lib/utils/confidence.ts";
import {
  UNVERIFIED_CORE_EVENT_SOURCE_REASON,
  getHardPendingReasons,
  hasVerifiedSourceGrounding,
} from "./source-grounding-guard.mjs";

const DEFAULT_LIMIT = 1000;
const DEFAULT_STATUSES = ["pending"];

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function usage() {
  return [
    "Usage: npm run repair:event-tbd-times -- [--apply] [--limit N] [--status pending,approved]",
    "",
    "Dry-run is the default. Sets missing event times to TBD when date confidence is high.",
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
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function readBoolean(record, key) {
  return record[key] === true;
}

export function buildPatch(event) {
  if (normalizeString(event.time)) {
    return null;
  }

  const normalizedFields = parseJson(event.normalizedFieldsJson);
  const rawExtraction = parseJson(event.rawExtractionJson);
  if (normalizeString(normalizedFields.dateConfidence) !== "high") {
    return null;
  }

  const confidenceScore = normalizeConfidenceScore(
    normalizedFields.moderationConfidenceScore ?? rawExtraction.confidence,
  );
  const missingImage = readBoolean(normalizedFields, "missingImage");
  const allowMissingImage = readBoolean(normalizedFields, "moderationAllowMissingImage");
  const titleUsedFallback = readBoolean(normalizedFields, "titleUsedFallback");
  const sourceGroundingVerified = hasVerifiedSourceGrounding(normalizedFields);
  const hardPendingReasons = getHardPendingReasons(normalizedFields);
  const suspiciousYear = readBoolean(normalizedFields, "dateSuspiciousYear");
  const lowConfidence = confidenceScore !== null && confidenceScore < 0.7;
  const autoApproved =
    sourceGroundingVerified &&
    hardPendingReasons.length === 0 &&
    !suspiciousYear &&
    normalizeString(normalizedFields.dateConfidence) !== "low" &&
    confidenceScore !== null &&
    confidenceScore >= CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD;
  const moderationSignals = uniqueStrings([
    ...hardPendingReasons,
    ...(missingImage ? ["missing_image"] : []),
    ...(allowMissingImage ? ["missing_image_allowed"] : []),
    ...(titleUsedFallback ? ["fallback_title"] : []),
    ...(!sourceGroundingVerified ? [UNVERIFIED_CORE_EVENT_SOURCE_REASON] : []),
    "time_tbd",
    ...(suspiciousYear ? ["suspicious_year"] : []),
    ...(lowConfidence ? ["low_confidence"] : []),
  ]);
  const moderationPendingReasons = autoApproved
    ? []
    : uniqueStrings([
        ...hardPendingReasons,
        ...(confidenceScore === null ? ["missing_confidence"] : []),
        ...(confidenceScore !== null && confidenceScore < CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD
          ? ["below_auto_approve_threshold"]
          : []),
        ...(missingImage && !allowMissingImage ? ["missing_image"] : []),
        ...(suspiciousYear ? ["suspicious_year"] : []),
        ...(!sourceGroundingVerified ? [UNVERIFIED_CORE_EVENT_SOURCE_REASON] : []),
      ]);

  return {
    patch: {
      time: TBD_EVENT_TIME,
      ...(autoApproved ? { status: "approved" } : {}),
      normalizedFieldsJson: JSON.stringify({
        ...normalizedFields,
        time: TBD_EVENT_TIME,
        timeTbdApplied: true,
        moderationAutoApproved: autoApproved,
        moderationAutoApproveRule: autoApproved ? "core_event_fields" : null,
        moderationCoreEventAutoApproveThreshold: CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
        moderationPendingReasons,
        moderationSignals,
        tbdTimeRepair: {
          checkedAt: new Date().toISOString(),
          from: "",
          to: TBD_EVENT_TIME,
          reason: "missing_time_with_event_date",
          script: "scripts/repair-event-tbd-times.mjs",
        },
      }),
    },
    reason: autoApproved ? "approve_core_event_fields_time_tbd" : "set_time_tbd",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  loadEnvFiles();
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required.");
  }
  const serviceSecret = process.env.CRON_SECRET;
  if (!serviceSecret) {
    throw new Error("CRON_SECRET is required.");
  }

  const client = new ConvexHttpClient(convexUrl);
  const summary = {
    scanned: 0,
    repairable: 0,
    applied: 0,
    wouldApprove: 0,
    examples: [],
  };

  for (const status of options.statuses) {
    const events = await client.query(api.events.listByStatus, {
      status,
      limit: options.limit,
      serviceSecret,
    });

    for (const event of events) {
      summary.scanned += 1;
      const result = buildPatch(event);
      if (!result) {
        continue;
      }

      summary.repairable += 1;
      if (result.patch.status === "approved") {
        summary.wouldApprove += 1;
      }
      if (summary.examples.length < 30) {
        summary.examples.push({
          id: event._id,
          status: event.status,
          date: event.date,
          title: event.title,
          venue: event.venue,
          fromTime: event.time ?? null,
          toTime: result.patch.time,
          toStatus: result.patch.status ?? event.status,
          reason: result.reason,
        });
      }

      if (options.apply) {
        await client.mutation(api.events.updateEvent, {
          id: event._id,
          patch: result.patch,
          serviceSecret,
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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
