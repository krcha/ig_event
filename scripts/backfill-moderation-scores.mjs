import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import {
  AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  calculateModerationConfidenceScore,
  normalizeConfidenceScore,
  shouldAutoApproveConfidenceScore,
} from "../lib/utils/confidence.ts";
import {
  UNVERIFIED_CORE_EVENT_SOURCE_REASON,
  getHardPendingReasons,
  hasVerifiedSourceGrounding,
} from "./source-grounding-guard.mjs";

const CAPTION_ONLY_CORE_FIELDS_MIN_CONFIDENCE = 0.8;
const REVIEWED_BY = "moderation-backfill";

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
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

function parseJsonObject(value) {
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
  return typeof value === "string" ? value.trim() : "";
}

function readString(record, key) {
  return normalizeString(record[key]);
}

function readBoolean(record, key) {
  return record[key] === true;
}

function hasCaptionEvidence(record, fieldKey) {
  const fieldConfirmation = record.fieldConfirmation;
  if (!fieldConfirmation || typeof fieldConfirmation !== "object") {
    return false;
  }
  const entry = fieldConfirmation[fieldKey];
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const foundIn = entry.found_in ?? entry.foundIn;
  return Array.isArray(foundIn)
    ? foundIn.some((value) => normalizeString(value).toLowerCase().includes("caption"))
    : false;
}

function isVideoLikePostType(value) {
  const postType = normalizeString(value).toLowerCase();
  return postType.includes("video") || postType.includes("reel");
}

