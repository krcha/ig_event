import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ConvexHttpClient } from "convex/browser";

/**
 * Two-phase, digest-gated operator for the reviewed 2026-08-27 venue and
 * cross-post duplicate corrections.
 *
 * Dry-run is read-only and emits the only plan accepted by apply/status.
 * Apply performs exact preimage checks, calls each mutation once, and then
 * verifies the exact semantic after-state. Only read queries have bounded
 * transient retries. The duplicate fold uses its dedicated service mutation;
 * it never falls back to a generic merge or delete.
 */

const PLAN_ENVELOPE_SCHEMA =
  "event-zeka-reviewed-venue-dedupe-plan-envelope-v1";
const CONFIG_PLAN_SCHEMA =
  "event-zeka-reviewed-venue-dedupe-config-plan-v1";
const EVENT_PLAN_SCHEMA =
  "event-zeka-reviewed-venue-dedupe-event-plan-v1";
const RESULT_SCHEMA = "event-zeka-reviewed-venue-dedupe-result-v1";
const TARGET_SET_VERSION =
  "event-zeka-reviewed-venue-dedupe-learning-2026-08-27:v2";
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const READ_QUERY_MAX_ATTEMPTS = 3;
const READ_QUERY_RETRY_BASE_DELAY_MS = 150;
const TRANSIENT_QUERY_ERROR_PATTERN =
  /\b(?:server error|terminated|network(?: error)?|socket(?: hang up)?|fetch (?:failed|error)|timeout|timed out|aborterror|aborted|connection (?:closed|reset|refused|terminated)|temporarily unavailable|service unavailable|gateway timeout|too many requests|rate limit(?:ed)?|econnreset|econnrefused|ehostunreach|enetunreach|enotfound|eai_again|etimedout|epipe|und_err_[a-z_]+)\b/iu;
const DETERMINISTIC_QUERY_ERROR_PATTERN =
  /\b(?:argumentvalidationerror|convexerror|unauthorized|forbidden|permission denied|uncaught (?:error|typeerror|rangeerror|referenceerror)|invalid (?:argument|value|id|cursor)|does not match|changed after plan review)\b/iu;
const CONFIG_CONFIRMATION =
  "APPLY_EVENT_ZEKA_REVIEWED_VENUE_DEDUPE_CONFIG_2026_08_27_V2";
const EVENT_CONFIRMATION =
  "APPLY_EVENT_ZEKA_REVIEWED_VENUE_DEDUPE_EVENTS_2026_08_27_V2";
const VENUE_REPAIR_NOTE =
  "Human-reviewed venue correction: immutable Instagram/poster evidence identifies the physical venue; all sibling source-receipt occurrences remain unchanged.";

const API = Object.freeze({
  correctionContext: "events:getReviewedStructuredEvidenceCorrectionContext",
  foldContext: "events:getReviewedCrossPostScheduleFoldContext",
  fold: "events:foldReviewedCrossPostScheduleDuplicate",
  receipt: "events:getInstagramSourceOccurrenceReceipt",
  venueRepair: "events:repairReviewedStructuredEventVenue",
  eventsByIds: "events:getManyByIds",
  venues: "venues:listVenues",
  venueUpdate: "venues:updateVenue",
  sourceByHandle: "instagramSources:getByHandle",
  sourceRoleUpdate: "instagramSources:setRole",
});

const VENUE_SPECS = Object.freeze([
  {
    id: "k178td4ewg6hpeqk1rqk4t07x589664x",
    handle: "muzej_jugoslavije",
    name: "Muzej Jugoslavije",
    requestedAliases: [
      "Museum of Yugoslavia",
      "Muzej istorije Jugoslavije",
      "Park skulptura",
      "Park skulptura Muzeja Jugoslavije",
      "Amphitheater in front of the Museum of Yugoslav History",
    ],
    publicStatus: "published",
    scrapeActive: true,
  },
  {
    id: "k177scs2zpr0a6cpg33argkzmd897mav",
    handle: "freestylerbelgrade_official",
    name: "Freestyler",
    requestedAliases: [
      "Freestyler Belgrade",
      "Freestyler Belgrade Nightclub",
      "Splav Freestyler",
    ],
    publicStatus: "published",
    scrapeActive: true,
  },
  {
    id: "k175zm16pp865q8g8hxym0gacs897kfv",
    handle: "chillton_bashta",
    name: "Chillton Bašta",
    requestedAliases: [
      "Chillton Bashta",
      "Chillton Bašti",
      "Čilton Bašta",
      "Čilton Bašti",
    ],
    publicStatus: "published",
    scrapeActive: true,
  },
  {
    id: "k1728w294h8dqr4m7z1kv24c6x897wr8",
    handle: "dubgastropub",
    name: "Dub Gastro Pub",
    requestedAliases: ["DUB Gastro Pub", "Dub Gastro", "Dub GastroPub"],
    publicStatus: "published",
    scrapeActive: true,
  },
  {
    id: "k17063s1xkrqppvj9563094db9897wc3",
    handle: "klubstudenatatehnike",
    name: "Klub Studenata Tehnike KST",
    requestedAliases: ["KST", "Klub Studenata Tehnike", "KST Beograd"],
    publicStatus: "published",
    scrapeActive: true,
  },
  {
    id: "k172xcmnd3qw4jqgcswwwrykw5896new",
    handle: "kolarac_kolarceva_zaduzbina",
    name: "Kolarac",
    requestedAliases: [
      "Kolarac",
      "Art bioskop Kolarac",
      "Kolarčeva zadužbina",
      "Ilija M. Kolarac Endowment",
    ],
    publicStatus: "published",
    scrapeActive: true,
  },
]);

const SOURCE_SPECS = Object.freeze([
  ...VENUE_SPECS.filter(
    (spec) => spec.handle !== "kolarac_kolarceva_zaduzbina",
  ).map((spec) => ({
    handle: spec.handle,
    role: "venue",
    venueHandle: spec.handle,
  })),
  { handle: "kaif.belgrad", role: "promoter", venueHandle: null },
]);

const VENUE_REPAIR_GROUPS = Object.freeze([
  {
    venueHandle: "muzej_jugoslavije",
    sourceHandle: "muzej_jugoslavije",
    ids: [
      "j57cqz2wjse5twxa52vckep5j18cygr6",
      "j57fe9ayv1kzh6pbcn78jsc8ed8d3cgx",
    ],
    evidence:
      "The reviewed @muzej_jugoslavije posts and poster/caption evidence identify Muzej Jugoslavije, including its Park skulptura program area.",
  },
  {
    venueHandle: "freestylerbelgrade_official",
    sourceHandle: "kaif.belgrad",
    ids: ["j5750ewadw545vyf167cxwr5398d8242"],
    expectedAmbiguousApprovedEvents: [
      {
        id: "j572s3nx1hepy3j4stfd488d318d095m",
        title: "TO ME RADI",
        date: "2026-08-28",
        time: "TBD",
        venueId: "k177scs2zpr0a6cpg33argkzmd897mav",
        instagramPostUrl: "https://www.instagram.com/p/DcWgamVjHFi/",
      },
    ],
    evidence:
      "The reviewed @freestylerbelgrade_official source and event evidence identify Freestyler.",
  },
  {
    venueHandle: "chillton_bashta",
    sourceHandle: "chillton_bashta",
    ids: ["j571q34jhe5tsrb7sv2mv5zcts8d2z6q"],
    evidence:
      "The reviewed @chillton_bashta source and event evidence identify the physical venue as Chillton Bašta.",
  },
  {
    venueHandle: "dubgastropub",
    sourceHandle: "dubgastropub",
    ids: ["j578yv7xjgnsdtqdjb5y9757zh8d393f"],
    evidence:
      "The reviewed @dubgastropub source and event evidence identify Dub Gastro Pub.",
  },
  {
    venueHandle: "klubstudenatatehnike",
    sourceHandle: "klubstudenatatehnike",
    ids: ["j576gp53tt022xrcjah31wptzd8cx1fc"],
    evidence:
      "The reviewed @klubstudenatatehnike source, poster abbreviation KST, and caption identify Klub Studenata Tehnike KST.",
  },
]);

