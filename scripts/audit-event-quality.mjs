import { writeFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const DEFAULT_STATUSES = ["approved", "pending"];
const DEFAULT_APPROVED_WINDOW_DAYS_BACK = 90;
const DEFAULT_APPROVED_WINDOW_DAYS_FORWARD = 730;
const DEFAULT_PENDING_LIMIT = 500;
const SCAN_SCRIPT = "scripts/audit-event-quality.mjs";

function usage() {
  return [
    "Usage: npm run audit:event-quality -- [--apply] [--status approved,pending] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--pending-limit N] [--output path]",
    "",
    "Dry-run is the default. Use --apply to reject/repair high-confidence findings with events:updateEvent.",
    "Scans approved events by date window plus pending events by status list.",
  ].join("\n");
}

function parseArgs(argv) {
  const now = new Date();
  const defaultFrom = addIsoDays(now.toISOString().slice(0, 10), -DEFAULT_APPROVED_WINDOW_DAYS_BACK);
  const defaultTo = addIsoDays(now.toISOString().slice(0, 10), DEFAULT_APPROVED_WINDOW_DAYS_FORWARD);
  const options = {
    apply: false,
    statuses: DEFAULT_STATUSES,
    fromDate: defaultFrom,
    beforeDate: defaultTo,
    pendingLimit: DEFAULT_PENDING_LIMIT,
    outputPath: null,
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
    if (arg === "--status") {
      const next = argv[index + 1] ?? "";
      index += 1;
      const statuses = next.split(",").map((value) => value.trim()).filter(Boolean);
      const invalid = statuses.filter((status) => !["approved", "pending", "rejected"].includes(status));
      if (statuses.length === 0 || invalid.length > 0) {
        throw new Error(`Invalid --status value: ${next}`);
      }
      options.statuses = statuses;
      continue;
    }
    if (arg === "--from") {
      options.fromDate = readIsoDate(argv[++index], "--from");
      continue;
    }
    if (arg === "--to") {
      options.beforeDate = readIsoDate(argv[++index], "--to");
      continue;
    }
    if (arg === "--pending-limit") {
      const next = argv[++index];
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --pending-limit value: ${next}`);
      }
      options.pendingLimit = Math.trunc(parsed);
      continue;
    }
    if (arg === "--output") {
      options.outputPath = argv[++index] ?? null;
      if (!options.outputPath) {
        throw new Error("--output requires a path.");
      }
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.fromDate >= options.beforeDate) {
    throw new Error("--from must be before --to.");
  }

  return options;
}

function readIsoDate(value, flag) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ""))) {
    throw new Error(`${flag} requires YYYY-MM-DD.`);
  }
  return value;
}

function addIsoDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addIsoMonths(isoDate, months) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
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

function text(value) {
  return String(value ?? "").trim();
}

function normalizeText(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeVenue(value) {
  return normalizeText(value);
}

function titleContainsAlphanumeric(value) {
  return /[\p{L}\p{N}]/u.test(text(value));
}

function humanizeArtistHandle(value) {
  const handle = text(value)
    .replace(/^@+/u, "")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}._-]+$/gu, "")
    .trim();
  if (!handle) {
    return "";
  }
  return handle
    .replace(/[._-]+/gu, " ")
    .split(/\s+/gu)
    .filter(Boolean)
    .map((token) => {
      const lower = token.toLowerCase();
      if (lower.length <= 3 && /^[a-z0-9]+$/u.test(lower)) {
        return lower.toUpperCase();
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function normalizeArtistDisplayName(value) {
  return text(value)
    .replace(/[\p{Cf}]/gu, "")
    .replace(/@([\p{L}\p{N}._-]+)/gu, (_match, handle) => humanizeArtistHandle(handle))
    .replace(/^[\s]*(?:\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?|\d{1,2}\.?\s+[a-zа-яčćžšđ]+)\s*[-–—:|•·]*/iu, "")
    .replace(/[\p{Extended_Pictographic}\uFE0F]+/gu, " ")
    .replace(/^[\s"'“”‘’.,:;!?&+|/-]+|[\s"'“”‘’.,:;!?&+|/-]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeTitleDisplayName(value) {
  return text(value)
    .replace(/[\p{Cf}]/gu, "")
    .replace(/@([\p{L}\p{N}._-]+)/gu, (_match, handle) => humanizeArtistHandle(handle))
    .replace(/^[\s]*(?:\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?|\d{1,2}\.?\s+[a-zа-яčćžšđ]+)\s*[-–—:|•·]*/iu, "")
    .replace(/[\p{Extended_Pictographic}\uFE0F]+/gu, " ")
    .replace(/^[\s.,:;!?&+|/-]+|[\s.,:;!?&+|/-]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function formatArtistTitleList(artists) {
  const displayArtists = unique(
    artists.map(normalizeArtistDisplayName).filter((artist) => titleContainsAlphanumeric(artist)),
  );
  if (displayArtists.length <= 2) {
    return displayArtists.join(" & ");
  }
  return `${displayArtists.slice(0, -1).join(", ")} & ${displayArtists.at(-1)}`;
}

function isMeaninglessTitle(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return true;
  }
  const tokens = normalized.split(/\s+/gu).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => ["and", "b2b", "x"].includes(token));
}

function escapeRegExp(value) {
  return text(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceStandaloneText(value, oldText, newText) {
  const pattern = escapeRegExp(oldText).replace(/\s+/gu, "\\s+");
  if (!pattern) {
    return value;
  }
  return text(value)
    .replace(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "giu"), newText)
    .replace(/\s+/gu, " ")
    .trim();
}

function splitArtistLikeText(value) {
  return text(value)
    .split(/\s*(?:,|&|\+|\bx\b|\bb2b\b|\band\b)\s*/iu)
    .map(normalizeArtistDisplayName)
    .filter((artist) => titleContainsAlphanumeric(artist));
}

function extractArtistsFromSourceLine(value) {
  const source = text(value)
    .replace(/[\p{Cf}]/gu, "")
    .replace(/^\s*(?:\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?|\d{1,2}\.?\s+[a-zа-яčćžšđ]+|subota|nedelja|nedjelja|petak|sreda|utorak|ponedeljak|četvrtak|cetvrtak|uto|sre|čet|cet|pet|sub|ned|july\s+\d{1,2})\s*[-–—:|•·]*/iu, "")
    .replace(/\bsa\b/giu, " ");
  return splitArtistLikeText(source);
}

function unique(values) {
  const results = [];
  const seen = new Set();
  for (const value of values.filter(Boolean)) {
    const key = normalizeText(value);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(value);
  }
  return results;
}

function independentTextEvidence(event, normalizedFields) {
  return unique([
    text(event.sourceCaption),
    text(normalizedFields?.postAltText),
  ]).join("\n");
}

function combinedSourceText(event, normalizedFields, rawExtraction) {
  return unique([
    event.title,
    event.venue,
    event.description,
    event.sourceCaption,
    normalizedFields?.postAltText,
    normalizedFields?.sourceCaptionFromModel,
    normalizedFields?.splitSourceLine,
    normalizedFields?.reasoningNotes,
    rawExtraction?.source_caption,
    rawExtraction?.reasoning_notes,
    JSON.stringify(rawExtraction?.schedule_entries ?? []),
  ].map(text)).join("\n");
}

function isTbdEvent(event, normalizedFields) {
  return text(event.time).toUpperCase() === "TBD" || normalizedFields?.timeTbdApplied === true;
}

function hasUnverifiedPosterScheduleTbd(event, normalizedFields) {
  return (
    normalizedFields?.splitSource === "poster_schedule" &&
    isTbdEvent(event, normalizedFields) &&
    !independentTextEvidence(event, normalizedFields)
  );
}

function hasGenericTbdDjSetWithoutEvidence(event, normalizedFields) {
  return (
    isTbdEvent(event, normalizedFields) &&
    !independentTextEvidence(event, normalizedFields) &&
    /^DJ set at .+ venue\.?$/iu.test(text(event.description))
  );
}

function hasAndricMuzejMismatch(event, sourceText) {
  return (
    /andri[cć]|андрић/iu.test(sourceText) &&
    !/muzej grada beograda|музеј града београда/iu.test(text(event.venue))
  );
}

function hasNonEventClosureNotice(sourceText) {
  return /\bclosed\s+for\s+vacation\b|\bcollective\s+vacation\b|\bkolektivni\s+godi[sš]nji\s+odmor\b|\bgodi[sš]nji\s+odmor\b|\bzatvoreno\s+(?:zbog|radi|od)\b/iu.test(
    normalizeText(sourceText),
  );
}

function isShortIcaVenue(event) {
  return ["ica", "ица"].includes(normalizeVenue(event.venue));
}

function buildShortIcaRepairPatch(sourceText) {
  if (!sourceText) {
    return null;
  }
  if (/ku[cć]ica\s+na\s+vodi|кућица\s+на\s+води/iu.test(sourceText)) {
    return { venue: "Kućica na vodi" };
  }
  if (/ljubica|љубица/iu.test(sourceText)) {
    return { venue: "Ljubica Beograd" };
  }
  if (/botanical\s+garden\s+jevremovac|jevremovac|јевремовац/iu.test(sourceText)) {
    return { venue: "Botanical Garden Jevremovac" };
  }
  return null;
}

function getScheduleEntryForEvent(normalizedFields, rawExtraction) {
  const scheduleEntries = Array.isArray(rawExtraction?.schedule_entries)
    ? rawExtraction.schedule_entries
    : [];
  const splitSourceLine = normalizeText(normalizedFields?.splitSourceLine);
  if (!splitSourceLine) {
    return null;
  }
  return scheduleEntries.find((entry) => normalizeText(entry?.source_text) === splitSourceLine) ?? null;
}

function parseScheduleEntryDateIso(value, fallbackYear) {
  const raw = text(value).replace(/[\p{Cf}]/gu, "");
  const match = raw.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?\b/u);
  if (!match) {
    return null;
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = match[3] ? Number(match[3]) : fallbackYear;
  if (year < 100) {
    year += 2000;
  }
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const WEEKDAY_PREFIX_TO_DAY = new Map([
  ["ned", 0],
  ["nedelja", 0],
  ["nedjelja", 0],
  ["sun", 0],
  ["sunday", 0],
  ["pon", 1],
  ["ponedeljak", 1],
  ["mon", 1],
  ["monday", 1],
  ["uto", 2],
  ["utorak", 2],
  ["tue", 2],
  ["tuesday", 2],
  ["sre", 3],
  ["sreda", 3],
  ["wed", 3],
  ["wednesday", 3],
  ["cet", 4],
  ["čet", 4],
  ["cetvrtak", 4],
  ["četvrtak", 4],
  ["thu", 4],
  ["thursday", 4],
  ["pet", 5],
  ["petak", 5],
  ["fri", 5],
  ["friday", 5],
  ["sub", 6],
  ["subota", 6],
  ["sat", 6],
  ["saturday", 6],
]);

function weekdayForIsoDate(value) {
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.getUTCDay();
}

function readScheduleWeekday(entry) {
  const source = normalizeText(entry?.source_text ?? entry?.title ?? "");
  const firstToken = source.split(/\s+/u)[0] ?? "";
  return WEEKDAY_PREFIX_TO_DAY.get(firstToken) ?? null;
}

function selectScheduleEntriesForEvent(event, rawExtraction) {
  const scheduleEntries = Array.isArray(rawExtraction?.schedule_entries)
    ? rawExtraction.schedule_entries
    : [];
  if (scheduleEntries.length === 0) {
    return [];
  }

  const eventYear = Number(text(event.date).slice(0, 4));
  const datedMatches = scheduleEntries.filter((entry) =>
    parseScheduleEntryDateIso(entry?.date || entry?.source_text, eventYear) === event.date,
  );
  if (datedMatches.length > 0) {
    return datedMatches;
  }

  const eventWeekday = weekdayForIsoDate(event.date);
  if (eventWeekday !== null) {
    const weekdayMatches = scheduleEntries.filter((entry) => readScheduleWeekday(entry) === eventWeekday);
    if (weekdayMatches.length > 0) {
      return weekdayMatches;
    }
  }

  return scheduleEntries.length === 1 ? scheduleEntries : [];
}

function isWeakPublicTitle(event, normalizedFields) {
  const title = text(event.title);
  const normalizedTitle = normalizeText(title);
  const normalizedVenue = normalizeVenue(event.venue);
  if (isMeaninglessTitle(title)) {
    return true;
  }
  if (normalizedTitle && normalizedVenue && normalizedTitle === normalizedVenue) {
    return true;
  }
  return /^event\b|^nightlife event\b|^live music event\b/iu.test(title);
}

function titleFromCaption(event) {
  const firstMeaningfulLine = text(event.sourceCaption)
    .split(/\r?\n/u)
    .map((line) => text(line).replace(/[\p{Cf}]/gu, ""))
    .find((line) => /[\p{L}\p{N}]/u.test(line) && line.length <= 90);
  if (!firstMeaningfulLine) {
    return "";
  }
  return firstMeaningfulLine
    .replace(/^\s*[•·|-]+\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function buildSourceGroundedTitleRepairPatch(event, normalizedFields, rawExtraction) {
  if (!isWeakPublicTitle(event, normalizedFields)) {
    return null;
  }

  const exactScheduleEntry = getScheduleEntryForEvent(normalizedFields, rawExtraction);
  const scheduleEntries = exactScheduleEntry
    ? [exactScheduleEntry]
    : selectScheduleEntriesForEvent(event, rawExtraction);
  const scheduleArtists = unique(scheduleEntries.flatMap((entry) => [
    ...(Array.isArray(entry?.artists) ? entry.artists : []),
  ]).map(normalizeArtistDisplayName)).filter((artist) => titleContainsAlphanumeric(artist));
  const scheduleTitles = unique(scheduleEntries
    .map((entry) => normalizeTitleDisplayName(entry?.title))
    .filter((title) =>
      titleContainsAlphanumeric(title) &&
      !isMeaninglessTitle(title) &&
      normalizeText(title) !== normalizeVenue(event.venue) &&
      !/^\d{1,2}(?::\d{2})?\s*h?$/iu.test(normalizeText(title)),
    ));

  const existingArtists = unique([
    ...(Array.isArray(normalizedFields?.artists) ? normalizedFields.artists.map(normalizeArtistDisplayName) : []),
    ...(Array.isArray(event.artists) ? event.artists.map(normalizeArtistDisplayName) : []),
  ]).filter((artist) => titleContainsAlphanumeric(artist) && normalizeText(artist) !== normalizeVenue(event.venue));
  const splitLineArtists = extractArtistsFromSourceLine(normalizedFields?.splitSourceLine);
  const artists = unique([
    ...scheduleArtists,
    ...(scheduleArtists.length === 0 && scheduleTitles.length === 0 ? splitLineArtists : []),
    ...(scheduleArtists.length === 0 && scheduleTitles.length === 0 ? existingArtists : []),
  ]).filter((artist) => titleContainsAlphanumeric(artist) && normalizeText(artist) !== normalizeVenue(event.venue));

  const title =
    (artists.length > 0 ? formatArtistTitleList(artists) : "") ||
    (scheduleTitles.length > 0 ? formatArtistTitleList(scheduleTitles) : "") ||
    titleFromCaption(event);
  if (!title || normalizeText(title) === normalizeText(event.title)) {
    return null;
  }

  return {
    title,
    ...(artists.length > 0 ? { artists } : {}),
  };
}

function buildWeakDescriptionRepairPatch(event, normalizedFields) {
  const description = text(event.description);
  if (!description) {
    return null;
  }
  const artistTitle = formatArtistTitleList([
    ...(Array.isArray(event.artists) ? event.artists : []),
    ...(Array.isArray(normalizedFields?.artists) ? normalizedFields.artists : []),
  ].filter((artist) => titleContainsAlphanumeric(artist) && !isMeaninglessTitle(artist)));
  if (!artistTitle) {
    return null;
  }

  const weakTitleCandidates = unique([
    normalizedFields?.title,
    normalizedFields?.rawTitle,
  ].map(text)).filter((candidate) => isMeaninglessTitle(candidate));

  for (const weakTitle of weakTitleCandidates) {
    const repaired = replaceStandaloneText(description, weakTitle, artistTitle);
    if (repaired && repaired !== description) {
      return { description: repaired };
    }
  }

  return null;
}

function buildFindings(event) {
  const normalizedFields = parseJson(event.normalizedFieldsJson);
  const rawExtraction = parseJson(event.rawExtractionJson);
  const sourceText = combinedSourceText(event, normalizedFields, rawExtraction);
  const findings = [];
  const sourceGroundedTitleRepairPatch = buildSourceGroundedTitleRepairPatch(
    event,
    normalizedFields,
    rawExtraction,
  );

  if (sourceGroundedTitleRepairPatch) {
    findings.push({
      kind: "weak_title_source_grounded_repair",
      severity: "repair",
      reason: "Weak/fallback public title can be replaced with a source-grounded artist, lineup, or caption title.",
      patch: sourceGroundedTitleRepairPatch,
    });
  }

  const weakDescriptionRepairPatch = buildWeakDescriptionRepairPatch(event, normalizedFields);
  if (weakDescriptionRepairPatch) {
    findings.push({
      kind: "weak_description_source_grounded_repair",
      severity: "repair",
      reason: "Generated description still contains a meaningless fallback title and can be repaired from event artists.",
      patch: weakDescriptionRepairPatch,
    });
  }

  if (hasUnverifiedPosterScheduleTbd(event, normalizedFields)) {
    findings.push({
      kind: "unverified_poster_schedule_tbd",
      severity: "reject",
      reason: "Model-only poster_schedule split has no scraped caption/alt evidence and no time.",
    });
  }

  if (hasNonEventClosureNotice(sourceText)) {
    findings.push({
      kind: "non_event_closure_notice",
      severity: "reject",
      reason: "Closure/vacation/operational notice is not a public event.",
    });
  }

  if (hasGenericTbdDjSetWithoutEvidence(event, normalizedFields)) {
    findings.push({
      kind: "generic_tbd_dj_set_without_evidence",
      severity: "reject",
      reason: "Generic generated DJ-set description with TBD time and no scraped caption/alt evidence.",
    });
  }

  if (hasAndricMuzejMismatch(event, sourceText)) {
    findings.push({
      kind: "andric_muzej_mismatch",
      severity: "repair",
      reason: "Source mentions Andrić/Memorial Museum but venue is not canonical Muzej grada Beograda.",
      patch: { venue: "Muzej grada Beograda" },
    });
  }

  if (isShortIcaVenue(event)) {
    const repairPatch = buildShortIcaRepairPatch(sourceText);
    findings.push({
      kind: repairPatch ? "short_venue_ica_repair" : "short_venue_ica",
      severity: repairPatch ? "repair" : "review",
      reason: repairPatch
        ? "Known false-positive `ica` venue can be repaired from source venue evidence."
        : "Short venue name `ica` is a known false-positive risk.",
      ...(repairPatch ? { patch: repairPatch } : {}),
    });
  }

  if (!independentTextEvidence(event, normalizedFields) && isTbdEvent(event, normalizedFields)) {
    findings.push({
      kind: "model_only_tbd_without_independent_evidence",
      severity: "review",
      reason: "TBD event lacks independent scraped caption/alt evidence.",
    });
  }

  return { findings, normalizedFields, rawExtraction, sourceText };
}

function chooseAction(event, findings) {
  const rejectFindings = findings.filter((finding) => finding.severity === "reject");
  if (rejectFindings.length > 0 && event.status !== "rejected") {
    return {
      action: "reject",
      patch: {
        status: "rejected",
        reviewedAt: Date.now(),
        reviewedBy: "event-quality-audit",
        moderationNote: `Rejected by ${SCAN_SCRIPT}: ${rejectFindings.map((finding) => finding.kind).join(", ")}.`,
      },
    };
  }

  const repairFindings = findings.filter((finding) => finding.severity === "repair" && finding.patch);
  if (repairFindings.length > 0) {
    const patch = Object.assign({}, ...repairFindings.map((finding) => finding.patch));
    return {
      action: "repair",
      patch: {
        ...patch,
        reviewedAt: Date.now(),
        reviewedBy: "event-quality-audit",
        moderationNote: `Repaired by ${SCAN_SCRIPT}: ${repairFindings.map((finding) => finding.kind).join(", ")}.`,
      },
    };
  }

  return null;
}

async function loadEventsForStatus(client, serviceArgs, options, status) {
  if (status !== "approved") {
    return client.query(api.events.listByStatus, {
      status,
      limit: options.pendingLimit,
      ...serviceArgs,
    });
  }

  const seen = new Map();
  for (let from = options.fromDate; from < options.beforeDate;) {
    const before = addIsoMonths(from, 1) < options.beforeDate ? addIsoMonths(from, 1) : options.beforeDate;
    const events = await client.query(api.events.listByStatusDateWindow, {
      status,
      fromDate: from,
      beforeDate: before,
      ...serviceArgs,
    });
    for (const event of events) {
      seen.set(event._id, event);
    }
    from = before;
  }
  return [...seen.values()];
}

function summarizeFindings(findings) {
  const byKind = {};
  const bySeverity = {};
  for (const finding of findings) {
    byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
  }
  return { byKind, bySeverity };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required.");
  }
  const serviceSecret = process.env.CRON_SECRET?.trim();
  if (!serviceSecret) {
    throw new Error("CRON_SECRET is required for event quality audit.");
  }

  const client = new ConvexHttpClient(convexUrl);
  const serviceArgs = { serviceSecret };
  const summary = {
    mode: options.apply ? "apply" : "dry-run",
    statuses: options.statuses,
    approvedWindow: { fromDate: options.fromDate, beforeDate: options.beforeDate },
    pendingLimit: options.pendingLimit,
    scanned: 0,
    loadedByStatus: {},
    findingTotals: {},
    actionable: 0,
    applied: 0,
    actionsByType: {},
    examples: [],
  };
  const allFindings = [];

  for (const status of options.statuses) {
    const events = await loadEventsForStatus(client, serviceArgs, options, status);
    summary.loadedByStatus[status] = events.length;
    for (const event of events) {
      summary.scanned += 1;
      const { findings } = buildFindings(event);
      if (findings.length === 0) {
        continue;
      }
      const action = chooseAction(event, findings);
      if (action) {
        summary.actionable += 1;
        summary.actionsByType[action.action] = (summary.actionsByType[action.action] ?? 0) + 1;
      }

      const findingRecord = {
        id: event._id,
        status: event.status,
        title: event.title,
        date: event.date,
        time: event.time,
        venue: event.venue,
        instagramPostUrl: event.instagramPostUrl,
        findings: findings.map(({ kind, severity, reason }) => ({ kind, severity, reason })),
        action: action?.action ?? null,
        ...(action ? { patchPreview: action.patch } : {}),
      };
      allFindings.push(findingRecord);
      if (summary.examples.length < 30) {
        summary.examples.push(findingRecord);
      }

      if (options.apply && action) {
        await client.mutation(api.events.updateEvent, {
          id: event._id,
          patch: action.patch,
          ...serviceArgs,
        });
        summary.applied += 1;
      }
    }
  }

  Object.assign(summary.findingTotals, summarizeFindings(allFindings.flatMap((event) => event.findings)));
  const result = { summary, findings: allFindings };
  if (options.outputPath) {
    writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