export function buildBackfillDecision(event) {
  const normalizedFields = parseJsonObject(event.normalizedFieldsJson);
  const rawExtraction = parseJsonObject(event.rawExtractionJson);
  const baseConfidenceScore =
    normalizeConfidenceScore(normalizedFields.confidence) ??
    normalizeConfidenceScore(rawExtraction.confidence);
  const missingImage = !event.imageUrl;
  const postType = readString(normalizedFields, "postType");
  const extractionMode = readString(normalizedFields, "extractionMode");
  const hasVideoPostType = isVideoLikePostType(postType);
  const hasDate = Boolean(event.date || readString(normalizedFields, "normalizedDate"));
  const hasVenue = Boolean(event.venue || readString(normalizedFields, "normalizedVenue"));
  const hasTitle = Boolean(event.title || readString(normalizedFields, "title"));
  const hasCaptionCoreEvidence =
    hasCaptionEvidence(normalizedFields, "title") ||
    hasCaptionEvidence(normalizedFields, "location_name") ||
    hasCaptionEvidence(rawExtraction, "title") ||
    hasCaptionEvidence(rawExtraction, "location_name") ||
    Boolean(event.sourceCaption);
  const suspiciousYear = readBoolean(normalizedFields, "dateSuspiciousYear");
  const titleUsedFallback = readBoolean(normalizedFields, "titleUsedFallback");
  const sourceGroundingVerified = hasVerifiedSourceGrounding(normalizedFields);
  const hardPendingReasons = getHardPendingReasons(normalizedFields);
  const dateConfidence = readString(normalizedFields, "dateConfidence");
  const missingTime = !event.time;
  const timeTbdApplies = missingTime && hasDate;
  const legacyCaptionOnlyCoreFields =
    missingImage &&
    hasCaptionCoreEvidence &&
    hasDate &&
    hasVenue &&
    hasTitle &&
    !suspiciousYear &&
    dateConfidence !== "low" &&
    baseConfidenceScore !== null &&
    baseConfidenceScore >= CAPTION_ONLY_CORE_FIELDS_MIN_CONFIDENCE;
  const allowMissingImage =
    missingImage &&
    (readBoolean(normalizedFields, "moderationAllowMissingImage") ||
      extractionMode === "caption_only" ||
      hasVideoPostType ||
      legacyCaptionOnlyCoreFields);
  const confidenceScore = calculateModerationConfidenceScore(baseConfidenceScore, {
    hasSuspectedDuplicates: false,
    missingImage,
    allowMissingImage,
  });
  const strictConfidenceAutoApproved = shouldAutoApproveConfidenceScore(confidenceScore);
  const captionOnlyCoreAutoApproved =
    allowMissingImage &&
    hasDate &&
    hasVenue &&
    hasTitle &&
    !suspiciousYear &&
    dateConfidence !== "low" &&
    confidenceScore !== null &&
    confidenceScore >= CAPTION_ONLY_CORE_FIELDS_MIN_CONFIDENCE;
  const coreFieldsAutoApproved =
    hasDate &&
    hasVenue &&
    !suspiciousYear &&
    dateConfidence !== "low" &&
    confidenceScore !== null &&
    confidenceScore >= CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD;
  const autoApproveRule = sourceGroundingVerified && hardPendingReasons.length === 0
    ? strictConfidenceAutoApproved
      ? "confidence_threshold"
      : captionOnlyCoreAutoApproved
        ? hasVideoPostType
          ? "caption_only_video_core_fields"
          : "legacy_caption_only_core_fields"
        : coreFieldsAutoApproved
          ? "core_event_fields"
          : null
    : null;
  const autoApproved = autoApproveRule !== null;
  const moderationSignals = uniqueStrings([
    ...hardPendingReasons,
    ...(missingImage ? ["missing_image"] : []),
    ...(allowMissingImage ? ["missing_image_allowed"] : []),
    ...(legacyCaptionOnlyCoreFields ? ["legacy_caption_only_core_fields"] : []),
    ...(titleUsedFallback ? ["fallback_title"] : []),
    ...(!sourceGroundingVerified ? [UNVERIFIED_CORE_EVENT_SOURCE_REASON] : []),
    ...(timeTbdApplies ? ["time_tbd"] : []),
    ...(suspiciousYear ? ["suspicious_year"] : []),
    ...(confidenceScore !== null && confidenceScore < 0.7 ? ["low_confidence"] : []),
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
        ...(dateConfidence === "low" ? ["low_date_confidence"] : []),
        ...(!sourceGroundingVerified ? [UNVERIFIED_CORE_EVENT_SOURCE_REASON] : []),
      ]);
  const nextNormalizedFields = {
    ...normalizedFields,
    extractionMode: normalizedFields.extractionMode ?? (missingImage ? "caption_only" : "poster"),
    postType: normalizedFields.postType ?? null,
    missingImage,
    moderationAllowMissingImage: allowMissingImage,
    moderationMissingImageReason: missingImage
      ? allowMissingImage
        ? hasVideoPostType
          ? "video_caption_only"
          : "legacy_caption_only_core_fields"
        : "no_selected_image"
      : null,
    moderationConfidenceScore: confidenceScore,
    moderationAutoApproveThreshold: AUTO_APPROVE_CONFIDENCE_THRESHOLD,
    moderationCoreEventAutoApproveThreshold: CORE_EVENT_AUTO_APPROVE_CONFIDENCE_THRESHOLD,
    moderationCaptionOnlyVideoMinConfidence: CAPTION_ONLY_CORE_FIELDS_MIN_CONFIDENCE,
    moderationAutoApproved: autoApproved,
    moderationAutoApproveRule: autoApproveRule,
    moderationPendingReasons,
    moderationSignals,
  };

  return {
    allowMissingImage,
    autoApproved,
    autoApproveRule,
    confidenceScore,
    missingImage,
    nextNormalizedFields,
    pendingReasons: moderationPendingReasons,
    signals: moderationSignals,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
loadEnvFiles();
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
}
const serviceSecret = process.env.CRON_SECRET;
if (!serviceSecret) {
  throw new Error("CRON_SECRET is not configured.");
}

const apply = process.env.BACKFILL_APPLY === "1";
const limit = Math.max(1, Math.min(1000, Number.parseInt(process.env.BACKFILL_LIMIT ?? "500", 10) || 500));
const convex = new ConvexHttpClient(convexUrl);
const events = await convex.query(api.events.listByStatus, { status: "pending", limit, serviceSecret });

let metadataUpdated = 0;
let autoApproved = 0;
const examples = [];

for (const event of events) {
  const decision = buildBackfillDecision(event);
  const nextNormalizedFieldsJson = JSON.stringify(decision.nextNormalizedFields);
  const metadataChanged = nextNormalizedFieldsJson !== (event.normalizedFieldsJson ?? "");
  if (!metadataChanged && !decision.autoApproved) {
    continue;
  }

  metadataUpdated += metadataChanged ? 1 : 0;
  autoApproved += decision.autoApproved ? 1 : 0;
  if (examples.length < 12) {
    examples.push({
      id: event._id,
      title: event.title,
      date: event.date,
      confidenceScore: decision.confidenceScore,
      autoApproved: decision.autoApproved,
      autoApproveRule: decision.autoApproveRule,
      pendingReasons: decision.pendingReasons,
      signals: decision.signals,
    });
  }

  if (!apply) {
    continue;
  }

  await convex.mutation(api.events.updateEvent, {
    id: event._id,
    patch: {
      normalizedFieldsJson: nextNormalizedFieldsJson,
      ...(decision.autoApproved
        ? {
            status: "approved",
            reviewedAt: Date.now(),
            reviewedBy: REVIEWED_BY,
            moderationNote: `Auto-approved by moderation score backfill (${decision.autoApproveRule}).`,
          }
        : {}),
    },
    serviceSecret,
  });
}

console.log(JSON.stringify({
  apply,
  scannedPending: events.length,
  metadataUpdated,
  autoApproved,
  examples,
}, null, 2));
}
