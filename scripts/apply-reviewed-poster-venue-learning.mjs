import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ConvexHttpClient } from "convex/browser";

/**
 * Audited production operator for the reviewed 2026-08-27 poster/venue fixes.
 *
 * Phase 1 (`config`) canonicalizes the reviewed venue/source identities.
 * Phase 2 (`events`) performs receipt-aware event corrections/folds and only
 * then retires the historical INFUSE-as-venue record.
 *
 * A dry-run plan is immutable and digest-gated. Apply reads that same plan from disk,
 * checks every exact preimage and revision, and accepts only an exact verified
 * after-state when resuming after a lost acknowledgement. This script never
 * calls the legacy generic trusted-venue repair mutation.
 */

const PLAN_ENVELOPE_SCHEMA =
  "event-zeka-reviewed-poster-venue-plan-envelope-v2";
const CONFIG_PLAN_SCHEMA = "event-zeka-reviewed-poster-venue-config-plan-v2";
const EVENT_PLAN_SCHEMA = "event-zeka-reviewed-poster-venue-event-plan-v3";
const RESULT_SCHEMA = "event-zeka-reviewed-poster-venue-result-v2";
const TARGET_SET_VERSION = "event-zeka-poster-venue-learning-2026-08-27:v3";
const REVIEWED_INVENTORY_CUTOFF_DATE = "2026-08-27";
const INVENTORY_PAGE_SIZE = 200;
const MAX_INVENTORY_PAGES = 64;
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const READ_QUERY_MAX_ATTEMPTS = 3;
const READ_QUERY_RETRY_BASE_DELAY_MS = 150;
const TRANSIENT_QUERY_ERROR_PATTERN =
  /\b(?:server error|terminated|network(?: error)?|socket(?: hang up)?|fetch (?:failed|error)|timeout|timed out|aborterror|aborted|connection (?:closed|reset|refused|terminated)|temporarily unavailable|service unavailable|gateway timeout|too many requests|rate limit(?:ed)?|econnreset|econnrefused|ehostunreach|enetunreach|enotfound|eai_again|etimedout|epipe|und_err_[a-z_]+)\b/iu;
const DETERMINISTIC_QUERY_ERROR_PATTERN =
  /\b(?:argumentvalidationerror|convexerror|unauthorized|forbidden|permission denied|uncaught (?:error|typeerror|rangeerror|referenceerror)|invalid (?:argument|value|id|cursor)|does not match|changed after plan review)\b/iu;
const CONFIG_CONFIRMATION = "APPLY_EVENT_ZEKA_REVIEWED_CONFIG_2026_08_27";
const EVENT_CONFIRMATION = "APPLY_EVENT_ZEKA_REVIEWED_EVENTS_2026_08_27";
const REVIEWED_VENUE_NOTE =
  "Human-reviewed exact venue correction after the historical venue-normalization loss; public fields and source receipt remain coherent.";

// All backend calls are isolated here so a reviewed function rename changes
// one line rather than touching the safety/state-machine logic.
const API = Object.freeze({
  correctionContext: "events:getReviewedStructuredEvidenceCorrectionContext",
  receipt: "events:getInstagramSourceOccurrenceReceipt",
  venueRepair: "events:repairReviewedStructuredEventVenue",
  promotionFold: "events:foldReviewedStructuredPromotionVariant",
  continuationFold: "events:foldReviewedStructuredSameSourceContinuation",
  eventsByIds: "events:getManyByIds",
  eventsByStatusPaginated: "events:listByStatusPaginated",
  venues: "venues:listVenues",
  venueUpdate: "venues:updateVenue",
  sourceByHandle: "instagramSources:getByHandle",
  sourceRoleUpdate: "instagramSources:setRole",
});

const VENUE_SPECS = Object.freeze([
  {
    id: "k17fwkwaz0z0pttbardftynzrx8ba9gh",
    handle: "vera.belgrade",
    name: "Vera",
    requestedAliases: ["Vera Belgrade"],
    publicStatus: "published",
    scrapeActive: true,
  },
  {
    id: "k17bbpsrzf9b8g88neq2e0bams897v0e",
    handle: "mehuric.rs",
    name: "Višnjićeva 7",
    requestedAliases: ["Prvi champagne bar & shop u Beogradu"],
    location: "Višnjićeva 7",
    publicStatus: "published",
    scrapeActive: true,
  },
  {
    id: "k170r2rsf8kbcartezm31xab89897993",
    handle: "leto_belgrade",
    name: "Leto",
    requestedAliases: ["Splav Leto"],
    location: "Kej Kula Nebojša",
    publicStatus: "published",
    scrapeActive: true,
  },
  {
    id: "k177scs2zpr0a6cpg33argkzmd897mav",
    handle: "freestylerbelgrade_official",
    name: "Freestyler",
    requestedAliases: ["Freestyler Belgrade Nightclub", "Splav Freestyler"],
    location: "Obala kralja Aleksandra I Karađorđevića 100, Zemunski kej",
    publicStatus: "published",
    scrapeActive: true,
  },
  {
    id: "k177jw2vwtbprvgbybvgh9pm2d897vc8",
    handle: "dimsam___",
    name: "Dim",
    requestedAliases: ["dim • sam"],
    location: "Cetinjska 15",
    publicStatus: "published",
    scrapeActive: true,
  },
  {
    id: "k172s78g31ea0g7g9kqrqj729x8979e4",
    handle: "_azbuka",
    name: "Azbuka",
    requestedAliases: ["Azbuka / Restaurant & Bar"],
    location: "Kralja Milana 2",
    publicStatus: "published",
    scrapeActive: true,
  },
  {
    id: "k172gb0c7tn740h66t137ddrqx897gjh",
    handle: "benakibabeograd",
    name: "Ben Akiba",
    requestedAliases: ["Ben Akiba Beograd"],
    location: "Braće Krsmanović 6",
    publicStatus: "published",
    scrapeActive: true,
  },
]);

const INFUSE_SPEC = Object.freeze({
  id: "k178gjexhdsh3exbg376a4ppph896esv",
  handle: "infuse.rs",
  name: "INFUSE",
});

const SOURCE_SPECS = Object.freeze([
  ...VENUE_SPECS.map((venue) => ({
    handle: venue.handle,
    role: "venue",
    venueId: venue.id,
  })),
  { handle: INFUSE_SPEC.handle, role: "promoter", venueId: null },
]);

// This is the complete non-expired approved inventory for the reviewed venue
// handles, excluding rows handled atomically by the fold operations below.
const VENUE_REPAIR_GROUPS = Object.freeze([
  {
    venueId: "k17fwkwaz0z0pttbardftynzrx8ba9gh",
    sourceHandle: "vera.belgrade",
    ids: [
      "j57fm9xh2sax7n2kjy5vynpcg98d5f9a",
      "j578dj6hy5c5jk3h4w54vmzy158d7p7r",
      "j572h6vqmnmvc4rsr19mhhzeq18czw2w",
    ],
    evidence:
      "The reviewed source account @vera.belgrade identifies the physical venue as Vera.",
  },
  {
    venueId: "k17bbpsrzf9b8g88neq2e0bams897v0e",
    sourceHandle: "mehuric.rs",
    ids: ["j57727kq6hvms8qnqam0e5qxws8d3xhr"],
    evidence:
      "The @mehuric.rs caption identifies its summer terrace/Letnji Mehurić at the exact physical address Višnjićeva 7; the reviewed address fallback is retained as the canonical display name while the previous brand name remains an alias.",
  },
  {
    venueId: "k170r2rsf8kbcartezm31xab89897993",
    sourceHandle: "leto_belgrade",
    ids: ["j5797r05nxraw6f22xnzphjkj18d3sph"],
    evidence:
      "The reviewed poster, caption, and @leto_belgrade source identify Leto.",
  },
  {
    venueId: "k177scs2zpr0a6cpg33argkzmd897mav",
    sourceHandle: "freestylerbelgrade_official",
    ids: [
      "j572s3nx1hepy3j4stfd488d318d095m",
      "j57a0838r5hy4gp2rd19rnxk9x8d2b78",
      "j573vv2mw0hqge31te09y2tsz18d5r18",
    ],
    evidence:
      "The reviewed poster/caption and @freestylerbelgrade_official identify Freestyler.",
  },
  {
    venueId: "k177jw2vwtbprvgbybvgh9pm2d897vc8",
    sourceHandle: "dimsam___",
    ids: [
      "j570ap0de799swq27gmbc2b89d8d1wmq",
      "j57164wmgbhmdd492054my6q958d98b3",
      "j57cbkd48ac7mmc7rq3sdw9z4d8d7pfp",
    ],
    evidence:
      "The reviewed source account @dimsam___ and caption identify the venue as Dim.",
  },
  {
    venueId: "k172s78g31ea0g7g9kqrqj729x8979e4",
    sourceHandle: "_azbuka",
    ids: ["j575dmrm4519kk1d48qx4t0pd18d2ev8"],
    evidence:
      "The reviewed source account @_azbuka identifies the physical venue as Azbuka.",
  },
]);