const FOLD_SPEC = Object.freeze({
  operationId:
    "reviewed-venue-dedupe-2026-08-27:hobotnica-cross-post-schedule",
  primaryId: "j573aw97jpkxdcdnh181qm7s418d2896",
  legacyId: "j57c4hdz1an3hrzdg7n3jgr8c98azcdt",
  expectedPrimarySourceHandle: "kolarac_art_bioskop",
  expectedVenueHandle: "kolarac_kolarceva_zaduzbina",
  expectedDate: "2026-08-27",
  expectedTime: "20:30",
  titleAnchors: ["HOBOTNICA", "Hobotnica"],
  occurrenceAnchors: ["HOBOTNICA"],
  primaryVenueEvidence: "Kolarca",
  duplicateVenueEvidence: "Art bioskopa Kolarac",
  nextTitle: "HOBOTNICA",
  nextTime: "20:30",
  nextVenue: "Kolarac",
  nextArtists: [],
  nextDescription:
    "Documentary screening at Kolarac, lasting 64 minutes. Tickets cost 400 RSD.",
  timeEvidenceText: "20:30- HOBOTNICA",
  moderationNote:
    "Human-reviewed cross-post schedule duplicate: both rows describe HOBOTNICA at Kolarac on 2026-08-27 at 20:30; keep the seven-occurrence receipt-backed row and reject the legacy row in place.",
});