const SKI_FOLD = Object.freeze({
  operationId: "reviewed-poster-venue-2026-08-27:ski-staza-infuse",
  primaryId: "j5794p4q0dk7e8jb2665vn7aqn8d0gqa",
  variantId: "j5779z5wxfbmfw1t5phmjvjdws8d871s",
  expectedSourceHandle: "infuse.rs",
  campaignAnchors: ["INFUSE"],
  primaryDuplicateEvidence: ["Ovaj četvrtak pripada Ski Stazi"],
  variantDuplicateEvidence: ["Chapter four starts tomorrow"],
  nextTitle: "INFUSE",
  nextTime: "19:00-01:00",
  nextVenue: "Ski Staza",
  nextArtists: ["Eelke Kleijn", "Gorber", "Despic"],
  nextDescription:
    "INFUSE at Ski Staza with Eelke Kleijn, Gorber and Despic, from 19:00 to 01:00.",
  posterVenueEvidence: "KOŠUTNJAK SKI STAZA",
  posterTimeEvidence: "19H - 01H",
  posterArtistEvidence: ["EELKE KLEIJN", "GORBER", "DESPIC"],
  moderationNote:
    "Human-reviewed fold: Ski Staza is the physical venue, INFUSE is the promoter, and both posts describe the same 27 August campaign occurrence.",
});

const KNEZ_FOLD = Object.freeze({
  operationId: "reviewed-poster-venue-2026-08-27:freestyler-knez",
  primaryId: "j570bwvh2qpaajv2x1kncz2h0x8d8e01",
  variantId: "j576mws8wy20xtnhftbm1n8xk58czxsq",
  targetVenueId: "k177scs2zpr0a6cpg33argkzmd897mav",
  expectedSourceHandle: "freestylerbelgrade_official",
  campaignAnchors: ["KNEZ", "Freestyler"],
  primaryDuplicateEvidence: ["KNEZ LIVE @ FREESTYLER"],
  variantDuplicateEvidence: [
    "This Thursday, 90s PARTY with special guest KNEZ",
  ],
  posterVenueEvidence: "Freestyler",
  posterTimeEvidence: "od 23h",
  posterArtistEvidence: ["KNEZ"],
  moderationNote:
    "Human-reviewed fold: both Freestyler posts advertise the same Knez event on the same date; the TBD teaser is folded into the explicit 23:00 occurrence.",
});

const BEN_FOLD = Object.freeze({
  operationId: "reviewed-poster-venue-2026-08-27:ben-akiba-weekend",
  independentId: "j570tcpav8ejq9eb7b88ney9mn8d0nzc",
  primaryId: "j579c8e1xjc5cacbrnrrnra7e58d0qj7",
  continuationId: "j570mpbsjgpgjfz3darfbxnf7n8d1e6r",
  targetVenueId: "k172gb0c7tn740h66t137ddrqx897gjh",
  expectedSourceHandle: "benakibabeograd",
  primaryScheduleSourceText:
    "Saturday begins with Disco Retro Party from 8 PM, where DJ Munja & DJ File bring timeless classics back to the dancefloor.",
  continuationScheduleSourceText:
    "After midnight, Malina takes over, carrying the night into a new chapter.",
  nextIndependentTime: "22:00-04:00",
  independentPosterVenueEvidence: "BEN AKIBA",
  independentPosterTimeEvidence: "22H-04H",
  independentPosterArtistEvidence: ["BKO", "BEGE FANK"],
  nextVenue: "Ben Akiba",
  nextArtists: ["DJ Munja", "DJ File", "Malina"],
  descriptionPolicy: "normalized_primary_plus_continuation",
  moderationNote:
    "Human-reviewed same-source fold: Saturday is one continuous Ben Akiba event from 20:00 with DJ Munja, DJ File, and Malina; Friday remains a separate 22:00-04:00 occurrence.",
});

function usage() {
  return [
    "Usage:",
    "  node scripts/apply-reviewed-poster-venue-learning.mjs --phase config --mode dry-run",
    `  node scripts/apply-reviewed-poster-venue-learning.mjs --phase config --mode apply --plan-file ABS --expected-plan-sha256 SHA --confirm ${CONFIG_CONFIRMATION}`,
    "  node scripts/apply-reviewed-poster-venue-learning.mjs --phase config --mode status",
    "  node scripts/apply-reviewed-poster-venue-learning.mjs --phase events --mode dry-run",
    `  node scripts/apply-reviewed-poster-venue-learning.mjs --phase events --mode apply --plan-file ABS --expected-plan-sha256 SHA --confirm ${EVENT_CONFIRMATION}`,
    "  node scripts/apply-reviewed-poster-venue-learning.mjs --phase events --mode status --plan-file ABS --expected-plan-sha256 SHA",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    phase: "",
    mode: "",
    planFile: "",
    expectedPlanSha256: "",
    confirmation: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === "--phase") options.phase = take();
    else if (arg === "--mode") options.mode = take();
    else if (arg === "--plan-file") options.planFile = take();
    else if (arg === "--expected-plan-sha256")
      options.expectedPlanSha256 = take();
    else if (arg === "--confirm") options.confirmation = take();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!new Set(["config", "events"]).has(options.phase))
    throw new Error(usage());
  if (!new Set(["dry-run", "plan", "apply", "status"]).has(options.mode)) {
    throw new Error(usage());
  }
  if (options.mode === "apply") {
    if (!options.planFile || !HASH_PATTERN.test(options.expectedPlanSha256)) {
      throw new Error(
        "Apply requires an exact plan file and reviewed SHA-256 digest.",
      );
    }
    const expectedConfirmation =
      options.phase === "config" ? CONFIG_CONFIRMATION : EVENT_CONFIRMATION;
    if (options.confirmation !== expectedConfirmation) {
      throw new Error(
        "Apply confirmation is missing or does not match this phase.",
      );
    }
  }
  if (options.mode === "status" && options.phase === "events") {
    if (!options.planFile || !HASH_PATTERN.test(options.expectedPlanSha256)) {
      throw new Error(
        "Event status requires the reviewed event plan file and digest.",
      );
    }
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function projectionSha256(value) {
  return sha256(canonicalJson(value));
}

function exactJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function queryErrorText(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    for (const field of ["name", "code", "message"]) {
      if (typeof current[field] === "string") parts.push(current[field]);
    }
    current = current.cause;
  }
  return parts.join(" ");
}

function isTransientQueryError(error) {
  const text = queryErrorText(error);
  if (!text || DETERMINISTIC_QUERY_ERROR_PATTERN.test(text)) return false;
  return TRANSIENT_QUERY_ERROR_PATTERN.test(text);
}

function waitForRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function queryWithTransientRetry(client, functionName, args) {
  let lastError;
  for (let attempt = 1; attempt <= READ_QUERY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await client.query(functionName, args);
    } catch (error) {
      lastError = error;
      if (
        attempt >= READ_QUERY_MAX_ATTEMPTS ||
        !isTransientQueryError(error)
      ) {
        throw error;
      }
      await waitForRetry(
        READ_QUERY_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
      );
    }
  }
  throw lastError;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeHandle(value) {
  return normalizeText(value).replace(/^@+/u, "").toLowerCase();
}

function aliasKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/đ/gu, "dj")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function unionAliases(current, spec) {
  const candidates = [
    ...(Array.isArray(current.aliases) ? current.aliases : []),
    ...(current.name !== spec.name ? [current.name] : []),
    ...spec.requestedAliases,
  ];
  const canonicalKey = aliasKey(spec.name);
  const seen = new Set();
  const aliases = [];
  for (const raw of candidates) {
    const alias = normalizeText(raw);
    const key = aliasKey(alias);
    if (!alias || !key || key === canonicalKey || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

function parseObjectJson(value, label) {
  try {
    const parsed = JSON.parse(value ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} is not valid object JSON.`);
  }
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    exactJson(Object.keys(value).sort(), [...expected].sort())
  );
}

function venueProjection(venue, includeRevision = true) {
  return {
    id: venue._id,
    ...(includeRevision ? { updatedAt: venue.updatedAt } : {}),
    name: venue.name,
    instagramHandle: normalizeHandle(venue.instagramHandle),
    aliases: Array.isArray(venue.aliases) ? venue.aliases : [],
    location: venue.location ?? null,
    publicStatus: venue.publicStatus ?? null,
    scrapeActive: venue.scrapeActive ?? null,
  };
}

function sourceProjection(source, includeRevision = true) {
  return {
    id: source?._id ?? null,
    ...(includeRevision ? { updatedAt: source?.updatedAt ?? null } : {}),
    handle: source?.handle ?? null,
    role: source?.role ?? null,
    venueId: source?.venueId ?? null,
    active: source?.active ?? null,
  };
}

function sourceLinkProjection(link) {
  return {
    id: link._id,
    updatedAt: link.updatedAt,
    eventId: link.eventId,
    sourceIdentity: link.sourceIdentity,
    sourceFingerprint: link.sourceFingerprint,
    sourceOccurrenceKey: link.sourceOccurrenceKey,
    sourceHandle: link.sourceHandle ?? null,
    instagramPostId: link.instagramPostId,
    instagramPostUrl: link.instagramPostUrl,
  };
}

function receiptProjection(receipt, includeRevision = true) {
  return {
    id: receipt._id,
    ...(includeRevision ? { updatedAt: receipt.updatedAt } : {}),
    sourceIdentity: receipt.sourceIdentity,
    sourceFingerprint: receipt.sourceFingerprint,
    expectedKeys: receipt.expectedKeys,
    expectedOccurrences: receipt.expectedOccurrences,
    satisfiedKeys: receipt.satisfiedKeys,
    satisfiedOccurrences: receipt.satisfiedOccurrences,
    deferredChildCount: receipt.deferredChildCount,
    deferredChildKeys: receipt.deferredChildKeys,
  };
}

function eventPublicProjection(event) {
  return {
    id: event._id,
    status: event.status,
    title: event.title,
    date: event.date,
    time: event.time ?? null,
    venue: event.venue,
    venueId: event.venueId ?? null,
    venueInstagramHandle: event.venueInstagramHandle ?? null,
    artists: event.artists,
    description: event.description,
    instagramPostId: event.instagramPostId,
    instagramPostUrl: event.instagramPostUrl,
    sourceOccurrenceKey: event.sourceOccurrenceKey,
    timeSource: event.timeSource ?? null,
    timeEvidenceText: event.timeEvidenceText ?? null,
    timeConfidence: event.timeConfidence ?? null,
    timeStatus: event.timeStatus ?? null,
    timeEvidenceKind: event.timeEvidenceKind ?? null,
    moderationNote: event.moderationNote ?? null,
  };
}

function eventPreimageProjection(event) {
  return {
    ...eventPublicProjection(event),
    updatedAt: event.updatedAt,
    normalizedFieldsJson: event.normalizedFieldsJson,
    normalizedFieldsSha256: sha256(event.normalizedFieldsJson ?? ""),
    rawExtractionSha256: sha256(event.rawExtractionJson ?? ""),
  };
}

function reviewedMarker(event, field) {
  return (
    parseObjectJson(
      event.normalizedFieldsJson,
      `Event ${event._id} normalized evidence`,
    )[field] ?? null
  );
}

function targetVenueEventFields(venue) {
  return {
    venue: venue.name,
    venueId: venue._id,
    venueInstagramHandle: normalizeHandle(venue.instagramHandle),
  };
}

function contextProjection(context) {
  return {
    event: eventPreimageProjection(context.event),
    sourceLink: sourceLinkProjection(context.sourceLink),
    receipt: receiptProjection(context.receipt),
  };
}

function bindReceiptOccurrence(
  receipt,
  occurrenceKey,
  patch,
  representativeId,
) {
  const matches = receipt.expectedOccurrences.filter(
    (row) => row.key === occurrenceKey,
  );
  assert(
    matches.length === 1,
    `Receipt ${receipt._id} does not have one exact occurrence key.`,
  );
  return {
    ...receiptProjection(receipt, false),
    expectedOccurrences: receipt.expectedOccurrences.map((row) =>
      row.key === occurrenceKey ? { ...row, ...patch } : row,
    ),
    satisfiedOccurrences: receipt.satisfiedOccurrences.map((row) =>
      row.key === occurrenceKey ? { ...row, eventId: representativeId } : row,
    ),
  };
}

function singleBindingReceiptAfter(context, effectiveEvent, representativeId) {
  const key = context.sourceLink.sourceOccurrenceKey;
  return {
    ...receiptProjection(context.receipt, false),
    expectedOccurrences: [
      {
        key,
        date: effectiveEvent.date,
        time: effectiveEvent.time,
        venue: effectiveEvent.venue,
        title: effectiveEvent.title,
        artists: effectiveEvent.artists,
      },
    ],
    satisfiedOccurrences: [{ key, eventId: representativeId }],
  };
}

function loadPlanFile(path, expectedSha256, expectedPhase) {
  assert(isAbsolute(path), "Plan path must be absolute.");
  const stat = lstatSync(path);
  assert(
    stat.isFile() && !stat.isSymbolicLink(),
    "Plan path must be a regular non-symlink file.",
  );
  assert(
    stat.size > 0 && stat.size <= MAX_PLAN_BYTES,
    "Plan file size is outside the safe bound.",
  );
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Plan file is not valid JSON.");
  }
  assert(
    exactKeys(envelope, ["schemaVersion", "planSha256", "plan"]),
    "Plan envelope shape is invalid.",
  );
  assert(
    envelope.schemaVersion === PLAN_ENVELOPE_SCHEMA,
    "Plan envelope version is invalid.",
  );
  assert(
    HASH_PATTERN.test(envelope.planSha256),
    "Plan envelope digest is invalid.",
  );
  assert(
    envelope.planSha256 === expectedSha256,
    "Reviewed plan digest does not match the file.",
  );
  assert(
    projectionSha256(envelope.plan) === envelope.planSha256,
    "Plan content does not match its digest.",
  );
  assert(
    envelope.plan.phase === expectedPhase,
    "Plan phase does not match the command.",
  );
  const expectedSchema =
    expectedPhase === "config" ? CONFIG_PLAN_SCHEMA : EVENT_PLAN_SCHEMA;
  assert(
    envelope.plan.schemaVersion === expectedSchema,
    "Plan schema does not match the phase.",
  );
  return envelope;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function planEnvelope(plan) {
  return {
    schemaVersion: PLAN_ENVELOPE_SCHEMA,
    planSha256: projectionSha256(plan),
    plan,
  };
}

async function loadVenues(client, serviceSecret) {
  const venues = await queryWithTransientRetry(client, API.venues, {
    serviceSecret,
  });
  return new Map(venues.map((venue) => [venue._id, venue]));
}

async function loadSources(client, serviceSecret) {
  return new Map(
    await Promise.all(
      SOURCE_SPECS.map(async (spec) => [
        spec.handle,
        await queryWithTransientRetry(client, API.sourceByHandle, {
          handle: spec.handle,
          serviceSecret,
        }),
      ]),
    ),
  );
}

function targetVenueProjection(current, spec) {
  return {
    id: spec.id,
    name: spec.name,
    instagramHandle: spec.handle,
    aliases: unionAliases(current, spec),
    location: spec.location ?? current.location ?? null,
    publicStatus: spec.publicStatus,
    scrapeActive: spec.scrapeActive,
  };
}

function venueIsPublic(venue) {
  return (
    venue.publicStatus === "published" ||
    (venue.publicStatus === undefined && venue.isActive !== false)
  );
}

function venuesMatchingIdentity(venues, identity) {
  const key = aliasKey(identity);
  return [...venues.values()].filter(
    (venue) =>
      venueIsPublic(venue) &&
      [venue.name, ...(venue.aliases ?? [])].some(
        (value) => aliasKey(value) === key,
      ),
  );
}

function assertVenueConfigUnambiguous(venues, plannedTargets) {
  const valuesByVenue = new Map();
  for (const venue of venues.values()) {
    const planned = plannedTargets.get(venue._id);
    const name = planned?.name ?? venue.name;
    const aliases = planned?.aliases ?? venue.aliases ?? [];
    const values = [name, ...aliases]
      .map((value) => ({ key: aliasKey(value), value }))
      .filter((entry) => entry.key);
    assert(
      new Set(values.map((entry) => entry.key)).size === values.length,
      `Venue ${venue._id} has a duplicate canonical name/alias in the reviewed target.`,
    );
    valuesByVenue.set(venue._id, values);
  }
  for (const spec of VENUE_SPECS) {
    const ownValues = valuesByVenue.get(spec.id) ?? [];
    for (const [otherId, otherValues] of valuesByVenue) {
      if (otherId === spec.id) continue;
      const otherKeys = new Set(otherValues.map((entry) => entry.key));
      const collision = ownValues.find((entry) => otherKeys.has(entry.key));
      assert(
        !collision,
        `Reviewed venue identity ${JSON.stringify(collision?.value)} conflicts with venue ${otherId}.`,
      );
    }
  }
}

async function buildConfigPlan(client, serviceSecret) {
  const [venues, sources] = await Promise.all([
    loadVenues(client, serviceSecret),
    loadSources(client, serviceSecret),
  ]);
  const plannedTargets = new Map();
  for (const spec of VENUE_SPECS) {
    const venue = venues.get(spec.id);
    assert(venue, `Canonical venue ${spec.id} is missing.`);
    const target = targetVenueProjection(venue, spec);
    assert(
      target.aliases.length <= 20,
      `Venue ${spec.id} exceeds the alias safety bound.`,
    );
    plannedTargets.set(spec.id, target);
  }
  assertVenueConfigUnambiguous(venues, plannedTargets);
  const operations = [];
  for (const spec of VENUE_SPECS) {
    const venue = venues.get(spec.id);
    assert(venue, `Canonical venue ${spec.id} is missing.`);
    assert(
      normalizeHandle(venue.instagramHandle) === spec.handle,
      `Canonical venue ${spec.id} does not own @${spec.handle}.`,
    );
    const after = plannedTargets.get(spec.id);
    operations.push({
      kind: "venue_config",
      key: `venue:${spec.id}`,
      before: venueProjection(venue),
      after,
      mutation: {
        functionName: API.venueUpdate,
        args: {
          id: spec.id,
          expectedUpdatedAt: venue.updatedAt,
          patch: {
            name: after.name,
            aliases: after.aliases,
            ...(spec.location !== undefined
              ? { location: after.location }
              : {}),
            publicStatus: after.publicStatus,
            scrapeActive: after.scrapeActive,
          },
          auditNote:
            "Reviewed 2026-08-27 canonical venue identity correction; existing aliases are preserved and unioned.",
        },
      },
    });
  }
  for (const spec of SOURCE_SPECS) {
    const source = sources.get(spec.handle);
    assert(source, `Instagram source @${spec.handle} is missing.`);
    assert(
      source.active === true,
      `Instagram source @${spec.handle} is inactive.`,
    );
    operations.push({
      kind: "source_config",
      key: `source:${spec.handle}`,
      before: sourceProjection(source),
      after: {
        id: source._id,
        handle: spec.handle,
        role: spec.role,
        venueId: spec.venueId,
        active: true,
      },
      mutation: {
        functionName: API.sourceRoleUpdate,
        args: {
          handle: spec.handle,
          role: spec.role,
          ...(spec.venueId ? { venueId: spec.venueId } : {}),
          expectedUpdatedAt: source.updatedAt,
        },
      },
    });
  }
  return {
    schemaVersion: CONFIG_PLAN_SCHEMA,
    phase: "config",
    targetSetVersion: TARGET_SET_VERSION,
    targetSetSha256: projectionSha256({ VENUE_SPECS, SOURCE_SPECS }),
    plannedAt: new Date().toISOString(),
    operations,
  };
}

async function configStatus(client, serviceSecret) {
  const [venues, sources] = await Promise.all([
    loadVenues(client, serviceSecret),
    loadSources(client, serviceSecret),
  ]);
  const venueResults = VENUE_SPECS.map((spec) => {
    const venue = venues.get(spec.id);
    const actualAliases = new Set((venue?.aliases ?? []).map(aliasKey));
    const exact = Boolean(
      venue &&
      venue.name === spec.name &&
      normalizeHandle(venue.instagramHandle) === spec.handle &&
      spec.requestedAliases
        .map(aliasKey)
        .every((key) => actualAliases.has(key)) &&
      (spec.location === undefined || venue.location === spec.location) &&
      venue.publicStatus === spec.publicStatus &&
      venue.scrapeActive === spec.scrapeActive,
    );
    return {
      id: spec.id,
      handle: spec.handle,
      exact,
      actual: venue ? venueProjection(venue, false) : null,
    };
  });
  const sourceResults = SOURCE_SPECS.map((spec) => {
    const source = sources.get(spec.handle);
    return {
      handle: spec.handle,
      exact: Boolean(
        source &&
        source.active === true &&
        source.role === spec.role &&
        (source.venueId ?? null) === spec.venueId,
      ),
      actual: source ? sourceProjection(source, false) : null,
    };
  });
  return {
    complete:
      venueResults.every((row) => row.exact) &&
      sourceResults.every((row) => row.exact),
    venues: venueResults,
    sources: sourceResults,
  };
}

async function applyConfigOperation(client, serviceSecret, operation) {
  if (operation.kind === "venue_config") {
    const current = (await loadVenues(client, serviceSecret)).get(
      operation.before.id,
    );
    assert(current, `Venue ${operation.before.id} disappeared.`);
    if (exactJson(venueProjection(current, false), operation.after)) {
      return { key: operation.key, result: "already_exact" };
    }
    assert(
      exactJson(venueProjection(current), operation.before),
      `Venue ${operation.before.id} changed after plan review.`,
    );
    await client.mutation(operation.mutation.functionName, {
      ...operation.mutation.args,
      serviceSecret,
    });
    const after = (await loadVenues(client, serviceSecret)).get(
      operation.before.id,
    );
    assert(
      after && exactJson(venueProjection(after, false), operation.after),
      `Venue ${operation.before.id} failed exact readback.`,
    );
    return { key: operation.key, result: "applied" };
  }
  if (operation.kind === "source_config") {
    const current = await queryWithTransientRetry(client, API.sourceByHandle, {
      handle: operation.before.handle,
      serviceSecret,
    });
    assert(current, `Source @${operation.before.handle} disappeared.`);
    if (exactJson(sourceProjection(current, false), operation.after)) {
      return { key: operation.key, result: "already_exact" };
    }
    assert(
      exactJson(sourceProjection(current), operation.before),
      `Source @${operation.before.handle} changed after plan review.`,
    );
    await client.mutation(operation.mutation.functionName, {
      ...operation.mutation.args,
      serviceSecret,
    });
    const after = await queryWithTransientRetry(client, API.sourceByHandle, {
      handle: operation.before.handle,
      serviceSecret,
    });
    assert(
      after && exactJson(sourceProjection(after, false), operation.after),
      `Source @${operation.before.handle} failed exact readback.`,
    );
    return { key: operation.key, result: "applied" };
  }
  throw new Error(`Unknown config operation kind ${operation.kind}.`);
}

async function loadEventsByIds(client, serviceSecret, ids) {
  const uniqueIds = [...new Set(ids)];
  const events = await queryWithTransientRetry(client, API.eventsByIds, {
    ids: uniqueIds,
    serviceSecret,
  });
  const byId = new Map(
    events.filter(Boolean).map((event) => [event._id, event]),
  );
  for (const id of uniqueIds)
    assert(byId.has(id), `Reviewed event ${id} is missing.`);
  return byId;
}

function eventSourceHandle(event) {
  const fields = parseObjectJson(
    event.normalizedFieldsJson,
    `Event ${event._id} normalized evidence`,
  );
  return normalizeHandle(fields.sourceGroundingInstagramHandle);
}

function tryEventSourceHandle(event) {
  try {
    return eventSourceHandle(event);
  } catch {
    return "";
  }
}

function expectedReviewedApprovedIdsBySource() {
  const expected = new Map(SOURCE_SPECS.map((spec) => [spec.handle, []]));
  for (const group of VENUE_REPAIR_GROUPS) {
    assert(
      expected.has(group.sourceHandle),
      `Unknown reviewed source @${group.sourceHandle}.`,
    );
    expected.get(group.sourceHandle).push(...group.ids);
  }
  expected
    .get(KNEZ_FOLD.expectedSourceHandle)
    .push(KNEZ_FOLD.primaryId, KNEZ_FOLD.variantId);
  expected
    .get(SKI_FOLD.expectedSourceHandle)
    .push(SKI_FOLD.primaryId, SKI_FOLD.variantId);
  expected
    .get(BEN_FOLD.expectedSourceHandle)
    .push(BEN_FOLD.independentId, BEN_FOLD.primaryId, BEN_FOLD.continuationId);
  const allIds = [...expected.values()].flat();
  assert(
    new Set(allIds).size === allIds.length,
    "Reviewed event inventory contains duplicate IDs.",
  );
  return expected;
}

async function loadReviewedApprovedInventory(client, serviceSecret) {
  const expected = expectedReviewedApprovedIdsBySource();
  const reviewedHandles = new Set(expected.keys());
  const byHandle = new Map([...reviewedHandles].map((handle) => [handle, []]));
  let cursor = null;
  let pageCount = 0;
  for (;;) {
    assert(
      pageCount < MAX_INVENTORY_PAGES,
      "Approved-event inventory exceeded its page cap.",
    );
    const page = await queryWithTransientRetry(
      client,
      API.eventsByStatusPaginated,
      {
        status: "approved",
        paginationOpts: { numItems: INVENTORY_PAGE_SIZE, cursor },
        serviceSecret,
      },
    );
    pageCount += 1;
    assert(
      page && Array.isArray(page.page) && typeof page.isDone === "boolean",
      "Approved-event inventory response is invalid.",
    );
    for (const event of page.page) {
      if (event.date < REVIEWED_INVENTORY_CUTOFF_DATE) continue;
      const sourceHandle = tryEventSourceHandle(event);
      if (!reviewedHandles.has(sourceHandle)) continue;
      assert(
        event.status === "approved",
        `Inventory event ${event._id} is not approved.`,
      );
      byHandle.get(sourceHandle).push({
        id: event._id,
        date: event.date,
        instagramPostId: event.instagramPostId ?? null,
      });
    }
    if (page.isDone) break;
    assert(
      typeof page.continueCursor === "string" && page.continueCursor,
      "Approved-event inventory cursor is invalid.",
    );
    cursor = page.continueCursor;
  }
  for (const rows of byHandle.values())
    rows.sort((left, right) => left.id.localeCompare(right.id));
  return { byHandle, pageCount };
}

function assertReviewedApprovedInventoryExact(inventory) {
  const expected = expectedReviewedApprovedIdsBySource();
  for (const [handle, expectedIds] of expected) {
    const actualIds = (inventory.byHandle.get(handle) ?? []).map(
      (row) => row.id,
    );
    assert(
      exactJson([...actualIds].sort(), [...expectedIds].sort()),
      `Approved non-expired inventory for @${handle} changed; event planning is refused.`,
    );
  }
}

function assertReviewedApprovedInventoryCovered(inventory) {
  const expected = expectedReviewedApprovedIdsBySource();
  for (const [handle, rows] of inventory.byHandle) {
    const expectedIds = new Set(expected.get(handle) ?? []);
    const unreviewed = rows.filter((row) => !expectedIds.has(row.id));
    assert(
      unreviewed.length === 0,
      `Approved non-expired inventory for @${handle} gained an unreviewed row; apply is refused.`,
    );
  }
}

function inventoryAttestation(inventory) {
  return {
    cutoffDate: REVIEWED_INVENTORY_CUTOFF_DATE,
    pageCount: inventory.pageCount,
    sources: [...inventory.byHandle]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([handle, events]) => ({ handle, events })),
  };
}

async function correctionContext(client, serviceSecret, id) {
  const context = await queryWithTransientRetry(client, API.correctionContext, {
    id,
    serviceSecret,
  });
  assert(context?.event?._id === id, `Reviewed context ${id} is invalid.`);
  return context;
}

async function buildVenueRepairOperation(
  client,
  serviceSecret,
  event,
  venue,
  group,
) {
  const context = await correctionContext(client, serviceSecret, event._id);
  assert(
    context.event.status === "approved",
    `Event ${event._id} is not approved.`,
  );
  assert(
    eventSourceHandle(context.event) === group.sourceHandle &&
      (!context.sourceLink.sourceHandle ||
        normalizeHandle(context.sourceLink.sourceHandle) ===
          group.sourceHandle),
    `Event ${event._id} is no longer grounded to @${group.sourceHandle}.`,
  );
  const allowedVenueKeys = new Set(
    ["", venue.name, ...(venue.aliases ?? [])].map((value) => aliasKey(value)),
  );
  assert(
    allowedVenueKeys.has(aliasKey(context.event.venue)),
    `Event ${event._id} has an unreviewed venue ${JSON.stringify(context.event.venue)}.`,
  );
  const afterEvent = {
    ...eventPublicProjection(context.event),
    ...targetVenueEventFields(venue),
    moderationNote: REVIEWED_VENUE_NOTE,
  };
  return {
    kind: "reviewed_venue_repair",
    key: `event-venue:${event._id}`,
    before: contextProjection(context),
    targetVenue: venueProjection(venue),
    after: {
      event: afterEvent,
      receipt: bindReceiptOccurrence(
        context.receipt,
        context.sourceLink.sourceOccurrenceKey,
        { venue: venue.name },
        event._id,
      ),
      marker: {
        field: "reviewedVenueCorrection",
        policyVersion: 1,
        venue: venue.name,
        evidence: group.evidence,
      },
    },
    mutation: {
      functionName: API.venueRepair,
      args: {
        id: event._id,
        expectedUpdatedAt: context.event.updatedAt,
        expectedNormalizedFieldsJson: context.event.normalizedFieldsJson,
        expectedSourceLinkId: context.sourceLink._id,
        expectedSourceLinkUpdatedAt: context.sourceLink.updatedAt,
        expectedReceiptId: context.receipt._id,
        expectedReceiptUpdatedAt: context.receipt.updatedAt,
        nextVenue: venue.name,
        targetVenueId: venue._id,
        expectedTargetVenueUpdatedAt: venue.updatedAt,
        expectedTargetVenueHandle: normalizeHandle(venue.instagramHandle),
        venueEvidence: group.evidence,
        moderationNote: REVIEWED_VENUE_NOTE,
      },
    },
  };
}

function promotionFoldPrimaryAfter(event, spec, targetVenue = null) {
  return {
    ...eventPublicProjection(event),
    status: "approved",
    title: spec.nextTitle,
    time: spec.nextTime,
    venue: spec.nextVenue,
    venueId: targetVenue?._id ?? null,
    venueInstagramHandle: targetVenue
      ? normalizeHandle(targetVenue.instagramHandle)
      : null,
    artists: spec.nextArtists,
    description: spec.nextDescription,
    timeSource: "poster",
    timeEvidenceText: spec.posterTimeEvidence,
    timeConfidence: 0.99,
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
    moderationNote: spec.moderationNote,
  };
}

function rejectedAfter(event, operationId, prefix, moderationNote) {
  return {
    ...eventPublicProjection(event),
    status: "rejected",
    moderationNote: `${prefix} ${operationId} - ${moderationNote}`,
  };
}

async function buildPromotionFoldOperation(
  client,
  serviceSecret,
  events,
  spec,
  targetVenue = null,
) {
  const primary = events.get(spec.primaryId);
  const variant = events.get(spec.variantId);
  const [primaryContext, variantContext] = await Promise.all([
    correctionContext(client, serviceSecret, primary._id),
    correctionContext(client, serviceSecret, variant._id),
  ]);
  assert(
    primary.date === variant.date,
    `${spec.operationId} date proof changed.`,
  );
  const afterPrimary = promotionFoldPrimaryAfter(primary, spec, targetVenue);
  return {
    kind: "reviewed_promotion_fold",
    key: `fold:${spec.operationId}`,
    before: {
      primary: contextProjection(primaryContext),
      variant: contextProjection(variantContext),
    },
    ...(targetVenue ? { targetVenue: venueProjection(targetVenue) } : {}),
    after: {
      primary: afterPrimary,
      variant: rejectedAfter(
        variant,
        spec.operationId,
        "[reviewed_promotion_variant:v1]",
        spec.moderationNote,
      ),
      primaryReceipt: singleBindingReceiptAfter(
        primaryContext,
        afterPrimary,
        primary._id,
      ),
      variantReceipt: singleBindingReceiptAfter(
        variantContext,
        afterPrimary,
        primary._id,
      ),
      marker: {
        field: "reviewedPromotionVariantFold",
        policyVersion: 1,
        operationId: spec.operationId,
        primaryEventId: primary._id,
        variantEventId: variant._id,
        targetVenueId: targetVenue?._id ?? null,
      },
    },
    mutation: {
      functionName: API.promotionFold,
      args: {
        operationId: spec.operationId,
        primaryId: primary._id,
        expectedPrimaryUpdatedAt: primary.updatedAt,
        expectedPrimaryNormalizedFieldsJson: primary.normalizedFieldsJson,
        expectedPrimarySourceLinkId: primaryContext.sourceLink._id,
        expectedPrimarySourceLinkUpdatedAt: primaryContext.sourceLink.updatedAt,
        expectedPrimaryReceiptId: primaryContext.receipt._id,
        expectedPrimaryReceiptUpdatedAt: primaryContext.receipt.updatedAt,
        variantId: variant._id,
        expectedVariantUpdatedAt: variant.updatedAt,
        expectedVariantNormalizedFieldsJson: variant.normalizedFieldsJson,
        expectedVariantSourceLinkId: variantContext.sourceLink._id,
        expectedVariantSourceLinkUpdatedAt: variantContext.sourceLink.updatedAt,
        expectedVariantReceiptId: variantContext.receipt._id,
        expectedVariantReceiptUpdatedAt: variantContext.receipt.updatedAt,
        expectedSourceHandle: spec.expectedSourceHandle,
        campaignAnchors: spec.campaignAnchors,
        primaryDuplicateEvidence: spec.primaryDuplicateEvidence,
        variantDuplicateEvidence: spec.variantDuplicateEvidence,
        nextTitle: spec.nextTitle,
        nextTime: spec.nextTime,
        nextVenue: spec.nextVenue,
        ...(targetVenue
          ? {
              targetVenueId: targetVenue._id,
              expectedTargetVenueUpdatedAt: targetVenue.updatedAt,
              expectedTargetVenueHandle: normalizeHandle(
                targetVenue.instagramHandle,
              ),
            }
          : {}),
        nextArtists: spec.nextArtists,
        nextDescription: spec.nextDescription,
        posterVenueEvidence: spec.posterVenueEvidence,
        posterTimeEvidence: spec.posterTimeEvidence,
        posterArtistEvidence: spec.posterArtistEvidence,
        moderationNote: spec.moderationNote,
      },
    },
  };
}

async function buildKnezFoldOperation(
  client,
  serviceSecret,
  events,
  targetVenue,
) {
  const primary = events.get(KNEZ_FOLD.primaryId);
  const variant = events.get(KNEZ_FOLD.variantId);
  assert(
    ![null, "", "TBD"].includes(primary.time ?? null),
    "Knez primary lost its explicit time.",
  );
  assert(
    primary.artists.some((artist) => aliasKey(artist).includes("knez")) &&
      variant.artists.some((artist) => aliasKey(artist).includes("knez")),
    "Knez artist identity proof changed.",
  );
  return buildPromotionFoldOperation(
    client,
    serviceSecret,
    events,
    {
      ...KNEZ_FOLD,
      nextTitle: primary.title,
      nextTime: primary.time,
      nextVenue: targetVenue.name,
      nextArtists: primary.artists,
      nextDescription: primary.description,
    },
    targetVenue,
  );
}

function assertOneSharedReceipt(contexts, label) {
  assert(
    new Set(contexts.map((context) => context.receipt._id)).size === 1 &&
      new Set(contexts.map((context) => context.receipt.sourceIdentity))
        .size === 1 &&
      new Set(contexts.map((context) => context.receipt.updatedAt)).size === 1,
    `${label} no longer has one exact shared receipt.`,
  );
}

async function buildBenFoldOperation(
  client,
  serviceSecret,
  events,
  targetVenue,
) {
  const independent = events.get(BEN_FOLD.independentId);
  const primary = events.get(BEN_FOLD.primaryId);
  const continuation = events.get(BEN_FOLD.continuationId);
  const [independentContext, primaryContext, continuationContext] =
    await Promise.all([
      correctionContext(client, serviceSecret, independent._id),
      correctionContext(client, serviceSecret, primary._id),
      correctionContext(client, serviceSecret, continuation._id),
    ]);
  assertOneSharedReceipt(
    [independentContext, primaryContext, continuationContext],
    "Ben Akiba reviewed schedule",
  );
  assert(independent.date === "2026-08-28", "Ben Akiba Friday date changed.");
  assert(primary.date === "2026-08-29", "Ben Akiba Saturday date changed.");
  assert(
    continuation.date === primary.date,
    "Ben Akiba continuation date changed.",
  );
  const nextDescription = [primary.description, continuation.description]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
  assert(nextDescription, "Ben Akiba deterministic description is empty.");
  const independentAfter = {
    ...eventPublicProjection(independent),
    ...targetVenueEventFields(targetVenue),
    time: BEN_FOLD.nextIndependentTime,
    timeSource: "poster",
    timeEvidenceText: BEN_FOLD.independentPosterTimeEvidence,
    timeConfidence: 0.99,
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
    moderationNote: BEN_FOLD.moderationNote,
  };
  const primaryAfter = {
    ...eventPublicProjection(primary),
    ...targetVenueEventFields(targetVenue),
    artists: BEN_FOLD.nextArtists,
    description: nextDescription,
    moderationNote: BEN_FOLD.moderationNote,
  };
  const receipt = independentContext.receipt;
  const independentKey = independentContext.sourceLink.sourceOccurrenceKey;
  const primaryKey = primaryContext.sourceLink.sourceOccurrenceKey;
  const continuationKey = continuationContext.sourceLink.sourceOccurrenceKey;
  assert(
    new Set([independentKey, primaryKey, continuationKey]).size === 3,
    "Ben keys changed.",
  );
  const primaryBinding = (key) => ({
    key,
    date: primaryAfter.date,
    time: primaryAfter.time,
    venue: primaryAfter.venue,
    title: primaryAfter.title,
    artists: primaryAfter.artists,
  });
  const independentBinding = {
    key: independentKey,
    date: independentAfter.date,
    time: independentAfter.time,
    venue: independentAfter.venue,
    title: independentAfter.title,
    artists: independentAfter.artists,
  };
  const receiptAfter = {
    ...receiptProjection(receipt, false),
    expectedOccurrences: receipt.expectedOccurrences.map((row) =>
      row.key === independentKey
        ? independentBinding
        : row.key === primaryKey || row.key === continuationKey
          ? primaryBinding(row.key)
          : (() => {
              throw new Error(`Unexpected Ben receipt key ${row.key}.`);
            })(),
    ),
    satisfiedOccurrences: receipt.satisfiedOccurrences.map((row) => ({
      key: row.key,
      eventId: row.key === continuationKey ? primary._id : row.eventId,
    })),
  };
  return {
    kind: "reviewed_same_source_continuation_fold",
    key: `fold:${BEN_FOLD.operationId}`,
    before: {
      independent: contextProjection(independentContext),
      primary: contextProjection(primaryContext),
      continuation: contextProjection(continuationContext),
    },
    targetVenue: venueProjection(targetVenue),
    after: {
      independent: independentAfter,
      primary: primaryAfter,
      continuation: rejectedAfter(
        continuation,
        BEN_FOLD.operationId,
        "[reviewed_same_source_continuation:v1]",
        BEN_FOLD.moderationNote,
      ),
      receipt: receiptAfter,
      independentMarker: {
        field: "reviewedSameSourceContinuationFold",
        policyVersion: 1,
        operationId: BEN_FOLD.operationId,
        role: "independent",
      },
      primaryMarker: {
        field: "reviewedSameSourceContinuationFold",
        policyVersion: 1,
        operationId: BEN_FOLD.operationId,
        role: "primary",
      },
    },
    mutation: {
      functionName: API.continuationFold,
      args: {
        operationId: BEN_FOLD.operationId,
        primaryId: primary._id,
        expectedPrimaryUpdatedAt: primary.updatedAt,
        expectedPrimaryNormalizedFieldsJson: primary.normalizedFieldsJson,
        expectedPrimarySourceLinkId: primaryContext.sourceLink._id,
        expectedPrimarySourceLinkUpdatedAt: primaryContext.sourceLink.updatedAt,
        continuationId: continuation._id,
        expectedContinuationUpdatedAt: continuation.updatedAt,
        expectedContinuationNormalizedFieldsJson:
          continuation.normalizedFieldsJson,
        expectedContinuationSourceLinkId: continuationContext.sourceLink._id,
        expectedContinuationSourceLinkUpdatedAt:
          continuationContext.sourceLink.updatedAt,
        independentId: independent._id,
        expectedIndependentUpdatedAt: independent.updatedAt,
        expectedIndependentNormalizedFieldsJson:
          independent.normalizedFieldsJson,
        expectedIndependentSourceLinkId: independentContext.sourceLink._id,
        expectedIndependentSourceLinkUpdatedAt:
          independentContext.sourceLink.updatedAt,
        expectedReceiptId: receipt._id,
        expectedReceiptUpdatedAt: receipt.updatedAt,
        expectedSourceHandle: BEN_FOLD.expectedSourceHandle,
        expectedSourceIdentity: receipt.sourceIdentity,
        expectedSourceFingerprint: receipt.sourceFingerprint,
        primaryScheduleSourceText: BEN_FOLD.primaryScheduleSourceText,
        continuationScheduleSourceText: BEN_FOLD.continuationScheduleSourceText,
        nextIndependentTime: BEN_FOLD.nextIndependentTime,
        independentPosterVenueEvidence: BEN_FOLD.independentPosterVenueEvidence,
        independentPosterTimeEvidence: BEN_FOLD.independentPosterTimeEvidence,
        independentPosterArtistEvidence:
          BEN_FOLD.independentPosterArtistEvidence,
        nextVenue: BEN_FOLD.nextVenue,
        targetVenueId: targetVenue._id,
        expectedTargetVenueUpdatedAt: targetVenue.updatedAt,
        expectedTargetVenueHandle: normalizeHandle(targetVenue.instagramHandle),
        nextArtists: BEN_FOLD.nextArtists,
        nextDescription,
        moderationNote: BEN_FOLD.moderationNote,
      },
    },
  };
}

function buildInfuseRetirementOperation(infuseVenue) {
  return {
    kind: "retire_promoter_venue",
    key: `retire-venue:${INFUSE_SPEC.id}`,
    before: venueProjection(infuseVenue),
    after: {
      ...venueProjection(infuseVenue, false),
      publicStatus: "hidden",
      scrapeActive: false,
    },
    mutation: {
      functionName: API.venueUpdate,
      args: {
        id: INFUSE_SPEC.id,
        expectedUpdatedAt: infuseVenue.updatedAt,
        patch: { publicStatus: "hidden", scrapeActive: false },
        auditNote:
          "Reviewed 2026-08-27 classification: INFUSE is a promoter, not the Ski Staza physical venue.",
      },
    },
  };
}

function allReviewedEventIds() {
  return [
    ...VENUE_REPAIR_GROUPS.flatMap((group) => group.ids),
    SKI_FOLD.primaryId,
    SKI_FOLD.variantId,
    KNEZ_FOLD.primaryId,
    KNEZ_FOLD.variantId,
    BEN_FOLD.independentId,
    BEN_FOLD.primaryId,
    BEN_FOLD.continuationId,
  ];
}

async function buildEventPlan(client, serviceSecret) {
  const status = await configStatus(client, serviceSecret);
  assert(
    status.complete,
    "Config phase is not complete; event planning is refused.",
  );
  const [venues, events, reviewedInventory] = await Promise.all([
    loadVenues(client, serviceSecret),
    loadEventsByIds(client, serviceSecret, allReviewedEventIds()),
    loadReviewedApprovedInventory(client, serviceSecret),
  ]);
  assertReviewedApprovedInventoryExact(reviewedInventory);
  const operations = [];
  for (const group of VENUE_REPAIR_GROUPS) {
    const venue = venues.get(group.venueId);
    assert(venue, `Venue repair target ${group.venueId} is missing.`);
    for (const id of group.ids) {
      operations.push(
        await buildVenueRepairOperation(
          client,
          serviceSecret,
          events.get(id),
          venue,
          group,
        ),
      );
    }
  }
  const repairReceiptIds = operations.map(
    (operation) => operation.before.receipt.id,
  );
  assert(
    new Set(repairReceiptIds).size === repairReceiptIds.length,
    "Reviewed venue repairs unexpectedly share a receipt and cannot run sequentially.",
  );
  const freestylerVenue = venues.get(KNEZ_FOLD.targetVenueId);
  assert(freestylerVenue, "Freestyler fold target venue is missing.");
  operations.push(
    await buildKnezFoldOperation(
      client,
      serviceSecret,
      events,
      freestylerVenue,
    ),
  );
  assert(
    venuesMatchingIdentity(venues, SKI_FOLD.nextVenue).length === 0,
    "Ski Staza now resolves to a public canonical venue; the noncanonical fold must be reviewed again.",
  );
  operations.push(
    await buildPromotionFoldOperation(client, serviceSecret, events, SKI_FOLD),
  );
  const benAkibaVenue = venues.get(BEN_FOLD.targetVenueId);
  assert(benAkibaVenue, "Ben Akiba fold target venue is missing.");
  operations.push(
    await buildBenFoldOperation(client, serviceSecret, events, benAkibaVenue),
  );
  const infuseVenue = venues.get(INFUSE_SPEC.id);
  assert(
    infuseVenue &&
      infuseVenue.name === INFUSE_SPEC.name &&
      normalizeHandle(infuseVenue.instagramHandle) === INFUSE_SPEC.handle &&
      infuseVenue.publicStatus === "published",
    "INFUSE must remain published until the Ski fold is sealed.",
  );
  operations.push(buildInfuseRetirementOperation(infuseVenue));
  return {
    schemaVersion: EVENT_PLAN_SCHEMA,
    phase: "events",
    targetSetVersion: TARGET_SET_VERSION,
    targetSetSha256: projectionSha256({
      VENUE_REPAIR_GROUPS,
      SKI_FOLD,
      KNEZ_FOLD,
      BEN_FOLD,
      reviewedInventoryCutoffDate: REVIEWED_INVENTORY_CUTOFF_DATE,
      infuseRetirement: { publicStatus: "hidden", scrapeActive: false },
    }),
    plannedAt: new Date().toISOString(),
    reviewedInventory: inventoryAttestation(reviewedInventory),
    operations,
  };
}

function markerMatches(event, expected) {
  const marker = reviewedMarker(event, expected.field);
  if (!marker || typeof marker !== "object" || Array.isArray(marker))
    return false;
  return Object.entries(expected).every(([key, value]) =>
    key === "field" ? true : exactJson(marker[key], value),
  );
}

async function receiptMatches(client, serviceSecret, expected) {
  const receipt = await queryWithTransientRetry(client, API.receipt, {
    sourceIdentity: expected.sourceIdentity,
    serviceSecret,
  });
  return Boolean(
    receipt && exactJson(receiptProjection(receipt, false), expected),
  );
}

async function loadOperationEvents(client, serviceSecret, operation) {
  if (operation.kind === "reviewed_venue_repair") {
    return loadEventsByIds(client, serviceSecret, [operation.after.event.id]);
  }
  if (operation.kind === "reviewed_promotion_fold") {
    return loadEventsByIds(client, serviceSecret, [
      operation.after.primary.id,
      operation.after.variant.id,
    ]);
  }
  if (operation.kind === "reviewed_same_source_continuation_fold") {
    return loadEventsByIds(client, serviceSecret, [
      operation.after.independent.id,
      operation.after.primary.id,
      operation.after.continuation.id,
    ]);
  }
  return new Map();
}

function rejectedEventMatches(event, expected) {
  return exactJson(eventPublicProjection(event), expected);
}

async function eventOperationAfterMatches(client, serviceSecret, operation) {
  if (operation.kind === "retire_promoter_venue") {
    const venue = (await loadVenues(client, serviceSecret)).get(
      operation.before.id,
    );
    return Boolean(
      venue && exactJson(venueProjection(venue, false), operation.after),
    );
  }
  const events = await loadOperationEvents(client, serviceSecret, operation);
  if (operation.kind === "reviewed_venue_repair") {
    const event = events.get(operation.after.event.id);
    return (
      exactJson(eventPublicProjection(event), operation.after.event) &&
      markerMatches(event, operation.after.marker) &&
      (await receiptMatches(client, serviceSecret, operation.after.receipt))
    );
  }
  if (operation.kind === "reviewed_promotion_fold") {
    const primary = events.get(operation.after.primary.id);
    const variant = events.get(operation.after.variant.id);
    return (
      exactJson(eventPublicProjection(primary), operation.after.primary) &&
      rejectedEventMatches(variant, operation.after.variant) &&
      markerMatches(primary, operation.after.marker) &&
      (await receiptMatches(
        client,
        serviceSecret,
        operation.after.primaryReceipt,
      )) &&
      (await receiptMatches(
        client,
        serviceSecret,
        operation.after.variantReceipt,
      ))
    );
  }
  if (operation.kind === "reviewed_same_source_continuation_fold") {
    const independent = events.get(operation.after.independent.id);
    const primary = events.get(operation.after.primary.id);
    const continuation = events.get(operation.after.continuation.id);
    return (
      exactJson(
        eventPublicProjection(independent),
        operation.after.independent,
      ) &&
      exactJson(eventPublicProjection(primary), operation.after.primary) &&
      rejectedEventMatches(continuation, operation.after.continuation) &&
      markerMatches(independent, operation.after.independentMarker) &&
      markerMatches(primary, operation.after.primaryMarker) &&
      (await receiptMatches(client, serviceSecret, operation.after.receipt))
    );
  }
  throw new Error(`Unknown event operation kind ${operation.kind}.`);
}

async function assertOperationPreimage(client, serviceSecret, operation) {
  if (operation.kind === "retire_promoter_venue") {
    const venue = (await loadVenues(client, serviceSecret)).get(
      operation.before.id,
    );
    assert(
      venue && exactJson(venueProjection(venue), operation.before),
      "INFUSE venue changed after event plan review.",
    );
    return;
  }
  const contexts = [];
  if (operation.kind === "reviewed_venue_repair") {
    contexts.push([
      "event",
      await correctionContext(client, serviceSecret, operation.before.event.id),
    ]);
  } else if (operation.kind === "reviewed_promotion_fold") {
    contexts.push(
      [
        "primary",
        await correctionContext(
          client,
          serviceSecret,
          operation.before.primary.event.id,
        ),
      ],
      [
        "variant",
        await correctionContext(
          client,
          serviceSecret,
          operation.before.variant.event.id,
        ),
      ],
    );
  } else if (operation.kind === "reviewed_same_source_continuation_fold") {
    contexts.push(
      [
        "independent",
        await correctionContext(
          client,
          serviceSecret,
          operation.before.independent.event.id,
        ),
      ],
      [
        "primary",
        await correctionContext(
          client,
          serviceSecret,
          operation.before.primary.event.id,
        ),
      ],
      [
        "continuation",
        await correctionContext(
          client,
          serviceSecret,
          operation.before.continuation.event.id,
        ),
      ],
    );
  } else {
    throw new Error(`Unknown event operation kind ${operation.kind}.`);
  }
  for (const [key, context] of contexts) {
    const expectedPreimage =
      operation.kind === "reviewed_venue_repair"
        ? operation.before
        : operation.before[key];
    assert(
      exactJson(contextProjection(context), expectedPreimage),
      `${operation.key} ${key} preimage changed after plan review.`,
    );
  }
  if (operation.targetVenue) {
    const venue = (await loadVenues(client, serviceSecret)).get(
      operation.targetVenue.id,
    );
    assert(
      venue && exactJson(venueProjection(venue), operation.targetVenue),
      `${operation.key} target venue revision changed after plan review.`,
    );
  }
}

async function applyEventOperation(client, serviceSecret, operation) {
  if (await eventOperationAfterMatches(client, serviceSecret, operation)) {
    return { key: operation.key, result: "already_exact" };
  }
  await assertOperationPreimage(client, serviceSecret, operation);
  await client.mutation(operation.mutation.functionName, {
    ...operation.mutation.args,
    serviceSecret,
  });
  assert(
    await eventOperationAfterMatches(client, serviceSecret, operation),
    `${operation.key} failed exact post-mutation verification.`,
  );
  return { key: operation.key, result: "applied" };
}

async function eventPlanStatus(client, serviceSecret, plan) {
  const operations = [];
  for (const operation of plan.operations) {
    let exact = false;
    try {
      exact = await eventOperationAfterMatches(
        client,
        serviceSecret,
        operation,
      );
    } catch {
      exact = false;
    }
    operations.push({ key: operation.key, kind: operation.kind, exact });
  }
  return { complete: operations.every((row) => row.exact), operations };
}

function eventTargetSetSha256() {
  return projectionSha256({
    VENUE_REPAIR_GROUPS,
    SKI_FOLD,
    KNEZ_FOLD,
    BEN_FOLD,
    reviewedInventoryCutoffDate: REVIEWED_INVENTORY_CUTOFF_DATE,
    infuseRetirement: { publicStatus: "hidden", scrapeActive: false },
  });
}

function validateReviewedInventoryAttestation(attestation) {
  assert(
    exactKeys(attestation, ["cutoffDate", "pageCount", "sources"]),
    "Reviewed inventory attestation shape is invalid.",
  );
  assert(
    attestation.cutoffDate === REVIEWED_INVENTORY_CUTOFF_DATE &&
      Number.isSafeInteger(attestation.pageCount) &&
      attestation.pageCount > 0 &&
      attestation.pageCount <= MAX_INVENTORY_PAGES &&
      Array.isArray(attestation.sources),
    "Reviewed inventory attestation metadata is invalid.",
  );
  const expected = expectedReviewedApprovedIdsBySource();
  const expectedHandles = [...expected.keys()].sort();
  assert(
    exactJson(
      attestation.sources.map((source) => source?.handle),
      expectedHandles,
    ),
    "Reviewed inventory attestation source set is invalid.",
  );
  for (const source of attestation.sources) {
    assert(
      exactKeys(source, ["handle", "events"]) && Array.isArray(source.events),
      `Reviewed inventory attestation for @${source?.handle ?? "unknown"} is invalid.`,
    );
    const ids = [];
    for (const event of source.events) {
      assert(
        exactKeys(event, ["id", "date", "instagramPostId"]) &&
          typeof event.id === "string" &&
          /^\d{4}-\d{2}-\d{2}$/u.test(event.date) &&
          event.date >= REVIEWED_INVENTORY_CUTOFF_DATE &&
          (event.instagramPostId === null ||
            typeof event.instagramPostId === "string"),
        `Reviewed inventory event for @${source.handle} is invalid.`,
      );
      ids.push(event.id);
    }
    assert(
      exactJson([...ids].sort(), [...expected.get(source.handle)].sort()),
      `Reviewed inventory attestation for @${source.handle} has an invalid event set.`,
    );
  }
}

function validatePlanShape(plan, phase) {
  assert(
    plan.targetSetVersion === TARGET_SET_VERSION,
    "Plan target-set version is stale.",
  );
  assert(
    Array.isArray(plan.operations) && plan.operations.length > 0,
    "Plan has no operations.",
  );
  const keys = plan.operations.map((operation) => operation.key);
  assert(
    new Set(keys).size === keys.length,
    "Plan operation keys are not unique.",
  );
  if (phase === "config") {
    assert(
      plan.targetSetSha256 === projectionSha256({ VENUE_SPECS, SOURCE_SPECS }),
      "Config plan target-set digest is stale.",
    );
    assert(
      plan.operations.every((operation) =>
        new Set(["venue_config", "source_config"]).has(operation.kind),
      ),
      "Config plan contains an invalid operation kind.",
    );
    const expectedKeys = [
      ...VENUE_SPECS.map((spec) => `venue:${spec.id}`),
      ...SOURCE_SPECS.map((spec) => `source:${spec.handle}`),
    ];
    assert(
      exactJson([...keys].sort(), expectedKeys.sort()),
      "Config plan operation set is invalid.",
    );
    assert(
      plan.operations.every(
        (operation) =>
          operation.mutation?.functionName ===
          (operation.kind === "venue_config"
            ? API.venueUpdate
            : API.sourceRoleUpdate),
      ),
      "Config plan contains an unreviewed mutation.",
    );
  } else {
    assert(
      plan.targetSetSha256 === eventTargetSetSha256(),
      "Event target-set digest is stale.",
    );
    validateReviewedInventoryAttestation(plan.reviewedInventory);
    const expectedKeys = [
      ...VENUE_REPAIR_GROUPS.flatMap((group) =>
        group.ids.map((id) => `event-venue:${id}`),
      ),
      `fold:${KNEZ_FOLD.operationId}`,
      `fold:${SKI_FOLD.operationId}`,
      `fold:${BEN_FOLD.operationId}`,
      `retire-venue:${INFUSE_SPEC.id}`,
    ];
    assert(
      exactJson([...keys].sort(), expectedKeys.sort()),
      "Event plan operation set is invalid.",
    );
    const functionForKind = {
      reviewed_venue_repair: API.venueRepair,
      reviewed_promotion_fold: API.promotionFold,
      reviewed_same_source_continuation_fold: API.continuationFold,
      retire_promoter_venue: API.venueUpdate,
    };
    assert(
      plan.operations.every(
        (operation) =>
          functionForKind[operation.kind] &&
          operation.mutation?.functionName === functionForKind[operation.kind],
      ),
      "Event plan contains an unreviewed mutation.",
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const convexUrl = normalizeText(
    process.env.NEXT_PUBLIC_CONVEX_URL ??
      process.env.CONVEX_SELF_HOSTED_URL ??
      process.env.CONVEX_URL,
  );
  const serviceSecret = normalizeText(
    process.env.INGESTION_SERVICE_SECRET ??
      process.env.CONVEX_INGESTION_SERVICE_SECRET ??
      process.env.CRON_SECRET,
  );
  assert(
    /^https?:\/\//u.test(convexUrl) && serviceSecret,
    "Production Convex configuration is missing.",
  );
  const client = new ConvexHttpClient(convexUrl);

  if (options.mode === "dry-run" || options.mode === "plan") {
    const plan =
      options.phase === "config"
        ? await buildConfigPlan(client, serviceSecret)
        : await buildEventPlan(client, serviceSecret);
    emit(planEnvelope(plan));
    return;
  }

  if (options.mode === "status" && options.phase === "config") {
    const status = await configStatus(client, serviceSecret);
    emit({
      schemaVersion: RESULT_SCHEMA,
      phase: "config",
      mode: "status",
      productionMutations: 0,
      ...status,
    });
    if (!status.complete) process.exitCode = 2;
    return;
  }

  const envelope = loadPlanFile(
    options.planFile,
    options.expectedPlanSha256,
    options.phase,
  );
  validatePlanShape(envelope.plan, options.phase);

  if (options.mode === "status") {
    const [eventStatus, currentConfigStatus] = await Promise.all([
      eventPlanStatus(client, serviceSecret, envelope.plan),
      configStatus(client, serviceSecret),
    ]);
    const complete = eventStatus.complete && currentConfigStatus.complete;
    emit({
      schemaVersion: RESULT_SCHEMA,
      phase: "events",
      mode: "status",
      planSha256: envelope.planSha256,
      productionMutations: 0,
      complete,
      events: eventStatus,
      config: currentConfigStatus,
    });
    if (!complete) process.exitCode = 2;
    return;
  }

  const results = [];
  if (options.phase === "config") {
    for (const operation of envelope.plan.operations) {
      results.push(
        await applyConfigOperation(client, serviceSecret, operation),
      );
    }
    const status = await configStatus(client, serviceSecret);
    assert(status.complete, "Config phase failed final verification.");
    emit({
      schemaVersion: RESULT_SCHEMA,
      phase: "config",
      mode: "apply",
      planSha256: envelope.planSha256,
      status: "complete",
      productionMutations: results.filter((row) => row.result === "applied")
        .length,
      results,
      verification: status,
    });
    return;
  }

  const preApplyConfigStatus = await configStatus(client, serviceSecret);
  assert(
    preApplyConfigStatus.complete,
    "Canonical venue/source configuration changed after event plan review.",
  );
  const preApplyInventory = await loadReviewedApprovedInventory(
    client,
    serviceSecret,
  );
  assertReviewedApprovedInventoryCovered(preApplyInventory);
  for (const operation of envelope.plan.operations) {
    results.push(await applyEventOperation(client, serviceSecret, operation));
  }
  const status = await eventPlanStatus(client, serviceSecret, envelope.plan);
  const finalConfigStatus = await configStatus(client, serviceSecret);
  assert(
    finalConfigStatus.complete,
    "Canonical venue/source configuration is no longer exact.",
  );
  assert(status.complete, "Event phase failed final verification.");
  emit({
    schemaVersion: RESULT_SCHEMA,
    phase: "events",
    mode: "apply",
    planSha256: envelope.planSha256,
    status: "complete",
    productionMutations: results.filter((row) => row.result === "applied")
      .length,
    results,
    verification: { events: status, config: finalConfigStatus },
  });
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      code: "E_REVIEWED_POSTER_VENUE_OPERATOR",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