function usage() {
  return [
    "Usage:",
    "  node scripts/apply-reviewed-venue-dedupe-learning.mjs --phase config --mode dry-run",
    `  node scripts/apply-reviewed-venue-dedupe-learning.mjs --phase config --mode apply --plan-file ABS --expected-plan-sha256 SHA --confirm ${CONFIG_CONFIRMATION}`,
    "  node scripts/apply-reviewed-venue-dedupe-learning.mjs --phase config --mode status --plan-file ABS --expected-plan-sha256 SHA",
    "  node scripts/apply-reviewed-venue-dedupe-learning.mjs --phase events --mode dry-run",
    `  node scripts/apply-reviewed-venue-dedupe-learning.mjs --phase events --mode apply --plan-file ABS --expected-plan-sha256 SHA --confirm ${EVENT_CONFIRMATION}`,
    "  node scripts/apply-reviewed-venue-dedupe-learning.mjs --phase events --mode status --plan-file ABS --expected-plan-sha256 SHA",
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
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}.`);
      }
      index += 1;
      return value;
    };
    if (arg === "--phase") options.phase = take();
    else if (arg === "--mode") options.mode = take();
    else if (arg === "--plan-file") options.planFile = take();
    else if (arg === "--expected-plan-sha256") {
      options.expectedPlanSha256 = take();
    } else if (arg === "--confirm") options.confirmation = take();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!new Set(["config", "events"]).has(options.phase)) {
    throw new Error(usage());
  }
  if (!new Set(["dry-run", "apply", "status"]).has(options.mode)) {
    throw new Error(usage());
  }
  if (options.mode !== "dry-run") {
    if (!options.planFile || !HASH_PATTERN.test(options.expectedPlanSha256)) {
      throw new Error(
        "Apply/status requires an exact absolute plan file and reviewed SHA-256 digest.",
      );
    }
  }
  if (options.mode === "apply") {
    const expected =
      options.phase === "config" ? CONFIG_CONFIRMATION : EVENT_CONFIRMATION;
    if (options.confirmation !== expected) {
      throw new Error("Apply confirmation is missing or does not match this phase.");
    }
  } else if (options.confirmation) {
    throw new Error("Only apply accepts a confirmation token.");
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

function exactJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function projectionSha256(value) {
  return sha256(canonicalJson(value));
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

function exactKeys(value, expected) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      exactJson(Object.keys(value).sort(), [...expected].sort()),
  );
}

function parseObjectJson(value, label) {
  try {
    const parsed = JSON.parse(value ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error(`${label} is not valid object JSON.`);
  }
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
  return Boolean(
    text &&
      !DETERMINISTIC_QUERY_ERROR_PATTERN.test(text) &&
      TRANSIENT_QUERY_ERROR_PATTERN.test(text),
  );
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
        attempt === READ_QUERY_MAX_ATTEMPTS ||
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

function venueProjection(venue, includeRevision = true) {
  return {
    id: venue?._id ?? null,
    ...(includeRevision ? { updatedAt: venue?.updatedAt ?? null } : {}),
    name: venue?.name ?? null,
    instagramHandle: normalizeHandle(venue?.instagramHandle),
    aliases: Array.isArray(venue?.aliases) ? venue.aliases : [],
    location: venue?.location ?? null,
    publicStatus: venue?.publicStatus ?? null,
    scrapeActive: venue?.scrapeActive ?? null,
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

function contextProjection(context) {
  return {
    event: eventPreimageProjection(context.event),
    sourceLink: sourceLinkProjection(context.sourceLink),
    receipt: receiptProjection(context.receipt),
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

function markerMatches(event, expected) {
  const marker = reviewedMarker(event, expected.field);
  return Boolean(
    marker &&
      typeof marker === "object" &&
      !Array.isArray(marker) &&
      Object.entries(expected).every(([key, value]) =>
        key === "field" ? true : exactJson(marker[key], value),
      ),
  );
}

function unionAliases(current, spec) {
  const targetName = spec.preserveName ? current.name : spec.name;
  const candidates = [
    ...(Array.isArray(current.aliases) ? current.aliases : []),
    ...(!spec.preserveName && current.name !== targetName ? [current.name] : []),
    ...spec.requestedAliases,
  ];
  const canonicalKey = aliasKey(targetName);
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

function targetVenueProjection(current, spec) {
  return {
    id: current._id,
    name: spec.preserveName ? current.name : spec.name,
    instagramHandle: spec.handle,
    aliases: unionAliases(current, spec),
    location: current.location ?? null,
    publicStatus: spec.publicStatus,
    scrapeActive: spec.scrapeActive,
  };
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
    "Plan envelope schema is invalid.",
  );
  assert(
    HASH_PATTERN.test(envelope.planSha256) &&
      envelope.planSha256 === expectedSha256,
    "Reviewed plan digest does not match the envelope.",
  );
  assert(
    projectionSha256(envelope.plan) === envelope.planSha256,
    "Plan content does not match its canonical digest.",
  );
  assert(
    envelope.plan?.phase === expectedPhase,
    "Plan phase does not match the command.",
  );
  const expectedSchema =
    expectedPhase === "config" ? CONFIG_PLAN_SCHEMA : EVENT_PLAN_SCHEMA;
  assert(
    envelope.plan.schemaVersion === expectedSchema,
    "Plan schema does not match the command.",
  );
  return envelope;
}

async function loadVenues(client, serviceSecret) {
  const venues = await queryWithTransientRetry(client, API.venues, {
    serviceSecret,
  });
  return new Map(venues.map((venue) => [venue._id, venue]));
}

function venuesByHandle(venues) {
  const result = new Map();
  for (const venue of venues.values()) {
    const handle = normalizeHandle(venue.instagramHandle);
    if (!handle) continue;
    assert(
      !result.has(handle),
      `Multiple venues resolve to reviewed handle @${handle}.`,
    );
    result.set(handle, venue);
  }
  return result;
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

function assertVenueAliasesUnambiguous(venues, plannedTargets) {
  const valuesByVenue = new Map();
  for (const venue of venues.values()) {
    const target = plannedTargets.get(venue._id);
    const values = [target?.name ?? venue.name, ...(target?.aliases ?? venue.aliases ?? [])]
      .map((value) => ({ key: aliasKey(value), value }))
      .filter((entry) => entry.key);
    assert(
      new Set(values.map((entry) => entry.key)).size === values.length,
      `Venue ${venue._id} has duplicate canonical name/aliases.`,
    );
    valuesByVenue.set(venue._id, values);
  }
  for (const spec of VENUE_SPECS) {
    const target = [...plannedTargets.values()].find(
      (row) => row.instagramHandle === spec.handle,
    );
    assert(target, `Reviewed venue @${spec.handle} has no target.`);
    const own = valuesByVenue.get(target.id) ?? [];
    for (const [otherId, other] of valuesByVenue) {
      if (otherId === target.id) continue;
      const otherKeys = new Set(other.map((entry) => entry.key));
      const collision = own.find((entry) => otherKeys.has(entry.key));
      assert(
        !collision,
        `Reviewed venue alias ${JSON.stringify(collision?.value)} conflicts with venue ${otherId}.`,
      );
    }
  }
}

async function buildConfigPlan(client, serviceSecret) {
  const [venues, sources] = await Promise.all([
    loadVenues(client, serviceSecret),
    loadSources(client, serviceSecret),
  ]);
  const byHandle = venuesByHandle(venues);
  const targetsByHandle = new Map();
  const targetsById = new Map();
  for (const spec of VENUE_SPECS) {
    const venue = byHandle.get(spec.handle);
    assert(venue, `Canonical venue @${spec.handle} is missing.`);
    assert(
      venue._id === spec.id,
      `Canonical venue @${spec.handle} is not the reviewed venue ${spec.id}.`,
    );
    const target = targetVenueProjection(venue, spec);
    assert(
      target.aliases.length <= 20,
      `Venue @${spec.handle} exceeds the 20-alias safety bound.`,
    );
    targetsByHandle.set(spec.handle, target);
    targetsById.set(venue._id, target);
  }
  assertVenueAliasesUnambiguous(venues, targetsById);

  const operations = [];
  for (const spec of VENUE_SPECS) {
    const venue = byHandle.get(spec.handle);
    const after = targetsByHandle.get(spec.handle);
    operations.push({
      kind: "venue_config",
      key: `venue:${spec.handle}`,
      specHandle: spec.handle,
      before: venueProjection(venue),
      after,
      mutation: {
        functionName: API.venueUpdate,
        args: {
          id: venue._id,
          expectedUpdatedAt: venue.updatedAt,
          patch: {
            ...(!spec.preserveName ? { name: after.name } : {}),
            aliases: after.aliases,
            publicStatus: after.publicStatus,
            scrapeActive: after.scrapeActive,
          },
          auditNote:
            "Reviewed 2026-08-27 venue identity learning: preserve existing aliases, add reviewed aliases, and keep the canonical public ingestion venue active.",
        },
      },
    });
  }
  for (const spec of SOURCE_SPECS) {
    const source = sources.get(spec.handle);
    assert(source, `Instagram source @${spec.handle} is missing.`);
    assert(source.active === true, `Instagram source @${spec.handle} is inactive.`);
    const venueId = spec.venueHandle
      ? targetsByHandle.get(spec.venueHandle)?.id
      : null;
    assert(
      !spec.venueHandle || venueId,
      `Source @${spec.handle} has no reviewed venue target.`,
    );
    const after = {
      id: source._id,
      handle: spec.handle,
      role: spec.role,
      venueId,
      active: true,
    };
    operations.push({
      kind: "source_config",
      key: `source:${spec.handle}`,
      specHandle: spec.handle,
      before: sourceProjection(source),
      after,
      mutation: {
        functionName: API.sourceRoleUpdate,
        args: {
          handle: spec.handle,
          role: spec.role,
          ...(venueId ? { venueId } : {}),
          expectedUpdatedAt: source.updatedAt,
        },
      },
    });
  }
  return {
    schemaVersion: CONFIG_PLAN_SCHEMA,
    phase: "config",
    targetSetVersion: TARGET_SET_VERSION,
    targetSetSha256: configTargetSetSha256(),
    plannedAt: new Date().toISOString(),
    operations,
  };
}

async function configOperationAfterMatches(
  client,
  serviceSecret,
  operation,
) {
  if (operation.kind === "venue_config") {
    const venue = (await loadVenues(client, serviceSecret)).get(
      operation.after.id,
    );
    return Boolean(
      venue && exactJson(venueProjection(venue, false), operation.after),
    );
  }
  const source = await queryWithTransientRetry(client, API.sourceByHandle, {
    handle: operation.after.handle,
    serviceSecret,
  });
  return Boolean(
    source && exactJson(sourceProjection(source, false), operation.after),
  );
}

async function applyConfigOperation(client, serviceSecret, operation) {
  if (await configOperationAfterMatches(client, serviceSecret, operation)) {
    return { key: operation.key, result: "already_exact" };
  }
  if (operation.kind === "venue_config") {
    const current = (await loadVenues(client, serviceSecret)).get(
      operation.before.id,
    );
    assert(
      current && exactJson(venueProjection(current), operation.before),
      `Venue @${operation.specHandle} changed after plan review.`,
    );
  } else {
    const current = await queryWithTransientRetry(
      client,
      API.sourceByHandle,
      { handle: operation.before.handle, serviceSecret },
    );
    assert(
      current && exactJson(sourceProjection(current), operation.before),
      `Source @${operation.specHandle} changed after plan review.`,
    );
  }
  // Intentionally no mutation retry. A lost acknowledgement is reconciled by
  // the exact read-only status path before any reviewed rerun.
  await client.mutation(operation.mutation.functionName, {
    ...operation.mutation.args,
    serviceSecret,
  });
  assert(
    await configOperationAfterMatches(client, serviceSecret, operation),
    `${operation.key} failed exact post-mutation verification.`,
  );
  return { key: operation.key, result: "applied" };
}

async function configPlanStatus(client, serviceSecret, plan) {
  const operations = [];
  for (const operation of plan.operations) {
    let exact = false;
    try {
      exact = await configOperationAfterMatches(
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

async function loadEventsByIds(client, serviceSecret, ids, allowMissing = false) {
  const uniqueIds = [...new Set(ids)];
  const events = await queryWithTransientRetry(client, API.eventsByIds, {
    ids: uniqueIds,
    serviceSecret,
  });
  const byId = new Map(events.filter(Boolean).map((event) => [event._id, event]));
  if (!allowMissing) {
    for (const id of uniqueIds) {
      assert(byId.has(id), `Reviewed event ${id} is missing.`);
    }
  }
  return byId;
}

function eventSourceHandle(event) {
  const fields = parseObjectJson(
    event.normalizedFieldsJson,
    `Event ${event._id} normalized evidence`,
  );
  return normalizeHandle(fields.sourceGroundingInstagramHandle);
}

async function correctionContext(client, serviceSecret, id) {
  const context = await queryWithTransientRetry(client, API.correctionContext, {
    id,
    serviceSecret,
  });
  assert(context?.event?._id === id, `Reviewed context ${id} is invalid.`);
  return context;
}

function bindReceiptVenue(context, nextVenue) {
  const key = context.sourceLink.sourceOccurrenceKey;
  const expectedMatches = context.receipt.expectedOccurrences.filter(
    (row) => row.key === key,
  );
  const satisfiedMatches = context.receipt.satisfiedOccurrences.filter(
    (row) => row.key === key && row.eventId === context.event._id,
  );
  assert(
    expectedMatches.length === 1 && satisfiedMatches.length === 1,
    `Receipt ${context.receipt._id} lost its one reviewed event occurrence.`,
  );
  return {
    ...receiptProjection(context.receipt, false),
    expectedOccurrences: context.receipt.expectedOccurrences.map((row) =>
      row.key === key ? { ...row, venue: nextVenue } : row,
    ),
    satisfiedOccurrences: context.receipt.satisfiedOccurrences.map((row) => ({
      ...row,
    })),
  };
}

function allowedCurrentVenueKeys(venue, spec) {
  return new Set(
    [
      "",
      venue.name,
      ...(venue.aliases ?? []),
      ...spec.requestedAliases,
      ...(spec.allowedBeforeNames ?? []),
      ...(!spec.preserveName ? [spec.name] : []),
    ].map(aliasKey),
  );
}

async function buildVenueRepairOperation(
  client,
  serviceSecret,
  id,
  group,
  venue,
) {
  const context = await correctionContext(client, serviceSecret, id);
  const spec = VENUE_SPECS.find((row) => row.handle === group.venueHandle);
  assert(spec, `Venue repair ${id} has an unknown target.`);
  assert(context.event.status === "approved", `Event ${id} is not approved.`);
  assert(
    eventSourceHandle(context.event) === group.sourceHandle &&
      (!context.sourceLink.sourceHandle ||
        normalizeHandle(context.sourceLink.sourceHandle) === group.sourceHandle),
    `Event ${id} is no longer grounded to @${group.sourceHandle}.`,
  );
  assert(
    allowedCurrentVenueKeys(venue, spec).has(aliasKey(context.event.venue)),
    `Event ${id} has an unreviewed current venue ${JSON.stringify(context.event.venue)}.`,
  );
  const targetFields = {
    venue: venue.name,
    venueId: venue._id,
    venueInstagramHandle: normalizeHandle(venue.instagramHandle),
  };
  const afterEvent = {
    ...eventPublicProjection(context.event),
    ...targetFields,
    moderationNote: VENUE_REPAIR_NOTE,
  };
  const marker = {
    field: "reviewedVenueCorrection",
    policyVersion: 1,
    venue: venue.name,
    evidence: group.evidence,
  };
  const expectedAmbiguousApprovedEvents = group.expectedAmbiguousApprovedEvents ?? [];
  const ambiguousEvents = expectedAmbiguousApprovedEvents.length
    ? await loadEventsByIds(
        client,
        serviceSecret,
        expectedAmbiguousApprovedEvents.map((row) => row.id),
        true,
      )
    : new Map();
  const expectedAmbiguousApprovedEventVersions =
    expectedAmbiguousApprovedEvents.map((expected) => {
      const ambiguous = ambiguousEvents.get(expected.id);
      assert(
        ambiguous &&
          ambiguous.status === "approved" &&
          ambiguous.title === expected.title &&
          ambiguous.date === expected.date &&
          (ambiguous.time ?? null) === expected.time &&
          ambiguous.venueId === expected.venueId &&
          ambiguous.instagramPostUrl === expected.instagramPostUrl &&
          Number.isSafeInteger(ambiguous.updatedAt),
        `Event ${id} reviewed ambiguity ${expected.id} changed or is missing.`,
      );
      return { id: ambiguous._id, updatedAt: ambiguous.updatedAt };
    });
  return {
    kind: "reviewed_venue_repair",
    key: `event-venue:${id}`,
    groupHandle: group.venueHandle,
    before: contextProjection(context),
    targetVenue: venueProjection(venue),
    after: {
      event: afterEvent,
      receipt: bindReceiptVenue(context, venue.name),
      marker,
    },
    mutation: {
      functionName: API.venueRepair,
      args: {
        id,
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
        moderationNote: VENUE_REPAIR_NOTE,
        expectedAmbiguousApprovedEventVersions,
      },
    },
  };
}

function foldBlocked(reason) {
  throw new Error(`E_REVIEWED_FOLD_BLOCKED:${reason}`);
}

function assertFold(condition, reason) {
  if (!condition) foldBlocked(reason);
}

async function loadFoldContext(client, serviceSecret) {
  const value = await queryWithTransientRetry(client, API.foldContext, {
    operationId: FOLD_SPEC.operationId,
    primaryId: FOLD_SPEC.primaryId,
    duplicateId: FOLD_SPEC.legacyId,
    serviceSecret,
  });
  assertFold(value && typeof value === "object", "context_query_invalid");
  return value;
}

function sourceContextProjection(source, includeRevision = true) {
  return {
    link: sourceLinkProjection(source.link),
    receipt: source.receipt
      ? receiptProjection(source.receipt, includeRevision)
      : null,
  };
}

function saveRowsProjection(rows) {
  return [...rows]
    .map((row) => ({ ...row }))
    .sort((left, right) => String(left._id).localeCompare(String(right._id)));
}

function saveStateProjection(value) {
  return {
    savedEvents: saveRowsProjection(value.savedEvents),
    userSavedEvents: saveRowsProjection(value.userSavedEvents),
  };
}

function foldBeforeProjection(context) {
  return {
    primary: eventPreimageProjection(context.primary),
    duplicate: eventPreimageProjection(context.duplicate),
    primarySources: context.primarySources.map((source) =>
      sourceContextProjection(source),
    ),
    duplicateSources: context.duplicateSources.map((source) =>
      sourceContextProjection(source),
    ),
    primarySaves: saveStateProjection(context.primarySaves),
    duplicateSaves: saveStateProjection(context.duplicateSaves),
  };
}

function foldRowSourceText(event) {
  const fields = parseObjectJson(
    event.normalizedFieldsJson,
    `Event ${event._id} normalized evidence`,
  );
  assertFold(fields.multiEventSplitDetected === true, `${event._id}_not_multi_event`);
  const row = normalizeText(fields.rowSourceText ?? fields.splitSourceLine);
  assertFold(row, `${event._id}_row_evidence_missing`);
  return row;
}

function foldMarker(before, targetVenue) {
  const primarySource = before.primarySources[0];
  return {
    policyVersion: 1,
    operationId: FOLD_SPEC.operationId,
    primaryEventId: FOLD_SPEC.primaryId,
    duplicateEventId: FOLD_SPEC.legacyId,
    primarySourceIdentity: primarySource.link.sourceIdentity,
    primarySourceOccurrenceKey: primarySource.link.sourceOccurrenceKey,
    occurrenceAnchors: FOLD_SPEC.occurrenceAnchors,
    primaryRowSourceText: foldRowSourceTextFromPlan(before.primary),
    duplicateRowSourceText: foldRowSourceTextFromPlan(before.duplicate),
    primaryVenueEvidence: FOLD_SPEC.primaryVenueEvidence,
    duplicateVenueEvidence: FOLD_SPEC.duplicateVenueEvidence,
    targetVenueId: targetVenue.id,
  };
}

function foldRowSourceTextFromPlan(event) {
  const fields = parseObjectJson(
    event.normalizedFieldsJson,
    `Event ${event.id} normalized evidence`,
  );
  assertFold(fields.multiEventSplitDetected === true, `${event.id}_not_multi_event`);
  const row = normalizeText(fields.rowSourceText ?? fields.splitSourceLine);
  assertFold(row, `${event.id}_row_evidence_missing`);
  return row;
}

function foldPrimaryModerationNote() {
  return `[reviewed_cross_post_schedule_primary:v1] ${FOLD_SPEC.operationId} - ${FOLD_SPEC.moderationNote}`;
}

function foldDuplicateModerationNote() {
  return `[reviewed_cross_post_schedule_duplicate:v1] ${FOLD_SPEC.operationId} - ${FOLD_SPEC.moderationNote}`;
}

function foldReceiptAfter(before) {
  const source = before.primarySources[0];
  const key = source.link.sourceOccurrenceKey;
  const receipt = source.receipt;
  assertFold(receipt, "primary_receipt_missing");
  assertFold(
    receipt.expectedOccurrences.length === 7 &&
      receipt.satisfiedOccurrences.length === 7,
    "primary_receipt_not_seven_rows",
  );
  const expectedMatches = receipt.expectedOccurrences.filter(
    (row) => row.key === key,
  );
  const satisfiedMatches = receipt.satisfiedOccurrences.filter(
    (row) => row.key === key && row.eventId === FOLD_SPEC.primaryId,
  );
  assertFold(
    expectedMatches.length === 1 && satisfiedMatches.length === 1,
    "primary_receipt_occurrence_not_exact",
  );
  const result = { ...receipt };
  delete result.updatedAt;
  result.expectedOccurrences = receipt.expectedOccurrences.map((row) =>
    row.key === key
      ? {
          ...row,
          date: before.primary.date,
          time: FOLD_SPEC.nextTime,
          venue: FOLD_SPEC.nextVenue,
          title: FOLD_SPEC.nextTitle,
          artists: FOLD_SPEC.nextArtists,
        }
      : { ...row },
  );
  result.satisfiedOccurrences = receipt.satisfiedOccurrences.map((row) => ({
    ...row,
  }));
  for (let index = 0; index < receipt.expectedOccurrences.length; index += 1) {
    const current = receipt.expectedOccurrences[index];
    const next = result.expectedOccurrences[index];
    if (current.key !== key) {
      assertFold(exactJson(current, next), `expected_sibling_${index}_changed`);
    }
  }
  assertFold(
    exactJson(receipt.satisfiedOccurrences, result.satisfiedOccurrences),
    "satisfied_sibling_changed",
  );
  return result;
}

function projectMovedSaveRows(primaryRows, duplicateRows, eventId) {
  const result = saveRowsProjection(primaryRows);
  const users = new Set(result.map((row) => String(row.userId)));
  for (const row of saveRowsProjection(duplicateRows)) {
    const user = String(row.userId);
    if (users.has(user)) continue;
    users.add(user);
    result.push({ ...row, eventId });
  }
  return result.sort((left, right) =>
    String(left._id).localeCompare(String(right._id)),
  );
}

function foldSaveStateAfter(before) {
  return {
    primarySaves: {
      savedEvents: projectMovedSaveRows(
        before.primarySaves.savedEvents,
        before.duplicateSaves.savedEvents,
        FOLD_SPEC.primaryId,
      ),
      userSavedEvents: projectMovedSaveRows(
        before.primarySaves.userSavedEvents,
        before.duplicateSaves.userSavedEvents,
        FOLD_SPEC.primaryId,
      ),
    },
    duplicateSaves: { savedEvents: [], userSavedEvents: [] },
  };
}

function foldAfterProjection(before, targetVenue) {
  const marker = foldMarker(before, targetVenue);
  const saves = foldSaveStateAfter(before);
  return {
    primary: {
      ...eventPublicProjectionFromPlan(before.primary),
      title: FOLD_SPEC.nextTitle,
      time: FOLD_SPEC.nextTime,
      venue: FOLD_SPEC.nextVenue,
      venueId: targetVenue.id,
      venueInstagramHandle: targetVenue.instagramHandle,
      artists: FOLD_SPEC.nextArtists,
      description: FOLD_SPEC.nextDescription,
      timeSource: "schedule_entry",
      timeEvidenceText: FOLD_SPEC.timeEvidenceText,
      timeConfidence: 0.99,
      timeStatus: "confirmed",
      timeEvidenceKind: "start_time_stated",
      moderationNote: foldPrimaryModerationNote(),
    },
    duplicate: {
      ...eventPublicProjectionFromPlan(before.duplicate),
      status: "rejected",
      moderationNote: foldDuplicateModerationNote(),
    },
    primarySourceLink: { ...before.primarySources[0].link },
    primaryReceipt: foldReceiptAfter(before),
    duplicateSources: before.duplicateSources.map((source) => ({ ...source })),
    ...saves,
    primaryMarker: {
      field: "reviewedCrossPostScheduleFold",
      ...marker,
    },
    duplicateMarker: {
      field: "reviewedCrossPostScheduleDuplicate",
      ...marker,
    },
    audits: {
      primaryAction: "reviewed_cross_post_schedule_folded",
      duplicateAction: "reviewed_cross_post_schedule_duplicate_rejected",
      operationId: FOLD_SPEC.operationId,
    },
  };
}

function foldMutationArgs(before, targetVenue) {
  return {
    operationId: FOLD_SPEC.operationId,
    primaryId: FOLD_SPEC.primaryId,
    expectedPrimaryUpdatedAt: before.primary.updatedAt,
    expectedPrimaryNormalizedFieldsJson: before.primary.normalizedFieldsJson,
    expectedPrimarySourceLinkId: before.primarySources[0].link.id,
    expectedPrimarySourceLinkUpdatedAt:
      before.primarySources[0].link.updatedAt,
    expectedPrimaryReceiptId: before.primarySources[0].receipt.id,
    expectedPrimaryReceiptUpdatedAt:
      before.primarySources[0].receipt.updatedAt,
    duplicateId: FOLD_SPEC.legacyId,
    expectedDuplicateUpdatedAt: before.duplicate.updatedAt,
    expectedDuplicateNormalizedFieldsJson: before.duplicate.normalizedFieldsJson,
    expectedDuplicateSourceVersions: before.duplicateSources
      .map((source) => ({
        id: source.link.id,
        updatedAt: source.link.updatedAt,
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id))),
    targetVenueId: targetVenue.id,
    expectedTargetVenueUpdatedAt: targetVenue.updatedAt,
    expectedTargetVenueHandle: targetVenue.instagramHandle,
    occurrenceAnchors: FOLD_SPEC.occurrenceAnchors,
    primaryVenueEvidence: FOLD_SPEC.primaryVenueEvidence,
    duplicateVenueEvidence: FOLD_SPEC.duplicateVenueEvidence,
    nextTitle: FOLD_SPEC.nextTitle,
    nextTime: FOLD_SPEC.nextTime,
    nextVenue: FOLD_SPEC.nextVenue,
    nextArtists: FOLD_SPEC.nextArtists,
    nextDescription: FOLD_SPEC.nextDescription,
    timeEvidenceText: FOLD_SPEC.timeEvidenceText,
    moderationNote: FOLD_SPEC.moderationNote,
  };
}

function configTargetSetSha256() {
  return projectionSha256({ VENUE_SPECS, SOURCE_SPECS });
}

function eventTargetSetSha256() {
  return projectionSha256({ VENUE_REPAIR_GROUPS, FOLD_SPEC });
}

function buildFoldOperationFromContext(context, targetVenue) {
  assertFold(context.primary?._id === FOLD_SPEC.primaryId, "primary_mismatch");
  assertFold(context.duplicate?._id === FOLD_SPEC.legacyId, "duplicate_mismatch");
  assertFold(context.primary.status === "approved", "primary_not_approved");
  assertFold(context.duplicate.status === "approved", "duplicate_not_approved");
  assertFold(
    Array.isArray(context.primarySources) && context.primarySources.length === 1,
    "primary_source_link_count_not_one",
  );
  assertFold(
    Array.isArray(context.duplicateSources) && context.duplicateSources.length === 0,
    "legacy_duplicate_has_source_links",
  );
  const primarySource = context.primarySources[0];
  assertFold(primarySource.receipt, "primary_receipt_missing");
  assertFold(
    primarySource.link.eventId === FOLD_SPEC.primaryId &&
      primarySource.link.sourceIdentity === primarySource.receipt.sourceIdentity &&
      primarySource.link.sourceFingerprint === primarySource.receipt.sourceFingerprint,
    "primary_source_receipt_mismatch",
  );
  assertFold(
    primarySource.receipt.expectedOccurrences?.length === 7 &&
      primarySource.receipt.satisfiedOccurrences?.length === 7,
    "primary_receipt_not_seven_rows",
  );
  assertFold(
    context.primary.date === FOLD_SPEC.expectedDate &&
      context.duplicate.date === FOLD_SPEC.expectedDate,
    "date_mismatch",
  );
  assertFold(
    context.primary.time === FOLD_SPEC.expectedTime &&
      context.duplicate.time === FOLD_SPEC.expectedTime,
    "time_mismatch",
  );
  assertFold(
    aliasKey(context.primary.title).includes(aliasKey(FOLD_SPEC.nextTitle)) &&
      aliasKey(context.duplicate.title).includes(aliasKey(FOLD_SPEC.nextTitle)),
    "title_identity_mismatch",
  );
  assertFold(
    exactJson(context.primary.artists, FOLD_SPEC.nextArtists) &&
      exactJson(context.duplicate.artists, FOLD_SPEC.nextArtists),
    "artist_identity_mismatch",
  );
  const primaryPostId = normalizeText(context.primary.instagramPostId);
  const duplicatePostId = normalizeText(context.duplicate.instagramPostId);
  const primaryPostUrl = normalizeText(context.primary.instagramPostUrl);
  const duplicatePostUrl = normalizeText(context.duplicate.instagramPostUrl);
  assertFold(
    (primaryPostId && duplicatePostId && primaryPostId !== duplicatePostId) ||
      (primaryPostUrl &&
        duplicatePostUrl &&
        primaryPostUrl !== duplicatePostUrl),
    "instagram_posts_not_distinct",
  );
  assertFold(
    eventSourceHandle(context.primary) === FOLD_SPEC.expectedPrimarySourceHandle &&
      (!primarySource.link.sourceHandle ||
        normalizeHandle(primarySource.link.sourceHandle) ===
          FOLD_SPEC.expectedPrimarySourceHandle),
    "primary_source_handle_mismatch",
  );
  assertFold(
    !context.duplicate.sourceOccurrenceKey,
    "legacy_duplicate_has_occurrence_key",
  );
  assertFold(
    targetVenue.id === "k172xcmnd3qw4jqgcswwwrykw5896new" &&
      targetVenue.name === FOLD_SPEC.nextVenue &&
      targetVenue.instagramHandle === FOLD_SPEC.expectedVenueHandle &&
      targetVenue.publicStatus === "published",
    "target_venue_mismatch",
  );
  for (const anchor of FOLD_SPEC.titleAnchors) {
    assertFold(
      aliasKey(context.primary.title).includes(aliasKey(anchor)) ||
        aliasKey(context.duplicate.title).includes(aliasKey(anchor)),
      `title_anchor_missing_${aliasKey(anchor).replace(/ /gu, "_")}`,
    );
  }
  const primaryRow = foldRowSourceText(context.primary);
  const duplicateRow = foldRowSourceText(context.duplicate);
  for (const anchor of FOLD_SPEC.occurrenceAnchors) {
    assertFold(
      aliasKey(primaryRow).includes(aliasKey(anchor)) &&
        aliasKey(duplicateRow).includes(aliasKey(anchor)),
      `row_anchor_missing_${aliasKey(anchor).replace(/ /gu, "_")}`,
    );
  }
  assertFold(
    aliasKey(context.primary.sourceCaption).includes(
      aliasKey(FOLD_SPEC.primaryVenueEvidence),
    ) &&
      aliasKey(context.duplicate.sourceCaption).includes(
        aliasKey(FOLD_SPEC.duplicateVenueEvidence),
      ),
    "venue_evidence_missing",
  );
  assertFold(
    Array.isArray(context.primaryAudits) && context.primaryAudits.length === 0 &&
      Array.isArray(context.duplicateAudits) && context.duplicateAudits.length === 0,
    "operation_audit_already_exists",
  );
  const occurrenceKey = primarySource.link.sourceOccurrenceKey;
  const currentExpected = primarySource.receipt.expectedOccurrences.filter(
    (row) => row.key === occurrenceKey,
  );
  const currentSatisfied = primarySource.receipt.satisfiedOccurrences.filter(
    (row) => row.key === occurrenceKey && row.eventId === FOLD_SPEC.primaryId,
  );
  assertFold(
    currentExpected.length === 1 &&
      currentSatisfied.length === 1 &&
      currentExpected[0].date === context.primary.date &&
      currentExpected[0].time === context.primary.time &&
      aliasKey(currentExpected[0].venue) === aliasKey(context.primary.venue) &&
      aliasKey(currentExpected[0].title) === aliasKey(context.primary.title) &&
      exactJson(currentExpected[0].artists, context.primary.artists),
    "primary_receipt_binding_mismatch",
  );
  const before = foldBeforeProjection(context);
  const after = foldAfterProjection(before, targetVenue);
  assertFold(
    after.primaryReceipt.expectedOccurrences.length === 7 &&
      after.primaryReceipt.satisfiedOccurrences.length === 7,
    "after_receipt_does_not_preserve_seven_rows",
  );
  return {
    kind: "reviewed_cross_post_schedule_duplicate_fold",
    key: `fold:${FOLD_SPEC.operationId}`,
    before,
    targetVenue,
    after,
    mutation: {
      functionName: API.fold,
      args: foldMutationArgs(before, targetVenue),
    },
  };
}

async function buildEventPlan(client, serviceSecret) {
  const configPlan = await buildConfigPlan(client, serviceSecret);
  const configStatus = await configPlanStatus(client, serviceSecret, configPlan);
  assert(
    configStatus.complete,
    "Config phase is not exact; event planning is refused.",
  );
  const venues = await loadVenues(client, serviceSecret);
  const byHandle = venuesByHandle(venues);
  const operations = [];
  for (const group of VENUE_REPAIR_GROUPS) {
    const venue = byHandle.get(group.venueHandle);
    assert(venue, `Venue repair target @${group.venueHandle} is missing.`);
    for (const id of group.ids) {
      operations.push(
        await buildVenueRepairOperation(
          client,
          serviceSecret,
          id,
          group,
          venue,
        ),
      );
    }
  }
  const repairReceiptIds = operations.map(
    (operation) => operation.before.receipt.id,
  );
  assert(
    new Set(repairReceiptIds).size === repairReceiptIds.length,
    "Reviewed repairs share a receipt; a grouped atomic repair is required.",
  );
  const foldTargetVenue = byHandle.get(FOLD_SPEC.expectedVenueHandle);
  assertFold(foldTargetVenue, "target_venue_missing");
  const foldContext = await loadFoldContext(client, serviceSecret);
  const foldOperation = buildFoldOperationFromContext(
    foldContext,
    venueProjection(foldTargetVenue),
  );
  assert(
    !repairReceiptIds.includes(
      foldOperation.before.primarySources[0].receipt.id,
    ),
    "The reviewed fold shares a receipt with a venue repair.",
  );
  operations.push(foldOperation);
  return {
    schemaVersion: EVENT_PLAN_SCHEMA,
    phase: "events",
    targetSetVersion: TARGET_SET_VERSION,
    targetSetSha256: eventTargetSetSha256(),
    plannedAt: new Date().toISOString(),
    operations,
  };
}

async function receiptMatches(client, serviceSecret, expected) {
  const receipt = await queryWithTransientRetry(client, API.receipt, {
    sourceIdentity: expected.sourceIdentity,
    serviceSecret,
  });
  return Boolean(receipt && exactJson(receiptProjection(receipt, false), expected));
}

async function venueRepairAfterMatches(client, serviceSecret, operation) {
  const events = await loadEventsByIds(
    client,
    serviceSecret,
    [operation.after.event.id],
    true,
  );
  const event = events.get(operation.after.event.id);
  return Boolean(
    event &&
      exactJson(eventPublicProjection(event), operation.after.event) &&
      markerMatches(event, operation.after.marker) &&
      (await receiptMatches(client, serviceSecret, operation.after.receipt)),
  );
}

async function foldAfterMatches(client, serviceSecret, operation) {
  const context = await loadFoldContext(client, serviceSecret);
  if (
    !context.primary ||
    !context.duplicate ||
    context.primarySources.length !== 1 ||
    !context.primarySources[0].receipt
  ) {
    return false;
  }
  const actualPrimarySource = sourceLinkProjection(
    context.primarySources[0].link,
  );
  const actualDuplicateSources = context.duplicateSources.map((source) =>
    sourceContextProjection(source),
  );
  const actualPrimarySaves = saveStateProjection(context.primarySaves);
  const actualDuplicateSaves = saveStateProjection(context.duplicateSaves);
  return Boolean(
    exactJson(eventPublicProjection(context.primary), operation.after.primary) &&
      exactJson(
        eventPublicProjection(context.duplicate),
        operation.after.duplicate,
      ) &&
      exactJson(actualPrimarySource, operation.after.primarySourceLink) &&
      exactJson(
        receiptProjection(context.primarySources[0].receipt, false),
        operation.after.primaryReceipt,
      ) &&
      exactJson(actualDuplicateSources, operation.after.duplicateSources) &&
      exactJson(actualPrimarySaves, operation.after.primarySaves) &&
      exactJson(actualDuplicateSaves, operation.after.duplicateSaves) &&
      markerMatches(context.primary, operation.after.primaryMarker) &&
      markerMatches(context.duplicate, operation.after.duplicateMarker) &&
      foldAuditsMatch(context, operation.after)
  );
}

function foldAuditMatches(rows, eventId, action, expectedMarker) {
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const row = rows[0];
  if (
    row.eventId !== eventId ||
    row.action !== action ||
    normalizeText(row.note) !== FOLD_SPEC.moderationNote
  ) {
    return false;
  }
  let patch;
  try {
    patch = JSON.parse(row.patchJson ?? "null");
  } catch {
    return false;
  }
  return Boolean(
    patch &&
      typeof patch === "object" &&
      !Array.isArray(patch) &&
      Object.entries(expectedMarker).every(([key, value]) =>
        key === "field" ? true : exactJson(patch[key], value),
      ),
  );
}

function foldAuditsMatch(context, after) {
  return (
    foldAuditMatches(
      context.primaryAudits,
      FOLD_SPEC.primaryId,
      after.audits.primaryAction,
      after.primaryMarker,
    ) &&
    foldAuditMatches(
      context.duplicateAudits,
      FOLD_SPEC.legacyId,
      after.audits.duplicateAction,
      after.duplicateMarker,
    )
  );
}

async function eventOperationAfterMatches(client, serviceSecret, operation) {
  if (operation.kind === "reviewed_venue_repair") {
    return venueRepairAfterMatches(client, serviceSecret, operation);
  }
  if (operation.kind === "reviewed_cross_post_schedule_duplicate_fold") {
    return foldAfterMatches(client, serviceSecret, operation);
  }
  throw new Error(`Unknown event operation kind ${operation.kind}.`);
}

async function assertEventOperationPreimage(client, serviceSecret, operation) {
  if (operation.kind === "reviewed_venue_repair") {
    const context = await correctionContext(
      client,
      serviceSecret,
      operation.before.event.id,
    );
    assert(
      exactJson(contextProjection(context), operation.before),
      `${operation.key} changed after plan review.`,
    );
    const venue = (await loadVenues(client, serviceSecret)).get(
      operation.targetVenue.id,
    );
    assert(
      venue && exactJson(venueProjection(venue), operation.targetVenue),
      `${operation.key} target venue revision changed after plan review.`,
    );
    return;
  }
  const context = await loadFoldContext(client, serviceSecret);
  const actualBefore = foldBeforeProjection(context);
  assertFold(
    exactJson(actualBefore, operation.before),
    "preimage_changed_after_review",
  );
  const venue = (await loadVenues(client, serviceSecret)).get(
    operation.targetVenue.id,
  );
  assertFold(
    venue && exactJson(venueProjection(venue), operation.targetVenue),
    "target_venue_changed_after_review",
  );
  assertFold(
    exactJson(
      foldMutationArgs(actualBefore, operation.targetVenue),
      operation.mutation.args,
    ),
    "mutation_args_changed_after_review",
  );
}

async function applyEventOperation(client, serviceSecret, operation) {
  if (await eventOperationAfterMatches(client, serviceSecret, operation)) {
    return { key: operation.key, result: "already_exact" };
  }
  await assertEventOperationPreimage(client, serviceSecret, operation);
  // Intentionally no mutation retry. Status reconciliation is the only safe
  // response to an uncertain acknowledgement.
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

function validateConfigOperation(operation, plan) {
  const spec = VENUE_SPECS.find(
    (row) => `venue:${row.handle}` === operation.key,
  );
  if (operation.kind === "venue_config") {
    assert(spec && operation.specHandle === spec.handle, "Config venue spec is invalid.");
    assert(
      operation.before.id === spec.id &&
        operation.before.instagramHandle === spec.handle,
      "Config venue identity changed.",
    );
    const expectedAfter = targetVenueProjection(
      {
        _id: operation.before.id,
        name: operation.before.name,
        aliases: operation.before.aliases,
        location: operation.before.location,
      },
      spec,
    );
    assert(exactJson(operation.after, expectedAfter), "Config venue target is invalid.");
    const expectedArgs = {
      id: operation.before.id,
      expectedUpdatedAt: operation.before.updatedAt,
      patch: {
        ...(!spec.preserveName ? { name: operation.after.name } : {}),
        aliases: operation.after.aliases,
        publicStatus: operation.after.publicStatus,
        scrapeActive: operation.after.scrapeActive,
      },
      auditNote:
        "Reviewed 2026-08-27 venue identity learning: preserve existing aliases, add reviewed aliases, and keep the canonical public ingestion venue active.",
    };
    assert(
      operation.mutation.functionName === API.venueUpdate &&
        exactJson(operation.mutation.args, expectedArgs),
      "Config venue mutation is invalid.",
    );
    return;
  }
  const sourceSpec = SOURCE_SPECS.find(
    (row) => `source:${row.handle}` === operation.key,
  );
  assert(
    sourceSpec && operation.specHandle === sourceSpec.handle,
    "Config source spec is invalid.",
  );
  assert(
    operation.before.handle === sourceSpec.handle &&
      operation.after.handle === sourceSpec.handle &&
      operation.after.role === sourceSpec.role &&
      operation.after.active === true,
    "Config source target is invalid.",
  );
  const venueOperation = sourceSpec.venueHandle
    ? plan.operations.find(
        (row) => row.key === `venue:${sourceSpec.venueHandle}`,
      )
    : null;
  const expectedVenueId = venueOperation?.after.id ?? null;
  assert(
    operation.after.venueId === expectedVenueId,
    "Config source venue target is invalid.",
  );
  const expectedArgs = {
    handle: sourceSpec.handle,
    role: sourceSpec.role,
    ...(expectedVenueId ? { venueId: expectedVenueId } : {}),
    expectedUpdatedAt: operation.before.updatedAt,
  };
  assert(
    operation.mutation.functionName === API.sourceRoleUpdate &&
      exactJson(operation.mutation.args, expectedArgs),
    "Config source mutation is invalid.",
  );
}

function validateVenueRepairOperation(operation, group, id) {
  assert(
    operation &&
      operation.kind === "reviewed_venue_repair" &&
      operation.key === `event-venue:${id}` &&
      operation.groupHandle === group.venueHandle,
    `Event repair ${id} identity is invalid.`,
  );
  assert(operation.before.event.id === id, `Event repair ${id} preimage is invalid.`);
  assert(
    operation.targetVenue.instagramHandle === group.venueHandle,
    `Event repair ${id} target handle is invalid.`,
  );
  const expectedAfter = {
    ...eventPublicProjectionFromPlan(operation.before.event),
    venue: operation.targetVenue.name,
    venueId: operation.targetVenue.id,
    venueInstagramHandle: group.venueHandle,
    moderationNote: VENUE_REPAIR_NOTE,
  };
  assert(
    exactJson(operation.after.event, expectedAfter),
    `Event repair ${id} after-state is invalid.`,
  );
  const expectedReceipt = bindReceiptVenueFromPlan(
    operation.before,
    operation.targetVenue.name,
  );
  assert(
    exactJson(operation.after.receipt, expectedReceipt),
    `Event repair ${id} receipt target is invalid.`,
  );
  const expectedMarker = {
    field: "reviewedVenueCorrection",
    policyVersion: 1,
    venue: operation.targetVenue.name,
    evidence: group.evidence,
  };
  assert(
    exactJson(operation.after.marker, expectedMarker),
    `Event repair ${id} marker is invalid.`,
  );
  const expectedAmbiguityIds = (group.expectedAmbiguousApprovedEvents ?? [])
    .map((row) => row.id)
    .sort();
  const ambiguousVersions =
    operation.mutation?.args?.expectedAmbiguousApprovedEventVersions;
  assert(
    Array.isArray(ambiguousVersions) &&
      ambiguousVersions.every(
        (row) =>
          row &&
          typeof row === "object" &&
          typeof row.id === "string" &&
          Number.isSafeInteger(row.updatedAt),
      ) &&
      exactJson(
        ambiguousVersions.map((row) => row.id).sort(),
        expectedAmbiguityIds,
      ),
    `Event repair ${id} reviewed ambiguity versions are invalid.`,
  );
  const expectedArgs = {
    id,
    expectedUpdatedAt: operation.before.event.updatedAt,
    expectedNormalizedFieldsJson: operation.before.event.normalizedFieldsJson,
    expectedSourceLinkId: operation.before.sourceLink.id,
    expectedSourceLinkUpdatedAt: operation.before.sourceLink.updatedAt,
    expectedReceiptId: operation.before.receipt.id,
    expectedReceiptUpdatedAt: operation.before.receipt.updatedAt,
    nextVenue: operation.targetVenue.name,
    targetVenueId: operation.targetVenue.id,
    expectedTargetVenueUpdatedAt: operation.targetVenue.updatedAt,
    expectedTargetVenueHandle: group.venueHandle,
    venueEvidence: group.evidence,
    moderationNote: VENUE_REPAIR_NOTE,
    expectedAmbiguousApprovedEventVersions: ambiguousVersions,
  };
  assert(
    operation.mutation.functionName === API.venueRepair &&
      exactJson(operation.mutation.args, expectedArgs),
    `Event repair ${id} mutation is invalid.`,
  );
}

function eventPublicProjectionFromPlan(event) {
  const copy = { ...event };
  delete copy.updatedAt;
  delete copy.normalizedFieldsJson;
  delete copy.normalizedFieldsSha256;
  delete copy.rawExtractionSha256;
  return copy;
}

function bindReceiptVenueFromPlan(before, nextVenue) {
  const key = before.sourceLink.sourceOccurrenceKey;
  const expectedMatches = before.receipt.expectedOccurrences.filter(
    (row) => row.key === key,
  );
  const satisfiedMatches = before.receipt.satisfiedOccurrences.filter(
    (row) => row.key === key && row.eventId === before.event.id,
  );
  assert(
    expectedMatches.length === 1 && satisfiedMatches.length === 1,
    `Plan receipt ${before.receipt.id} is not exact.`,
  );
  const result = { ...before.receipt };
  delete result.updatedAt;
  result.expectedOccurrences = before.receipt.expectedOccurrences.map((row) =>
    row.key === key ? { ...row, venue: nextVenue } : row,
  );
  result.satisfiedOccurrences = before.receipt.satisfiedOccurrences.map((row) => ({
    ...row,
  }));
  return result;
}

function validatePlanShape(plan, phase) {
  assert(plan.targetSetVersion === TARGET_SET_VERSION, "Plan target set is stale.");
  assert(
    Array.isArray(plan.operations) && plan.operations.length > 0,
    "Plan has no operations.",
  );
  const keys = plan.operations.map((operation) => operation.key);
  assert(new Set(keys).size === keys.length, "Plan operation keys are not unique.");
  if (phase === "config") {
    assert(
      plan.targetSetSha256 === configTargetSetSha256(),
      "Config target-set digest is stale.",
    );
    const expectedKeys = [
      ...VENUE_SPECS.map((spec) => `venue:${spec.handle}`),
      ...SOURCE_SPECS.map((spec) => `source:${spec.handle}`),
    ];
    assert(
      exactJson([...keys].sort(), [...expectedKeys].sort()),
      "Config operation set is invalid.",
    );
    for (const operation of plan.operations) {
      validateConfigOperation(operation, plan);
    }
    return;
  }
  assert(
    plan.targetSetSha256 === eventTargetSetSha256(),
    "Event target-set digest is stale.",
  );
  const expectedRepairKeys = VENUE_REPAIR_GROUPS.flatMap((group) =>
    group.ids.map((id) => `event-venue:${id}`),
  );
  const expectedFoldKey = `fold:${FOLD_SPEC.operationId}`;
  assert(
    exactJson([...keys].sort(), [...expectedRepairKeys, expectedFoldKey].sort()),
    "Event operation set is invalid.",
  );
  for (const group of VENUE_REPAIR_GROUPS) {
    for (const id of group.ids) {
      validateVenueRepairOperation(
        plan.operations.find((row) => row.key === `event-venue:${id}`),
        group,
        id,
      );
    }
  }
  const fold = plan.operations.find((row) => row.key === expectedFoldKey);
  assert(
    fold &&
      fold.kind === "reviewed_cross_post_schedule_duplicate_fold" &&
      fold.mutation?.functionName === API.fold,
    "Reviewed fold operation is invalid.",
  );
  assert(
    fold.before.primary.id === FOLD_SPEC.primaryId &&
      fold.before.duplicate.id === FOLD_SPEC.legacyId &&
      fold.before.primary.status === "approved" &&
      fold.before.duplicate.status === "approved" &&
      fold.before.primarySources.length === 1 &&
      fold.before.duplicateSources.length === 0 &&
      fold.targetVenue.id === "k172xcmnd3qw4jqgcswwwrykw5896new" &&
      fold.targetVenue.instagramHandle === FOLD_SPEC.expectedVenueHandle &&
      fold.targetVenue.name === FOLD_SPEC.nextVenue,
    "Reviewed fold targets are invalid.",
  );
  assert(
    exactJson(
      fold.after,
      foldAfterProjection(fold.before, fold.targetVenue),
    ),
    "Reviewed fold after-state is invalid.",
  );
  assert(
    exactJson(
      fold.mutation.args,
      foldMutationArgs(fold.before, fold.targetVenue),
    ),
    "Reviewed fold mutation arguments are invalid.",
  );
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

  if (options.mode === "dry-run") {
    const plan =
      options.phase === "config"
        ? await buildConfigPlan(client, serviceSecret)
        : await buildEventPlan(client, serviceSecret);
    emit(planEnvelope(plan));
    return;
  }

  const envelope = loadPlanFile(
    options.planFile,
    options.expectedPlanSha256,
    options.phase,
  );
  validatePlanShape(envelope.plan, options.phase);

  if (options.mode === "status") {
    const status =
      options.phase === "config"
        ? await configPlanStatus(client, serviceSecret, envelope.plan)
        : await eventPlanStatus(client, serviceSecret, envelope.plan);
    const currentConfig =
      options.phase === "events"
        ? await buildConfigPlan(client, serviceSecret)
        : null;
    const config = currentConfig
      ? await configPlanStatus(client, serviceSecret, currentConfig)
      : null;
    const complete = status.complete && (!config || config.complete);
    emit({
      schemaVersion: RESULT_SCHEMA,
      phase: options.phase,
      mode: "status",
      planSha256: envelope.planSha256,
      productionMutations: 0,
      complete,
      operations: status.operations,
      ...(config ? { config } : {}),
    });
    if (!complete) process.exitCode = 2;
    return;
  }

  const results = [];
  if (options.phase === "config") {
    for (const operation of envelope.plan.operations) {
      results.push(await applyConfigOperation(client, serviceSecret, operation));
    }
    const verification = await configPlanStatus(
      client,
      serviceSecret,
      envelope.plan,
    );
    assert(verification.complete, "Config phase failed final verification.");
    emit({
      schemaVersion: RESULT_SCHEMA,
      phase: "config",
      mode: "apply",
      planSha256: envelope.planSha256,
      status: "complete",
      productionMutations: results.filter((row) => row.result === "applied").length,
      results,
      verification,
    });
    return;
  }

  const preApplyConfigPlan = await buildConfigPlan(client, serviceSecret);
  const preApplyConfigStatus = await configPlanStatus(
    client,
    serviceSecret,
    preApplyConfigPlan,
  );
  assert(
    preApplyConfigStatus.complete,
    "Venue/source configuration changed after event plan review.",
  );
  for (const operation of envelope.plan.operations) {
    results.push(await applyEventOperation(client, serviceSecret, operation));
  }
  const eventsVerification = await eventPlanStatus(
    client,
    serviceSecret,
    envelope.plan,
  );
  const finalConfigPlan = await buildConfigPlan(client, serviceSecret);
  const finalConfigVerification = await configPlanStatus(
    client,
    serviceSecret,
    finalConfigPlan,
  );
  assert(eventsVerification.complete, "Event phase failed final verification.");
  assert(
    finalConfigVerification.complete,
    "Venue/source configuration failed final verification.",
  );
  emit({
    schemaVersion: RESULT_SCHEMA,
    phase: "events",
    mode: "apply",
    planSha256: envelope.planSha256,
    status: "complete",
    productionMutations: results.filter((row) => row.result === "applied").length,
    results,
    verification: {
      events: eventsVerification,
      config: finalConfigVerification,
    },
  });
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      code: "E_REVIEWED_VENUE_DEDUPE_OPERATOR",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
