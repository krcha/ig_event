import assert from "node:assert/strict";
import {
  extractEventDataFromInstagramPost,
  isOpenAiPermanentError,
  OPENAI_REQUEST_TIMEOUT_MS,
  parseExtractedEventData,
} from "../lib/ai/extract-event-data.ts";
import { TBD_EVENT_TIME } from "../lib/events/event-time.ts";
import { venueValueAppearsInEventEvidence } from "../lib/events/unnamed-schedule-fallback.ts";
import {
  buildNightlifeLineupCoalescingPlan,
  explicitlyStatesAfterMidnightTakeover,
  titleContainsOnlyBilledArtists,
} from "../lib/events/nightlife-lineup-coalescing.ts";
import {
  eventArtistHandleAliasMatches,
  eventEvidenceConflictIsBenign,
} from "../lib/events/event-evidence-conflict-policy.ts";
import {
  assertServiceUpdateEventPolicy,
  hasEventEvidenceV2AutoApproval,
} from "../lib/events/event-update-precondition.ts";
import {
  classifyExistingApprovedOccurrenceForTesting,
  normalizeEventDate,
  prepareEventsForInsert,
  resolveInstagramSourceExtractionContextForTesting,
} from "../lib/pipeline/run-instagram-ingestion.ts";

function confirmation(evidence, source = "caption") {
  const exactEvidence = String(evidence ?? "").trim();
  return {
    confidence: exactEvidence ? 0.99 : 0,
    found_in: exactEvidence ? [source] : [],
    evidence: exactEvidence,
    evidence_snippets: exactEvidence ? [{ source, text: exactEvidence }] : [],
    notes: exactEvidence ? "Exact QA fixture evidence." : "No fixture evidence.",
  };
}

const validExtraction = {
  extraction_contract_version: "event_evidence_v2",
  is_event: true,
  non_event_reason: "",
  title: "QA Night",
  date: "12.08.2026",
  time: "",
  venue: "QA Club",
  city: "Belgrade",
  country: "Serbia",
  price: "",
  currency: "",
  artists: ["QA Artist"],
  category: "nightlife",
  description: "QA Artist performs.",
  confidence: 0.99,
  reasoning_notes: "Exact caption evidence.",
  source_caption: "QA Night with QA Artist tomorrow at QA Club; doors open 20:00.",
  source_url: "https://www.instagram.com/p/qa-event-evidence-v2/",
  date_evidence: {
    exact_text: "tomorrow",
    source: "caption",
    is_relative: true,
    resolved_date: "2026-08-12",
  },
  time_evidence: {
    status: "doors_open_only",
    exact_text: "doors open 20:00",
    source: "caption",
  },
  source_conflicts: [
    {
      field: "venue",
      poster_value: "Poster Club",
      caption_value: "QA Club",
      reason: "The poster and caption name different venues.",
    },
  ],
  shared_schedule_context: {
    venue: {
      applies_to_all: true,
      value: "QA Club",
      evidence: "all shows at QA Club",
      source: "caption",
    },
    time: {
      applies_to_all: false,
      value: "",
      evidence: "",
      source: "unknown",
    },
  },
  schedule_entries: [
    {
      date: "12.08.2026",
      time: "",
      venue: "QA Club",
      title: "QA Night",
      artists: ["QA Artist"],
      description: "QA Artist performs.",
      source_text: "tomorrow — QA Night — QA Artist — all shows at QA Club",
      date_evidence: {
        exact_text: "tomorrow",
        source: "caption",
        is_relative: true,
        resolved_date: "2026-08-12",
      },
      time_evidence: {
        status: "not_stated",
        exact_text: "",
        source: "unknown",
      },
    },
  ],
  field_confirmation: {
    title: confirmation("QA Night"),
    location: confirmation("Belgrade"),
    location_name: confirmation("QA Club"),
    price: confirmation(""),
    start_time: confirmation("doors open 20:00"),
    short_description: confirmation("QA Artist performs"),
    artists: confirmation("QA Artist"),
  },
};

assert.equal(
  OPENAI_REQUEST_TIMEOUT_MS,
  120_000,
  "GPT-5 mini extraction must retain a bounded timeout above the observed 40-second production latency",
);

const cachedMissingTimePayload = {
  ...structuredClone(validExtraction),
  time_evidence: {
    status: "not_stated",
    exact_text: "",
    source: "caption",
  },
  schedule_entries: validExtraction.schedule_entries.map((entry) => ({
    ...structuredClone(entry),
    time: "",
    time_evidence: {
      status: "not_stated",
      exact_text: "",
      source: "caption",
    },
  })),
};
const cachedMissingTimeJson = JSON.stringify(cachedMissingTimePayload);
const parsedMissingTimeEvidence = parseExtractedEventData(
  JSON.parse(cachedMissingTimeJson),
);
assert.equal(
  JSON.stringify(parsedMissingTimeEvidence),
  cachedMissingTimeJson,
  "Parsing an older missing-time cache must preserve its attested JSON bytes",
);

const semanticQaNow = new Date();

function isoDateDaysFromNow(offsetDays) {
  const date = new Date(semanticQaNow);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function addIsoDays(isoDate, offsetDays) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function ddmmyyyy(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year}`;
}

const SERBIAN_GENITIVE_MONTHS = [
  "januara",
  "februara",
  "marta",
  "aprila",
  "maja",
  "juna",
  "jula",
  "avgusta",
  "septembra",
  "oktobra",
  "novembra",
  "decembra",
];

function makeFutureCrossMonthRange() {
  const dayMs = 24 * 60 * 60 * 1000;
  let monthOffset = 2;
  let boundary = new Date(Date.UTC(
    semanticQaNow.getUTCFullYear(),
    semanticQaNow.getUTCMonth() + monthOffset,
    1,
  ));
  while (boundary.getUTCMonth() === 0) {
    monthOffset += 1;
    boundary = new Date(Date.UTC(
      semanticQaNow.getUTCFullYear(),
      semanticQaNow.getUTCMonth() + monthOffset,
      1,
    ));
  }
  const start = new Date(boundary.getTime() - 6 * dayMs);
  const end = new Date(start.getTime() + 17 * dayMs);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const startMonth = SERBIAN_GENITIVE_MONTHS[start.getUTCMonth()];
  const endMonth = SERBIAN_GENITIVE_MONTHS[end.getUTCMonth()];
  return {
    startDate,
    endDate,
    postedAt: new Date(start.getTime() - 2 * dayMs).toISOString(),
    text: `od ${start.getUTCDate()}. ${startMonth} do ${end.getUTCDate()}. ${endMonth} ${end.getUTCFullYear()}.`,
  };
}

function emptySharedScheduleContext() {
  return {
    venue: {
      applies_to_all: false,
      value: "",
      evidence: "",
      source: "unknown",
    },
    time: {
      applies_to_all: false,
      value: "",
      evidence: "",
      source: "unknown",
    },
  };
}

function makePost({ caption, postId, postedAt, username = "qa_semantic_venue", ...overrides }) {
  return {
    postId,
    caption,
    altText: null,
    imageUrl: null,
    imageUrls: [],
    postType: "image",
    locationName: null,
    instagramPostUrl: `https://www.instagram.com/p/${postId}/`,
    postedAt: postedAt ?? semanticQaNow.toISOString(),
    username,
    ...overrides,
  };
}

function makeEventExtraction({
  caption,
  date,
  dateEvidenceText,
  postUrl,
  artists = [],
  artistEvidenceSource = "caption",
  artistEvidenceText = artists.join(", "),
  field_confirmation: fieldConfirmation,
  time = "",
  timeEvidence = {
    status: time ? "start_time_stated" : "not_stated",
    exact_text: time,
    source: time ? "caption" : "unknown",
  },
  title = "QA Semantic Night",
  titleEvidenceSource = "caption",
  titleEvidenceText = title,
  venue = "QA Semantic Venue",
  ...overrides
}) {
  const fixtureFieldConfirmation = fieldConfirmation ?? {
    ...structuredClone(validExtraction.field_confirmation),
    title: confirmation(titleEvidenceText, titleEvidenceSource),
    location: confirmation(venue, "caption"),
    location_name: confirmation(venue, "caption"),
    artists: confirmation(artistEvidenceText, artistEvidenceSource),
  };
  return parseExtractedEventData({
    ...structuredClone(validExtraction),
    title,
    date,
    time,
    venue,
    artists,
    description: `${title} event.`,
    source_caption: caption,
    source_url: postUrl,
    date_evidence: {
      exact_text: dateEvidenceText,
      source: "caption",
      is_relative: false,
      resolved_date: date,
    },
    time_evidence: timeEvidence,
    source_conflicts: [],
    shared_schedule_context: emptySharedScheduleContext(),
    schedule_entries: [],
    field_confirmation: fixtureFieldConfirmation,
    ...overrides,
  });
}

function makeNonEventExtraction({ caption, postUrl, reason }) {
  return parseExtractedEventData({
    ...structuredClone(validExtraction),
    is_event: false,
    non_event_reason: reason,
    title: "",
    date: "",
    time: "",
    venue: "",
    city: "",
    country: "",
    price: "",
    currency: "",
    artists: [],
    category: "",
    description: "",
    confidence: 0.05,
    reasoning_notes: reason,
    source_caption: caption,
    source_url: postUrl,
    date_evidence: {
      exact_text: "",
      source: "unknown",
      is_relative: false,
      resolved_date: "",
    },
    time_evidence: {
      status: "not_stated",
      exact_text: "",
      source: "unknown",
    },
    source_conflicts: [],
    shared_schedule_context: emptySharedScheduleContext(),
    schedule_entries: [],
    field_confirmation: {
      title: confirmation(""),
      location: confirmation(""),
      location_name: confirmation(""),
      price: confirmation(""),
      start_time: confirmation(""),
      short_description: confirmation(""),
      artists: confirmation(""),
    },
  });
}

function prepare(post, extracted, options = {}) {
  return prepareEventsForInsert(
    post,
    extracted,
    options.selectedImageUrl ?? null,
    options.canonicalVenueNamesByHandle ?? {},
    {},
    options.configuredVenueNamesByHandle ?? {},
    {
      eventDateFilterNow: semanticQaNow,
      sourceRolesByHandle: options.sourceRolesByHandle ?? {},
    },
  );
}

function assertSingleOk(results, label) {
  assert.equal(results.length, 1, `${label}: expected one normalized result.`);
  assert.equal(results[0]?.kind, "ok", `${label}: expected an event result.`);
  return results[0];
}

const observedUnknownSourceContext =
  resolveInstagramSourceExtractionContextForTesting({
    sourceHandle: "_azbuka",
    configuredVenueNamesByHandle: {},
    sourceDisplayNamesByHandle: { _azbuka: "Azbuka / Restaurant & Bar" },
    sourceRolesByHandle: { _azbuka: "unknown" },
  });
assert.deepEqual(observedUnknownSourceContext, {
  canonicalVenueName: null,
  instagramSourceName: "Azbuka / Restaurant & Bar",
  sourceRole: "unknown",
});

const unconfiguredVenueRoleSourceContext =
  resolveInstagramSourceExtractionContextForTesting({
    sourceHandle: "vera.belgrade",
    configuredVenueNamesByHandle: {},
    sourceDisplayNamesByHandle: { "vera.belgrade": "Vera Belgrade" },
    sourceRolesByHandle: { "vera.belgrade": "venue" },
  });
assert.deepEqual(unconfiguredVenueRoleSourceContext, {
  canonicalVenueName: null,
  instagramSourceName: "Vera Belgrade",
  sourceRole: "venue",
});

const observedPromoterSourceContext =
  resolveInstagramSourceExtractionContextForTesting({
    sourceHandle: "infuse.rs",
    configuredVenueNamesByHandle: {},
    sourceDisplayNamesByHandle: { "infuse.rs": "INFUSE" },
    sourceRolesByHandle: { "infuse.rs": "promoter" },
  });
assert.deepEqual(observedPromoterSourceContext, {
  canonicalVenueName: null,
  instagramSourceName: "INFUSE",
  sourceRole: "promoter",
});

const configuredVenueSourceContext =
  resolveInstagramSourceExtractionContextForTesting({
    sourceHandle: "_azbuka",
    configuredVenueNamesByHandle: { _azbuka: "Azbuka" },
    sourceDisplayNamesByHandle: { _azbuka: "Azbuka / Restaurant & Bar" },
    sourceRolesByHandle: { _azbuka: "venue" },
  });
assert.deepEqual(configuredVenueSourceContext, {
  canonicalVenueName: "Azbuka",
  instagramSourceName: "Azbuka",
  sourceRole: "venue",
});

function runSemanticNormalizationQa() {
  const failures = [];
  const runCase = (name, callback) => {
    try {
      callback();
    } catch (error) {
      failures.push(new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  runCase("explicit event", () => {
    const date = isoDateDaysFromNow(8);
    const dateText = ddmmyyyy(date);
    const post = makePost({
      caption: `QA Semantic Night ${dateText} at QA Semantic Venue with QA Artist.`,
      postId: "qa-explicit-event",
    });
    const extracted = makeEventExtraction({
      artists: ["QA Artist"],
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
    });
    const prepared = assertSingleOk(prepare(post, extracted), "explicit event");
    assert.equal(prepared.event.status, "approved");
    assert.deepEqual(prepared.event.artists, ["QA Artist"]);
    assert.equal(prepared.normalizedFields.dateEvidenceVerified, true);
    assert.equal(prepared.normalizedFields.identityEvidenceVerified, true);
    assert.equal(prepared.normalizedFields.moderationAutoApproveRule, "event_evidence_v2");
  });

  for (const fixture of [
    {
      name: "closure",
      caption: "Closed for collective vacation until September.",
      reason: "closure notice",
    },
    {
      name: "recap",
      caption: "Last weekend was unforgettable — here are the photos.",
      reason: "past event recap",
    },
    {
      name: "menu",
      caption: "New summer menu: coffee, lemonade, and sandwiches.",
      reason: "ordinary menu offer",
    },
    {
      name: "giveaway",
      caption: "Giveaway: follow us and tag a friend to win dinner.",
      reason: "giveaway rather than an event",
    },
    {
      name: "unclear",
      caption: "Something exciting is coming soon.",
      reason: "insufficient event evidence",
    },
  ]) {
    runCase(`non-event ${fixture.name}`, () => {
      const post = makePost({
        caption: fixture.caption,
        postId: `qa-non-event-${fixture.name}`,
      });
      const extracted = makeNonEventExtraction({
        caption: post.caption,
        postUrl: post.instagramPostUrl,
        reason: fixture.reason,
      });
      const results = prepare(post, extracted);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.kind, "skip");
      assert.equal(results[0]?.reason, "not_event");
      assert.equal(results[0]?.normalizedFields.extractionNonEventReason, fixture.reason);
      assert.equal(results[0]?.normalizedFields.moderationAutoApproved, false);
    });
  }

  runCase("event reason invariant", () => {
    assert.throws(
      () =>
        parseExtractedEventData({
          ...structuredClone(validExtraction),
          is_event: true,
          non_event_reason: "must not be present",
        }),
      /leave non_event_reason empty/i,
    );
  });

  runCase("date agreement", () => {
    const date = isoDateDaysFromNow(10);
    const dateText = ddmmyyyy(date);
    const post = makePost({
      caption: `QA Date Agreement ${dateText} at QA Semantic Venue.`,
      postId: "qa-date-agreement",
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "QA Date Agreement",
    });
    const prepared = assertSingleOk(prepare(post, extracted), "date agreement");
    assert.equal(prepared.event.date, date);
    assert.equal(prepared.event.status, "approved");
    assert.equal(prepared.normalizedFields.dateEvidenceVerified, true);
  });

  runCase("flexible numeric and compact Serbian month date evidence", () => {
    assert.equal(
      normalizeEventDate("22. 8. 2026.", null, "2026-08-20T12:00:00.000Z").isoDate,
      "2026-08-22",
    );
    assert.equal(
      normalizeEventDate("25.08.", null, "2026-08-22T12:00:00.000Z").isoDate,
      "2026-08-25",
    );
    assert.equal(
      normalizeEventDate("25.AVGUST", null, "2026-08-22T12:00:00.000Z").isoDate,
      "2026-08-25",
    );
    const bareCaptionDate = normalizeEventDate(
      "12.07.2026",
      "Event announcement\n11.7.\n20h",
      "2026-07-07T16:37:24.000Z",
    );
    assert.equal(
      bareCaptionDate.isoDate,
      "2026-07-11",
      "A following time line must not be consumed as the year of a bare caption date.",
    );
    assert.equal(bareCaptionDate.rawDateText, "11.7");
    assert.equal(
      normalizeEventDate("31. 02. 2026.", null, "2026-02-20T12:00:00.000Z").isoDate,
      null,
      "Flexible punctuation must not make an impossible calendar date valid.",
    );

    const date = isoDateDaysFromNow(11);
    const [year, month, day] = date.split("-").map(Number);
    const dateText = `${day}. ${month}. ${year}.`;
    const post = makePost({
      caption: `QA Flexible Numeric Night ${dateText} at QA Semantic Venue.`,
      postId: "qa-flexible-numeric-date",
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "QA Flexible Numeric Night",
    });
    const prepared = assertSingleOk(prepare(post, extracted), "flexible numeric date");
    assert.equal(prepared.event.status, "approved");
    assert.equal(prepared.normalizedFields.dateEvidenceVerified, true);
  });

  runCase("explicit weekday and numeric date correct a stale relative flag", () => {
    const date = isoDateDaysFromNow(13);
    const weekday = [
      "Nedelja",
      "Ponedeljak",
      "Utorak",
      "Sreda",
      "Četvrtak",
      "Petak",
      "Subota",
    ][new Date(`${date}T12:00:00.000Z`).getUTCDay()];
    const [, month, day] = date.split("-").map(Number);
    const dateText = `${weekday}, ${day}.${month}.`;
    const post = makePost({
      caption: `QA Explicit Weekday Night — ${dateText} at QA Semantic Venue.`,
      postId: "qa-explicit-weekday-stale-relative",
      postedAt: `${addIsoDays(date, -3)}T12:00:00.000Z`,
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "QA Explicit Weekday Night",
      date_evidence: {
        exact_text: dateText,
        source: "caption",
        is_relative: true,
        resolved_date: date,
      },
    });
    const prepared = assertSingleOk(
      prepare(post, extracted),
      "explicit weekday stale relative flag",
    );
    assert.equal(prepared.event.status, "approved");
    assert.equal(prepared.event.dateEvidenceIsRelative, false);
    assert.equal(prepared.normalizedFields.dateEvidenceVerified, true);
  });

  runCase("cross-month range gets occurrence-specific normalized evidence", () => {
    const range = makeFutureCrossMonthRange();
    const post = makePost({
      caption: `QA Cross Month Exhibition ${range.text} at QA Semantic Venue.`,
      postId: "qa-cross-month-range",
      postedAt: range.postedAt,
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date: range.text,
      dateEvidenceText: range.text,
      postUrl: post.instagramPostUrl,
      title: "QA Cross Month Exhibition",
      date_evidence: {
        exact_text: range.text,
        source: "caption",
        // Deliberately reproduce the stale cached shape: one resolution and
        // a relative flag are reused for a fully explicit daily range.
        is_relative: true,
        resolved_date: range.startDate,
      },
    });
    const results = prepare(post, extracted);
    assert.equal(results.length, 18);
    assert.equal(results[0]?.kind, "ok");
    assert.equal(results.at(-1)?.kind, "ok");
    assert.equal(results[0]?.event.date, range.startDate);
    assert.equal(results.at(-1)?.event.date, range.endDate);
    for (const result of results) {
      assert.equal(result.kind, "ok");
      assert.equal(result.event.status, "approved");
      assert.equal(result.event.dateEvidenceIsRelative, false);
      assert.equal(result.event.dateEvidenceResolvedDate, result.event.date);
      assert.equal(result.normalizedFields.dateEvidenceVerified, true);
      const rawExtraction = JSON.parse(result.event.rawExtractionJson);
      assert.equal(
        rawExtraction.date_evidence.resolved_date,
        range.startDate,
        "Occurrence normalization must not rewrite the immutable raw extraction.",
      );
      assert.equal(rawExtraction.date_evidence.is_relative, true);
    }
  });

  runCase("range evidence cannot attest an outside occurrence", () => {
    const range = makeFutureCrossMonthRange();
    const outsideDate = addIsoDays(range.endDate, 1);
    const post = makePost({
      caption: `QA Outside Range Night ${range.text} at QA Semantic Venue.`,
      postId: "qa-outside-explicit-range",
      postedAt: `${outsideDate}T12:00:00.000Z`,
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date: "",
      dateEvidenceText: "",
      postUrl: post.instagramPostUrl,
      title: "QA Outside Range Night",
      date_evidence: {
        exact_text: "",
        source: "unknown",
        is_relative: false,
        resolved_date: "",
      },
      schedule_entries: [
        {
          date: outsideDate,
          time: "",
          venue: "QA Semantic Venue",
          title: "QA Outside Range Night",
          artists: [],
          description: "QA Outside Range Night event.",
          source_text: `QA Outside Range Night ${range.text} at QA Semantic Venue.`,
          date_evidence: {
            exact_text: range.text,
            source: "caption",
            is_relative: false,
            resolved_date: outsideDate,
          },
          time_evidence: {
            status: "not_stated",
            exact_text: "",
            source: "unknown",
          },
        },
      ],
    });
    const prepared = assertSingleOk(prepare(post, extracted), "outside range evidence");
    assert.equal(prepared.event.date, outsideDate);
    assert.equal(prepared.event.status, "pending");
    assert.equal(prepared.normalizedFields.dateEvidenceVerified, false);
    assert.ok(prepared.normalizedFields.moderationPendingReasons.includes("invalid_date_evidence"));
  });

  runCase("relative-only evidence keeps strict relative semantics", () => {
    const postedDate = isoDateDaysFromNow(14);
    const date = addIsoDays(postedDate, 1);
    const post = makePost({
      caption: "Tomorrow: QA Strict Relative Night at QA Semantic Venue.",
      postId: "qa-strict-relative-flag",
      postedAt: `${postedDate}T12:00:00.000Z`,
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date,
      dateEvidenceText: "Tomorrow",
      postUrl: post.instagramPostUrl,
      title: "QA Strict Relative Night",
      date_evidence: {
        exact_text: "Tomorrow",
        source: "caption",
        is_relative: false,
        resolved_date: date,
      },
    });
    const prepared = assertSingleOk(prepare(post, extracted), "strict relative flag");
    assert.equal(prepared.event.status, "pending");
    assert.equal(prepared.normalizedFields.dateEvidenceVerified, false);
  });

  runCase("relative date", () => {
    const date = isoDateDaysFromNow(12);
    const postedDate = addIsoDays(date, -1);
    const post = makePost({
      caption: "Tomorrow: QA Relative Night at QA Semantic Venue.",
      postId: "qa-relative-date",
      postedAt: `${postedDate}T12:00:00.000Z`,
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date: "tomorrow",
      dateEvidenceText: "Tomorrow",
      postUrl: post.instagramPostUrl,
      title: "QA Relative Night",
      date_evidence: {
        exact_text: "Tomorrow",
        source: "caption",
        is_relative: true,
        resolved_date: date,
      },
    });
    const prepared = assertSingleOk(prepare(post, extracted), "relative date");
    assert.equal(prepared.event.date, date);
    assert.equal(prepared.event.status, "approved");
    assert.equal(prepared.normalizedFields.dateEvidenceIsRelative, true);
    assert.equal(prepared.normalizedFields.dateEvidenceVerified, true);
  });

  runCase("misresolved relative date stays pending", () => {
    const postedDate = isoDateDaysFromNow(12);
    const correctTomorrow = addIsoDays(postedDate, 1);
    const incorrectLaterDate = addIsoDays(postedDate, 4);
    const post = makePost({
      caption: "Tomorrow: QA Misresolved Night at QA Semantic Venue.",
      postId: "qa-misresolved-relative-date",
      postedAt: `${postedDate}T12:00:00.000Z`,
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date: incorrectLaterDate,
      dateEvidenceText: "Tomorrow",
      postUrl: post.instagramPostUrl,
      title: "QA Misresolved Night",
      date_evidence: {
        exact_text: "Tomorrow",
        source: "caption",
        is_relative: true,
        resolved_date: incorrectLaterDate,
      },
    });
    const prepared = assertSingleOk(
      prepare(post, extracted),
      "misresolved relative date",
    );
    assert.notEqual(incorrectLaterDate, correctTomorrow);
    assert.equal(
      prepared.event.status,
      "pending",
      "A model-provided resolution must not override the date implied by persisted relative text.",
    );
    assert.equal(prepared.normalizedFields.dateEvidenceVerified, false);
    assert.ok(
      prepared.normalizedFields.moderationPendingReasons.includes("invalid_date_evidence"),
    );
    assert.ok(
      !prepared.normalizedFields.moderationPendingReasons.includes("invalid_identity_evidence"),
      "The adversarial relative-date case must fail only its date attestation.",
    );
  });

  runCase("poster-caption date conflict", () => {
    const captionDate = isoDateDaysFromNow(14);
    const posterDate = isoDateDaysFromNow(15);
    const captionDateText = ddmmyyyy(captionDate);
    const posterDateText = ddmmyyyy(posterDate);
    const post = makePost({
      caption: `QA Conflict Night ${captionDateText} at QA Semantic Venue.`,
      postId: "qa-date-conflict",
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date: captionDate,
      dateEvidenceText: captionDateText,
      postUrl: post.instagramPostUrl,
      title: "QA Conflict Night",
      source_conflicts: [
        {
          field: "date",
          poster_value: posterDateText,
          caption_value: captionDateText,
          reason: "Poster and caption dates disagree.",
        },
      ],
    });
    const prepared = assertSingleOk(
      prepare(post, extracted, { selectedImageUrl: "https://cdn.example.com/qa-conflict.jpg" }),
      "date conflict",
    );
    assert.equal(prepared.event.status, "pending");
    assert.deepEqual(prepared.event.sourceConflictFields, ["date"]);
    assert.ok(prepared.normalizedFields.moderationPendingReasons.includes("poster_caption_conflict"));
    assert.ok(
      !prepared.normalizedFields.moderationPendingReasons.includes("invalid_identity_evidence"),
      "The conflict case must retain valid title identity evidence.",
    );
  });

  runCase("generic today plus matching named Saturday is benign", () => {
    const saturday = new Date(semanticQaNow);
    const daysUntilSaturday = (6 - saturday.getUTCDay() + 7) % 7 || 7;
    saturday.setUTCDate(saturday.getUTCDate() + daysUntilSaturday);
    const eventDate = saturday.toISOString().slice(0, 10);
    const postedDate = addIsoDays(eventDate, -1);
    const post = makePost({
      caption:
        "Today, the guests are arriving. Dođite ove subote na ACID HOUSE at QA Semantic Venue.",
      postId: "qa-benign-today-saturday",
      postedAt: `${postedDate}T16:00:00.000Z`,
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date: eventDate,
      dateEvidenceText: "SUBOTA",
      postUrl: post.instagramPostUrl,
      title: "ACID HOUSE",
      titleEvidenceSource: "poster",
      date_evidence: {
        exact_text: "SUBOTA",
        source: "poster",
        is_relative: true,
        resolved_date: eventDate,
      },
      source_conflicts: [
        {
          field: "date",
          poster_value: "Saturday",
          caption_value: "Today",
          reason: "Poster says Saturday while the caption opens with Today.",
        },
      ],
    });
    const prepared = assertSingleOk(
      prepare(post, extracted, { selectedImageUrl: "https://cdn.example.com/acid-house.jpg" }),
      "benign today/Saturday wording",
    );
    assert.equal(prepared.event.date, eventDate);
    assert.equal(prepared.event.status, "approved");
    assert.deepEqual(prepared.event.sourceConflictFields, []);
    assert.equal(prepared.normalizedFields.extractionSourceConflictCount, 1);
    assert.equal(prepared.normalizedFields.materialSourceConflictCount, 0);
    assert.equal(prepared.normalizedFields.benignSourceConflictCount, 1);
    assert.equal(
      hasEventEvidenceV2AutoApproval(prepared.event.normalizedFieldsJson, prepared.event),
      true,
    );

    const tampered = JSON.parse(prepared.event.normalizedFieldsJson);
    tampered.benignSourceConflictCount = 0;
    assert.equal(
      hasEventEvidenceV2AutoApproval(JSON.stringify(tampered), prepared.event),
      false,
      "A benign-conflict partition with tampered counts must fail closed.",
    );

    const forgedConflict = {
      field: "date",
      poster_value: "Sunday",
      caption_value: "Today",
      reason: "Poster and caption identify different dates.",
    };
    const forgedFields = JSON.parse(prepared.event.normalizedFieldsJson);
    forgedFields.extractionSourceConflicts = [forgedConflict];
    forgedFields.extractionSourceConflictCount = 1;
    forgedFields.materialSourceConflicts = [];
    forgedFields.materialSourceConflictCount = 0;
    forgedFields.benignSourceConflicts = [forgedConflict];
    forgedFields.benignSourceConflictCount = 1;
    const forgedRaw = JSON.parse(prepared.event.rawExtractionJson);
    forgedRaw.source_conflicts = [forgedConflict];
    assert.equal(
      hasEventEvidenceV2AutoApproval(JSON.stringify(forgedFields), {
        ...prepared.event,
        rawExtractionJson: JSON.stringify(forgedRaw),
      }),
      false,
      "A material conflict cannot pass by moving it into a count-consistent benign bucket.",
    );
  });

  runCase("today-only caption agrees with a Saturday poster on the posting day", () => {
    const saturday = new Date(semanticQaNow);
    const daysUntilSaturday = (6 - saturday.getUTCDay() + 7) % 7 || 7;
    saturday.setUTCDate(saturday.getUTCDate() + daysUntilSaturday);
    const eventDate = saturday.toISOString().slice(0, 10);
    const post = makePost({
      caption: "Today: ACID HOUSE at QA Semantic Venue.",
      postId: "qa-benign-today-only-saturday",
      postedAt: `${eventDate}T08:00:00.000Z`,
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date: eventDate,
      dateEvidenceText: "SUBOTA",
      postUrl: post.instagramPostUrl,
      title: "ACID HOUSE",
      titleEvidenceSource: "poster",
      date_evidence: {
        exact_text: "SUBOTA",
        source: "poster",
        is_relative: true,
        resolved_date: eventDate,
      },
      source_conflicts: [
        {
          field: "date",
          poster_value: "Saturday",
          caption_value: "Today",
          reason: "Poster says Saturday while the caption says Today.",
        },
      ],
    });
    const prepared = assertSingleOk(
      prepare(post, extracted, {
        selectedImageUrl: "https://cdn.example.com/acid-house-today.jpg",
      }),
      "today-only caption on Saturday",
    );
    assert.equal(prepared.event.date, eventDate);
    assert.equal(prepared.event.status, "approved");
    assert.deepEqual(prepared.event.sourceConflictFields, []);

    const postedDayBefore = assertSingleOk(
      prepare(
        { ...post, postedAt: `${addIsoDays(eventDate, -1)}T08:00:00.000Z` },
        extracted,
        {
          selectedImageUrl: "https://cdn.example.com/acid-house-today.jpg",
        },
      ),
      "today-only caption before Saturday",
    );
    assert.equal(postedDayBefore.event.status, "pending");
    assert.deepEqual(postedDayBefore.event.sourceConflictFields, ["date"]);
  });

  runCase("minor title wording is benign but a different title is material", () => {
    const date = isoDateDaysFromNow(15);
    const dateText = ddmmyyyy(date);
    const post = makePost({
      caption: `Predstava nema ime ${dateText} at QA Semantic Venue.`,
      postId: "qa-benign-title-wording",
    });
    const base = makeEventExtraction({
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "PREDSTAVA KOJA NEMA IME",
      titleEvidenceSource: "poster",
      source_conflicts: [
        {
          field: "title",
          poster_value: "PREDSTAVA KOJA NEMA IME",
          caption_value: "Predstava nema ime",
          reason: "Caption omits one connector word.",
        },
      ],
    });
    const prepared = assertSingleOk(
      prepare(post, base, { selectedImageUrl: "https://cdn.example.com/predstava.jpg" }),
      "minor title wording",
    );
    assert.equal(prepared.event.status, "approved");
    assert.deepEqual(prepared.event.sourceConflictFields, []);

    const material = parseExtractedEventData({
      ...structuredClone(base),
      source_conflicts: [
        {
          field: "title",
          poster_value: "PREDSTAVA KOJA NEMA IME",
          caption_value: "Potpuno druga predstava",
          reason: "Poster and caption name different plays.",
        },
      ],
    });
    const materialPrepared = assertSingleOk(
      prepare(post, material, { selectedImageUrl: "https://cdn.example.com/predstava.jpg" }),
      "different title wording",
    );
    assert.equal(materialPrepared.event.status, "pending");
    assert.deepEqual(materialPrepared.event.sourceConflictFields, ["title"]);

    const reordered = parseExtractedEventData({
      ...structuredClone(base),
      source_conflicts: [
        {
          field: "title",
          poster_value: "Predstava koja nema ime",
          caption_value: "Predstava ime nema",
          reason: "The same words appear in a different identity order.",
        },
      ],
    });
    const reorderedPrepared = assertSingleOk(
      prepare(post, reordered, { selectedImageUrl: "https://cdn.example.com/predstava.jpg" }),
      "reordered title wording",
    );
    assert.equal(reorderedPrepared.event.status, "pending");
    assert.deepEqual(reorderedPrepared.event.sourceConflictFields, ["title"]);
  });

  runCase("artist display name and billed Instagram handle collapse to the handle", () => {
    const date = isoDateDaysFromNow(16);
    const dateText = ddmmyyyy(date);
    const post = makePost({
      caption: `ESPRESSO MATINÉE ${dateText} at QA Semantic Venue. @ne_nije`,
      postId: "qa-benign-artist-handle",
    });
    const extracted = makeEventExtraction({
      artists: ["NENI", "@ne_nije"],
      artistEvidenceText: "@ne_nije",
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "ESPRESSO MATINÉE",
      source_conflicts: [
        {
          field: "artists",
          poster_value: "NENI",
          caption_value: "@ne_nije",
          reason: "Poster uses a display name and caption uses the billed handle.",
        },
      ],
    });
    const prepared = assertSingleOk(
      prepare(post, extracted, { selectedImageUrl: "https://cdn.example.com/espresso.jpg" }),
      "artist handle alias",
    );
    assert.deepEqual(prepared.event.artists, ["@ne_nije"]);
    assert.equal(prepared.event.status, "approved");
    assert.deepEqual(prepared.event.sourceConflictFields, []);
    assert.equal(eventArtistHandleAliasMatches("NENI", "@ne_nije"), true);
    assert.equal(eventArtistHandleAliasMatches("NENI", "@nenika"), false);
    assert.equal(eventArtistHandleAliasMatches("ABBA", "@abbath"), false);
    assert.equal(eventArtistHandleAliasMatches("Nina", "@ninari"), false);

    const handleOnly = parseExtractedEventData({
      ...structuredClone(extracted),
      artists: ["@ne_nije"],
      source_conflicts: [],
    });
    const handleOnlyPrepared = assertSingleOk(
      prepare(post, handleOnly, {
        selectedImageUrl: "https://cdn.example.com/espresso.jpg",
      }),
      "single billed artist handle",
    );
    assert.deepEqual(
      handleOnlyPrepared.event.artists,
      ["@ne_nije"],
      "A provider-compliant lone billed handle must remain byte-for-byte recognizable.",
    );
    assert.equal(handleOnlyPrepared.event.status, "approved");

    const unrelated = parseExtractedEventData({
      ...structuredClone(extracted),
      artists: ["NENI", "@other_artist"],
      field_confirmation: {
        ...structuredClone(extracted.field_confirmation),
        artists: confirmation("@other_artist"),
      },
      source_conflicts: [
        {
          field: "artists",
          poster_value: "NENI",
          caption_value: "@other_artist",
          reason: "Poster and caption bill different artists.",
        },
      ],
    });
    const unrelatedPrepared = assertSingleOk(
      prepare(
        { ...post, caption: post.caption.replace("@ne_nije", "@other_artist") },
        unrelated,
        { selectedImageUrl: "https://cdn.example.com/espresso.jpg" },
      ),
      "unrelated artist handle",
    );
    assert.equal(unrelatedPrepared.event.status, "pending");
    assert.deepEqual(unrelatedPrepared.event.sourceConflictFields, ["artists"]);

    const nearPrefixAlias = parseExtractedEventData({
      ...structuredClone(extracted),
      artists: ["NENI", "@nenika"],
      field_confirmation: {
        ...structuredClone(extracted.field_confirmation),
        artists: confirmation("@nenika"),
      },
      source_conflicts: [
        {
          field: "artists",
          poster_value: "NENI",
          caption_value: "@nenika",
          reason: "Poster uses a display name and caption uses the billed handle.",
        },
      ],
    });
    const nearPrefixAliasPrepared = assertSingleOk(
      prepare(
        { ...post, caption: post.caption.replace("@ne_nije", "@nenika") },
        nearPrefixAlias,
        { selectedImageUrl: "https://cdn.example.com/espresso.jpg" },
      ),
      "near-prefix artist handle",
    );
    assert.equal(nearPrefixAliasPrepared.event.status, "pending");
    assert.deepEqual(nearPrefixAliasPrepared.event.sourceConflictFields, ["artists"]);

    const unsupportedAlias = parseExtractedEventData({
      ...structuredClone(extracted),
      source_conflicts: [
        {
          field: "artists",
          poster_value: "NENI",
          caption_value: "@ne_nije",
          reason: "Poster and caption bill different artists.",
        },
      ],
    });
    const unsupportedAliasPrepared = assertSingleOk(
      prepare(post, unsupportedAlias, {
        selectedImageUrl: "https://cdn.example.com/espresso.jpg",
      }),
      "unsupported artist prefix",
    );
    assert.equal(unsupportedAliasPrepared.event.status, "pending");
    assert.deepEqual(unsupportedAliasPrepared.event.sourceConflictFields, ["artists"]);
  });

  runCase("confirmed caption lineup supports inflected names and billed handles", () => {
    const date = isoDateDaysFromNow(17);
    const dateText = ddmmyyyy(date);
    const post = makePost({
      caption: [
        `QA Lineup Night ${dateText} at QA Semantic Venue.`,
        "Lenhart Tapes sa Skreč majstor Ljubanom i Zoja Borovčanin.",
        "@nikola_banovicc – bubnjevi",
      ].join("\n"),
      postId: "qa-confirmed-caption-lineup",
    });
    const artists = [
      "Lenhart Tapes",
      "Skreč majstor Ljuban",
      "Zoja Borovčanin",
      "Nikola Banović",
    ];
    const extracted = makeEventExtraction({
      artists,
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "QA Lineup Night",
      field_confirmation: {
        ...structuredClone(validExtraction.field_confirmation),
        title: confirmation("QA Lineup Night"),
        location: confirmation("QA Semantic Venue"),
        location_name: confirmation("QA Semantic Venue"),
        artists: {
          confidence: 0.95,
          found_in: ["caption"],
          evidence: "Lenhart Tapes; Skreč majstor Ljuban; Zoja Borovčanin; @nikola_banovicc",
          evidence_snippets: [{ source: "caption", text: "Lenhart Tapes" }],
          notes: "All selected artists are billed in the caption.",
        },
      },
    });
    const prepared = assertSingleOk(prepare(post, extracted), "confirmed caption lineup");
    assert.equal(prepared.event.status, "approved");
    assert.equal(prepared.normalizedFields.identityEvidenceVerified, true);

    const unsupported = parseExtractedEventData({
      ...structuredClone(extracted),
      artists: [...artists, "Invented Artist"],
    });
    const unsupportedPrepared = assertSingleOk(
      prepare(post, unsupported),
      "unsupported caption artist",
    );
    assert.equal(unsupportedPrepared.event.status, "pending");
    assert.equal(unsupportedPrepared.normalizedFields.identityEvidenceVerified, false);
  });

  runCase("a split schedule row cannot borrow another row's artist", () => {
    const firstDate = isoDateDaysFromNow(20);
    const secondDate = isoDateDaysFromNow(21);
    const firstDateText = ddmmyyyy(firstDate);
    const secondDateText = ddmmyyyy(secondDate);
    const firstSourceLine = `${firstDateText} | Event One at QA Semantic Venue`;
    const secondSourceLine =
      `${secondDateText} | Event Two with Artist Two at QA Semantic Venue`;
    const caption = [firstSourceLine, secondSourceLine].join("\n");
    const post = makePost({
      caption,
      postId: "qa-cross-row-artist-isolation",
    });
    const scheduleEntry = ({ date, dateText, title, artists, sourceText }) => ({
      date,
      time: "",
      venue: "QA Semantic Venue",
      title,
      artists,
      description: "",
      source_text: sourceText,
      date_evidence: {
        exact_text: dateText,
        source: "caption",
        is_relative: false,
        resolved_date: date,
      },
      time_evidence: {
        status: "not_stated",
        exact_text: "",
        source: "unknown",
      },
    });
    const extracted = makeEventExtraction({
      artists: [],
      caption,
      date: "",
      dateEvidenceText: "",
      postUrl: post.instagramPostUrl,
      title: "",
      date_evidence: {
        exact_text: "",
        source: "unknown",
        is_relative: false,
        resolved_date: "",
      },
      schedule_entries: [
        scheduleEntry({
          date: firstDate,
          dateText: firstDateText,
          title: "Event One",
          // Deliberately reproduce a model row-association mistake: Artist Two
          // appears only in the other row of the persisted caption.
          artists: ["Artist Two"],
          sourceText: firstSourceLine,
        }),
        scheduleEntry({
          date: secondDate,
          dateText: secondDateText,
          title: "Event Two",
          artists: ["Artist Two"],
          sourceText: secondSourceLine,
        }),
      ],
      field_confirmation: {
        ...structuredClone(validExtraction.field_confirmation),
        title: confirmation("Event One"),
        location: confirmation("QA Semantic Venue"),
        location_name: confirmation("QA Semantic Venue"),
        artists: confirmation("Artist Two"),
      },
    });
    const results = prepare(post, extracted);
    const first = results.find(
      (result) => result.kind === "ok" && result.event.date === firstDate,
    );
    const second = results.find(
      (result) => result.kind === "ok" && result.event.date === secondDate,
    );
    assert.equal(first?.kind, "ok");
    assert.equal(first.event.status, "pending");
    assert.equal(first.normalizedFields.identityEvidenceVerified, false);
    assert.ok(
      first.normalizedFields.moderationPendingReasons.includes("invalid_identity_evidence"),
    );
    assert.equal(second?.kind, "ok");
    assert.equal(second.event.status, "approved");
    assert.equal(second.normalizedFields.identityEvidenceVerified, true);
  });

  runCase("a single-occurrence schedule may bind identity from the same saved post", () => {
    const date = isoDateDaysFromNow(19);
    const dateText = ddmmyyyy(date);
    const sourceLine = `${dateText} | 20h at QA Semantic Venue`;
    const caption = ["Solo Program", "Featuring Solo Artist", sourceLine].join("\n");
    const post = makePost({
      caption,
      postId: "qa-single-occurrence-separated-identity",
    });
    const extracted = makeEventExtraction({
      artists: ["Solo Artist"],
      caption,
      date: "",
      dateEvidenceText: "",
      postUrl: post.instagramPostUrl,
      title: "",
      date_evidence: {
        exact_text: "",
        source: "unknown",
        is_relative: false,
        resolved_date: "",
      },
      schedule_entries: [
        {
          date,
          time: "20:00",
          venue: "QA Semantic Venue",
          title: "Solo Program",
          artists: ["Solo Artist"],
          description: "Solo Artist performs Solo Program.",
          source_text: sourceLine,
          date_evidence: {
            exact_text: dateText,
            source: "caption",
            is_relative: false,
            resolved_date: date,
          },
          time_evidence: {
            status: "start_time_stated",
            exact_text: "20h",
            source: "caption",
          },
        },
      ],
      field_confirmation: {
        ...structuredClone(validExtraction.field_confirmation),
        title: confirmation("Solo Program"),
        location: confirmation("QA Semantic Venue"),
        location_name: confirmation("QA Semantic Venue"),
        artists: confirmation("Solo Artist"),
      },
    });
    const prepared = assertSingleOk(
      prepare(post, extracted),
      "single occurrence separated identity",
    );
    assert.equal(prepared.event.status, "approved");
    assert.equal(prepared.normalizedFields.identityEvidenceVerified, true);
  });

  runCase("repeated model identities cannot substitute for row-bound shared evidence", () => {
    const firstDate = isoDateDaysFromNow(20);
    const secondDate = isoDateDaysFromNow(21);
    const firstDateText = ddmmyyyy(firstDate);
    const secondDateText = ddmmyyyy(secondDate);
    const sharedDateText = `${firstDateText} and ${secondDateText}`;
    const firstSourceLine = `${firstDateText}—Copied Program at QA Semantic Venue`;
    const secondSourceLine = `${secondDateText}—Other Program at QA Semantic Venue`;
    const caption = [firstSourceLine, secondSourceLine, sharedDateText].join("|");
    const post = makePost({ caption, postId: "qa-repeated-model-identity-isolation" });
    const scheduleEntry = (date, dateText, sourceText) => ({
      date,
      time: "20:00",
      venue: "QA Semantic Venue",
      title: "Copied Program",
      artists: [],
      description: "Copied Program.",
      source_text: sourceText,
      date_evidence: {
        exact_text: dateText,
        source: "caption",
        is_relative: false,
        resolved_date: date,
      },
      time_evidence: {
        status: "start_time_stated",
        exact_text: "20h",
        source: "caption",
      },
    });
    const extracted = makeEventExtraction({
      artists: [],
      caption,
      date: "",
      dateEvidenceText: "",
      postUrl: post.instagramPostUrl,
      title: "Copied Program",
      date_evidence: {
        exact_text: sharedDateText,
        source: "caption",
        is_relative: false,
        resolved_date: "",
      },
      schedule_entries: [
        scheduleEntry(firstDate, firstDateText, firstSourceLine),
        scheduleEntry(secondDate, secondDateText, secondSourceLine),
      ],
      field_confirmation: {
        ...structuredClone(validExtraction.field_confirmation),
        title: confirmation("Copied Program"),
        location: confirmation("QA Semantic Venue"),
        location_name: confirmation("QA Semantic Venue"),
        artists: confirmation(""),
      },
    });
    const prepared = prepare(post, extracted).filter((result) => result.kind === "ok");
    assert.equal(prepared.length, 2);
    assert.equal(prepared[1].event.status, "pending");
    assert.equal(prepared[1].normalizedFields.identityEvidenceVerified, false);
  });

  runCase("a dropped invalid schedule row does not create single-occurrence identity", () => {
    const validDate = isoDateDaysFromNow(24);
    const validDateText = ddmmyyyy(validDate);
    const validSourceLine = `${validDateText} | 20h at QA Semantic Venue`;
    const invalidSourceLine = "TBA | another schedule row";
    const caption = ["Global Program", validSourceLine, invalidSourceLine].join("\n");
    const post = makePost({ caption, postId: "qa-dropped-row-not-single-occurrence" });
    const extracted = makeEventExtraction({
      artists: [],
      caption,
      date: "",
      dateEvidenceText: "",
      postUrl: post.instagramPostUrl,
      title: "Global Program",
      date_evidence: {
        exact_text: "",
        source: "unknown",
        is_relative: false,
        resolved_date: "",
      },
      schedule_entries: [
        {
          date: validDate,
          time: "20:00",
          venue: "QA Semantic Venue",
          title: "Global Program",
          artists: [],
          description: "Global Program.",
          source_text: validSourceLine,
          date_evidence: {
            exact_text: validDateText,
            source: "caption",
            is_relative: false,
            resolved_date: validDate,
          },
          time_evidence: {
            status: "start_time_stated",
            exact_text: "20h",
            source: "caption",
          },
        },
        {
          date: "not-a-date",
          time: "",
          venue: "QA Semantic Venue",
          title: "Other Program",
          artists: [],
          description: "Other Program.",
          source_text: invalidSourceLine,
          date_evidence: {
            exact_text: "TBA",
            source: "caption",
            is_relative: false,
            resolved_date: "",
          },
          time_evidence: {
            status: "not_stated",
            exact_text: "",
            source: "unknown",
          },
        },
      ],
      field_confirmation: {
        ...structuredClone(validExtraction.field_confirmation),
        title: confirmation("Global Program"),
        location: confirmation("QA Semantic Venue"),
        location_name: confirmation("QA Semantic Venue"),
        artists: confirmation(""),
      },
    });
    const valid = prepare(post, extracted).find(
      (result) => result.kind === "ok" && result.event.date === validDate,
    );
    assert.equal(valid?.kind, "ok");
    assert.equal(valid.event.status, "pending");
    assert.equal(valid.normalizedFields.identityEvidenceVerified, false);
  });

  runCase("a repeated identical event may bind one post-level identity to every date row", () => {
    const firstDate = isoDateDaysFromNow(22);
    const secondDate = isoDateDaysFromNow(23);
    const firstDateText = ddmmyyyy(firstDate);
    const secondDateText = ddmmyyyy(secondDate);
    const sharedDateText = `${firstDateText} and ${secondDateText}`;
    const caption = [
      "Repeated Theatre Program this weekend",
      `${sharedDateText} at QA Semantic Venue`,
    ].join("\n");
    const post = makePost({
      caption,
      postId: "qa-repeated-identical-schedule-identity",
    });
    const scheduleEntry = (date, dateText) => ({
      date,
      time: "",
      venue: "QA Semantic Venue",
      title: "Repeated Theatre Program",
      artists: [],
      description: "Repeated Theatre Program.",
      source_text: `${dateText} at QA Semantic Venue`,
      date_evidence: {
        exact_text: dateText,
        source: "caption",
        is_relative: false,
        resolved_date: date,
      },
      time_evidence: {
        status: "not_stated",
        exact_text: "",
        source: "unknown",
      },
    });
    const extracted = makeEventExtraction({
      artists: [],
      caption,
      date: "",
      dateEvidenceText: "",
      postUrl: post.instagramPostUrl,
      title: "Repeated Theatre Program",
      date_evidence: {
        exact_text: sharedDateText,
        source: "caption",
        is_relative: false,
        resolved_date: "",
      },
      schedule_entries: [
        scheduleEntry(firstDate, firstDateText),
        scheduleEntry(secondDate, secondDateText),
      ],
      field_confirmation: {
        ...structuredClone(validExtraction.field_confirmation),
        title: confirmation("Repeated Theatre Program"),
        location: confirmation("QA Semantic Venue"),
        location_name: confirmation("QA Semantic Venue"),
        artists: confirmation(""),
      },
    });
    const prepared = prepare(post, extracted).filter((result) => result.kind === "ok");
    assert.equal(prepared.length, 2);
    assert.ok(
      prepared.every((result) => result.event.status === "approved"),
      JSON.stringify(
        prepared.map((result) => ({
          status: result.event.status,
          reasons: result.normalizedFields.moderationPendingReasons,
          identityEvidenceVerified: result.normalizedFields.identityEvidenceVerified,
        })),
      ),
    );
    assert.ok(
      prepared.every((result) => result.normalizedFields.identityEvidenceVerified === true),
    );
  });

  runCase("fresh source-bound unnamed rows may use only the deterministic fallback title", () => {
    const date = isoDateDaysFromNow(18);
    const dateText = ddmmyyyy(date);
    const sourceLine = `${dateText} — BIGZ 011 — Bulevar Vojvode Mišića 17 — od 19h`;
    const post = makePost({
      caption: "QA Matinee guide.",
      postId: "qa-grounded-unnamed-schedule",
      username: "qa_matinee_guide",
    });
    const extracted = makeEventExtraction({
      artists: [],
      caption: post.caption,
      date: "",
      dateEvidenceText: "",
      postUrl: post.instagramPostUrl,
      title: "",
      venue: "",
      date_evidence: {
        exact_text: "",
        source: "unknown",
        is_relative: false,
        resolved_date: "",
      },
      schedule_entries: [
        {
          date,
          time: "19:00",
          venue: "BIGZ 011",
          title: "",
          artists: [],
          description: "Matinee at BIGZ 011.",
          source_text: sourceLine,
          date_evidence: {
            exact_text: dateText,
            source: "poster",
            is_relative: false,
            resolved_date: date,
          },
          time_evidence: {
            status: "start_time_stated",
            exact_text: "od 19h",
            source: "poster",
          },
        },
      ],
      field_confirmation: {
        ...structuredClone(validExtraction.field_confirmation),
        title: confirmation(""),
        location: confirmation(""),
        location_name: confirmation(""),
        artists: confirmation(""),
      },
    });
    const prepared = assertSingleOk(
      prepare(post, extracted, {
        selectedImageUrl: "https://cdn.example.com/matinee-guide.jpg",
        canonicalVenueNamesByHandle: { qa_matinee_guide: "QA Matinee Guide" },
        configuredVenueNamesByHandle: { qa_matinee_guide: "QA Matinee Guide" },
        sourceRolesByHandle: { qa_matinee_guide: "unknown" },
      }),
      "grounded unnamed schedule",
    );
    assert.equal(prepared.event.status, "approved");
    assert.equal(prepared.normalizedFields.titleUsedFallback, true);
    assert.equal(prepared.normalizedFields.fallbackIdentityPolicyVersion, 1);
    assert.equal(
      hasEventEvidenceV2AutoApproval(prepared.event.normalizedFieldsJson, prepared.event),
      true,
    );

    const forgedTitleFields = JSON.parse(prepared.event.normalizedFieldsJson);
    forgedTitleFields.title = "Forged Headliner";
    assert.equal(
      hasEventEvidenceV2AutoApproval(JSON.stringify(forgedTitleFields), {
        ...prepared.event,
        title: "Forged Headliner",
      }),
      false,
      "A blank raw row cannot attest an arbitrary normalized/public title.",
    );

    const forgedFields = JSON.parse(prepared.event.normalizedFieldsJson);
    forgedFields.splitSourceLine = `${dateText} — 19h`;
    forgedFields.rowSourceText = forgedFields.splitSourceLine;
    assert.equal(
      hasEventEvidenceV2AutoApproval(JSON.stringify(forgedFields), prepared.event),
      false,
      "A fallback title cannot be approved after detaching it from the raw schedule row.",
    );

    const ungrounded = parseExtractedEventData({
      ...structuredClone(extracted),
      schedule_entries: [
        {
          ...structuredClone(extracted.schedule_entries[0]),
          venue: "",
          source_text: `${dateText} — 19h`,
        },
      ],
    });
    const ungroundedPrepared = assertSingleOk(
      prepare(
        { ...post, postId: "qa-ungrounded-unnamed-schedule" },
        ungrounded,
        { selectedImageUrl: "https://cdn.example.com/ungrounded-schedule.jpg" },
      ),
      "ungrounded unnamed schedule",
    );
    assert.equal(ungroundedPrepared.event.status, "pending");
    assert.equal(ungroundedPrepared.normalizedFields.identityEvidenceVerified, false);

    const genericVenueExtraction = parseExtractedEventData({
      ...structuredClone(extracted),
      schedule_entries: [
        {
          ...structuredClone(extracted.schedule_entries[0]),
          venue: "club",
          source_text: `${dateText} — club — od 19h`,
        },
      ],
    });
    const genericVenuePrepared = assertSingleOk(
      prepare(
        { ...post, postId: "qa-generic-venue-unnamed-schedule" },
        genericVenueExtraction,
        { selectedImageUrl: "https://cdn.example.com/generic-venue-schedule.jpg" },
      ),
      "generic venue unnamed schedule",
    );
    assert.equal(genericVenuePrepared.event.status, "pending");
    assert.equal(genericVenuePrepared.normalizedFields.identityEvidenceVerified, false);

    const inflectedSourceLine = `${dateText} — u Zvezdi — od 19h`;
    const inflectedExtraction = parseExtractedEventData({
      ...structuredClone(extracted),
      schedule_entries: [
        {
          ...structuredClone(extracted.schedule_entries[0]),
          venue: "Zvezda",
          source_text: inflectedSourceLine,
        },
      ],
    });
    const inflectedPrepared = assertSingleOk(
      prepare(
        { ...post, postId: "qa-inflected-unnamed-schedule" },
        inflectedExtraction,
        { selectedImageUrl: "https://cdn.example.com/inflected-schedule.jpg" },
      ),
      "Serbian-inflected unnamed schedule venue",
    );
    assert.equal(inflectedPrepared.event.venue, "Zvezda");
    assert.equal(inflectedPrepared.event.status, "approved");
    assert.equal(
      hasEventEvidenceV2AutoApproval(
        inflectedPrepared.event.normalizedFieldsJson,
        inflectedPrepared.event,
      ),
      true,
      "Convex authorization must use the same Serbian venue inflection policy as local ingestion.",
    );

    const nearPrefixFields = JSON.parse(inflectedPrepared.event.normalizedFieldsJson);
    nearPrefixFields.splitSourceLine = `${dateText} — u Zvezdari — od 19h`;
    nearPrefixFields.rowSourceText = nearPrefixFields.splitSourceLine;
    const nearPrefixRaw = JSON.parse(inflectedPrepared.event.rawExtractionJson);
    nearPrefixRaw.schedule_entries[0].source_text = nearPrefixFields.splitSourceLine;
    assert.equal(
      hasEventEvidenceV2AutoApproval(JSON.stringify(nearPrefixFields), {
        ...inflectedPrepared.event,
        rawExtractionJson: JSON.stringify(nearPrefixRaw),
      }),
      false,
      "A nearby physical venue name must not satisfy the fallback attestation.",
    );
  });

  runCase("generic Today cannot borrow a date from a multi-event caption", () => {
    const saturdayDate = new Date(semanticQaNow);
    saturdayDate.setUTCDate(
      saturdayDate.getUTCDate() + ((6 - saturdayDate.getUTCDay() + 7) % 7 || 7),
    );
    const saturday = saturdayDate.toISOString().slice(0, 10);
    const conflict = {
      field: "date",
      poster_value: "Saturday",
      caption_value: "Today",
      reason: "Poster indicates Saturday while caption says Today.",
    };
    const saturdayWeekday = new Date(`${saturday}T12:00:00.000Z`).toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "UTC",
    });
    assert.equal(
      eventEvidenceConflictIsBenign(conflict, {
        artists: [],
        dateEvidenceVerified: true,
        resolvedDate: saturday,
        selectedTitle: "First Event",
        selectedVenue: "QA Hall",
        singleOccurrenceSource: false,
        sourceAccountName: "QA Hall",
        sourceAccountRole: "venue",
        sourceCaption: `Today: First Event. ${saturdayWeekday}: Unrelated Second Event.`,
        venueEvidenceVerified: true,
      }),
      false,
    );
  });

  runCase("matching numeric date overrides a wrong poster weekday", () => {
    const context = {
      artists: [],
      dateEvidenceVerified: true,
      resolvedDate: "2026-08-26",
      selectedTitle: "NIGHT OLIVER DRAGOJEVIĆ",
      selectedVenue: "Shootiranje",
      singleOccurrenceSource: true,
      sourceAccountName: "Shootiranje",
      sourceAccountRole: "venue",
      sourceCaption: "Sreda 26.08. NIGHT OLIVER DRAGOJEVIĆ od 19:30",
      venueEvidenceVerified: true,
    };
    assert.equal(
      eventEvidenceConflictIsBenign(
        {
          field: "date",
          poster_value: "THURSDAY 26. AUGUST",
          caption_value: "Sreda 26.08.",
          reason: "Weekday words disagree.",
        },
        context,
      ),
      true,
      "The shared numeric date is authoritative over a poster weekday typo.",
    );
    assert.equal(
      eventEvidenceConflictIsBenign(
        {
          field: "date",
          poster_value: "THURSDAY 27. AUGUST",
          caption_value: "Sreda 26.08.",
          reason: "Numeric dates disagree.",
        },
        context,
      ),
      false,
      "Different numeric dates must remain a material conflict.",
    );
  });

  runCase("promoter account cannot override a caption-grounded physical venue", () => {
    const date = isoDateDaysFromNow(17);
    const dateText = ddmmyyyy(date);
    const username = "longplayofficial";
    const venue = "Botanička bašta Jevremovac";
    const venueEvidence = "Botaničkoj bašti “Jevremovac”";
    const post = makePost({
      caption: `Del Arno Band ${dateText} u ${venueEvidence}.`,
      postId: "qa-promoter-physical-venue",
      username,
    });
    const extracted = makeEventExtraction({
      artists: ["Del Arno Band"],
      artistEvidenceText: "Del Arno Band",
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      field_confirmation: {
        ...structuredClone(validExtraction.field_confirmation),
        title: confirmation("Del Arno Band"),
        location: confirmation(venueEvidence),
        location_name: confirmation(venueEvidence),
        artists: confirmation("Del Arno Band"),
      },
      postUrl: post.instagramPostUrl,
      title: "Del Arno Band",
      venue,
      source_conflicts: [
        {
          field: "venue",
          poster_value: "Long Play",
          caption_value: venue,
          reason: "Long Play is the canonical account hint; caption names the venue.",
        },
      ],
    });
    const prepared = assertSingleOk(
      prepare(post, extracted, {
        selectedImageUrl: "https://cdn.example.com/del-arno.jpg",
        canonicalVenueNamesByHandle: { [username]: "Long Play" },
        configuredVenueNamesByHandle: { [username]: "Long Play" },
        sourceRolesByHandle: { [username]: "promoter" },
      }),
      "promoter physical venue",
    );
    assert.equal(prepared.event.venue, venue);
    assert.equal(prepared.normalizedFields.venueEvidenceVerified, true);
    assert.equal(prepared.normalizedFields.trustedVenueSource, false);
    assert.equal(prepared.event.status, "approved");
    assert.deepEqual(prepared.event.sourceConflictFields, []);
  });

  runCase("poster-caption start-time conflict", () => {
    const date = isoDateDaysFromNow(15);
    const dateText = ddmmyyyy(date);
    const post = makePost({
      caption: `QA Time Conflict ${dateText} starts at 21:00 at QA Semantic Venue.`,
      postId: "qa-time-conflict",
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "QA Time Conflict",
      time: "21:00",
      timeEvidence: {
        status: "start_time_stated",
        exact_text: "starts at 21:00",
        source: "caption",
      },
      source_conflicts: [
        {
          field: "time",
          poster_value: "22:00",
          caption_value: "21:00",
          reason: "Poster and caption start times disagree.",
        },
      ],
    });
    const prepared = assertSingleOk(
      prepare(post, extracted, { selectedImageUrl: "https://cdn.example.com/time-conflict.jpg" }),
      "time conflict",
    );
    assert.equal(prepared.event.status, "pending");
    assert.deepEqual(prepared.event.sourceConflictFields, ["time"]);
    assert.ok(prepared.normalizedFields.moderationPendingReasons.includes("poster_caption_conflict"));
  });

  runCase("unsupported venue is cleared instead of invented", () => {
    const date = isoDateDaysFromNow(16);
    const dateText = ddmmyyyy(date);
    const post = makePost({
      caption: `QA Venue Truth ${dateText}.`,
      postId: "qa-unsupported-venue",
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "QA Venue Truth",
      venue: "Invented Hall",
    });
    const prepared = assertSingleOk(prepare(post, extracted), "unsupported venue");
    assert.equal(prepared.event.status, "approved");
    assert.equal(prepared.event.venue, "");
    assert.equal(prepared.normalizedFields.normalizedVenue, "");
    assert.equal(prepared.normalizedFields.venueSource, "unsupported_model_venue_cleared");
  });

  runCase("missing time remains publishable", () => {
    const date = isoDateDaysFromNow(16);
    const dateText = ddmmyyyy(date);
    const post = makePost({
      caption: `QA Time TBD ${dateText} at QA Semantic Venue.`,
      postId: "qa-missing-time",
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "QA Time TBD",
      timeEvidence: {
        status: "not_stated",
        exact_text: "",
        source: "caption",
      },
    });
    const prepared = assertSingleOk(prepare(post, extracted), "missing time");
    assert.equal(prepared.event.status, "approved");
    assert.equal(prepared.event.time, TBD_EVENT_TIME);
    assert.equal(prepared.event.timeSource, "unknown");
    assert.equal(prepared.event.timeStatus, "unknown");
    assert.equal(prepared.event.timeEvidenceKind, "not_stated");
    assert.equal(prepared.event.rawExtractionJson, JSON.stringify(extracted));
  });

  runCase("configured venue context fills missing extracted venue", () => {
    const date = isoDateDaysFromNow(18);
    const dateText = ddmmyyyy(date);
    const username = "qa_context_venue";
    const post = makePost({
      caption: `QA Context Night ${dateText}.`,
      postId: "qa-configured-missing-venue",
      username,
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "QA Context Night",
      venue: "",
    });
    const prepared = assertSingleOk(
      prepare(post, extracted, {
        canonicalVenueNamesByHandle: { [username]: "QA Context Venue" },
        configuredVenueNamesByHandle: { [username]: "QA Context Venue" },
        sourceRolesByHandle: { [username]: "venue" },
      }),
      "configured missing venue",
    );
    assert.equal(prepared.event.venue, "QA Context Venue");
    assert.equal(prepared.event.status, "approved");
  });

  runCase("unresolved missing venue remains publishable", () => {
    const date = isoDateDaysFromNow(19);
    const dateText = ddmmyyyy(date);
    const post = makePost({
      caption: `QA Unknown Venue Night ${dateText}.`,
      postId: "qa-unresolved-missing-venue",
      username: "qa_unknown_source",
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "QA Unknown Venue Night",
      venue: "",
    });
    const prepared = assertSingleOk(prepare(post, extracted), "unresolved missing venue");
    assert.equal(prepared.event.venue, "");
    assert.equal(
      prepared.event.status,
      "approved",
      "V2 evidence treats venue as optional when the post still establishes a clear dated event.",
    );
  });

  for (const fixture of [
    {
      name: "doors only",
      rawTime: "20:00",
      evidence: {
        status: "doors_open_only",
        exact_text: "Doors open 20:00",
        source: "caption",
      },
    },
    {
      name: "unreadable",
      rawTime: "22:?",
      evidence: {
        status: "unreadable",
        exact_text: "Poster time is unreadable",
        source: "poster",
      },
    },
  ]) {
    runCase(`${fixture.name} time semantics`, () => {
      const date = isoDateDaysFromNow(fixture.name === "doors only" ? 20 : 21);
      const dateText = ddmmyyyy(date);
      const evidenceText = fixture.evidence.source === "caption" ? ` ${fixture.evidence.exact_text}.` : "";
      const post = makePost({
        caption: `QA ${fixture.name} Night ${dateText} at QA Semantic Venue.${evidenceText}`,
        postId: `qa-${fixture.name.replaceAll(" ", "-")}-time`,
      });
      const extracted = makeEventExtraction({
        caption: post.caption,
        date,
        dateEvidenceText: dateText,
        postUrl: post.instagramPostUrl,
        title: `QA ${fixture.name} Night`,
        time: fixture.rawTime,
        timeEvidence: fixture.evidence,
      });
      const prepared = assertSingleOk(
        prepare(post, extracted, {
          selectedImageUrl:
            fixture.evidence.source === "poster"
              ? "https://cdn.example.com/qa-unreadable-time.jpg"
              : null,
        }),
        `${fixture.name} time`,
      );
      assert.equal(prepared.event.time, TBD_EVENT_TIME);
      assert.equal(prepared.event.timeEvidenceKind, fixture.evidence.status);
      assert.equal(prepared.event.timeEvidenceText, fixture.evidence.exact_text);
      assert.equal(prepared.event.timeStatus, "unknown");
      assert.notEqual(prepared.event.time, "20:00", "A doors-open clock is not a start time.");
    });
  }

  runCase("approved start-time attestation rejects mutation", () => {
    const date = isoDateDaysFromNow(22);
    const dateText = ddmmyyyy(date);
    const post = makePost({
      caption: `QA Attested Start ${dateText} at QA Semantic Venue. Starts at 21:00.`,
      postId: "qa-attested-start-time",
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "QA Attested Start",
      time: "21:00",
      timeEvidence: {
        status: "start_time_stated",
        exact_text: "Starts at 21:00",
        source: "caption",
      },
    });
    const prepared = assertSingleOk(prepare(post, extracted), "attested start time");
    assert.equal(prepared.event.status, "approved");
    assert.equal(prepared.event.time, "21:00");
    assert.equal(
      hasEventEvidenceV2AutoApproval(
        prepared.event.normalizedFieldsJson,
        prepared.event,
      ),
      true,
    );
    assert.doesNotThrow(() =>
      assertServiceUpdateEventPolicy(
        "pending",
        {
          status: "approved",
          normalizedFieldsJson: prepared.event.normalizedFieldsJson,
        },
        prepared.event,
      ),
    );

    assert.throws(
      () =>
        assertServiceUpdateEventPolicy(
          "pending",
          {
            status: "approved",
            time: "22:00",
            normalizedFieldsJson: prepared.event.normalizedFieldsJson,
          },
          prepared.event,
        ),
      /without complete source-grounded evidence/i,
      "Changing the public start time while reusing the old attestation must fail closed.",
    );

    const tamperedNormalizedFields = JSON.parse(prepared.event.normalizedFieldsJson);
    tamperedNormalizedFields.time = "22:00";
    assert.throws(
      () =>
        assertServiceUpdateEventPolicy(
          "pending",
          {
            status: "approved",
            normalizedFieldsJson: JSON.stringify(tamperedNormalizedFields),
          },
          prepared.event,
        ),
      /without complete source-grounded evidence/i,
      "Changing the normalized start time without changing the public field must fail closed.",
    );
  });

  runCase("verified shared schedule venue and time", () => {
    const firstDate = isoDateDaysFromNow(23);
    const secondDate = isoDateDaysFromNow(24);
    const firstText = ddmmyyyy(firstDate);
    const secondText = ddmmyyyy(secondDate);
    const sharedVenueEvidence = "All shows at QA Shared Hall";
    const sharedTimeEvidence = "Every show starts at 21:00";
    const post = makePost({
      caption: [
        sharedVenueEvidence,
        sharedTimeEvidence,
        `${firstText} — Alpha Night`,
        `${secondText} — Beta Night`,
      ].join("\n"),
      postId: "qa-shared-schedule-context",
    });
    const makeScheduleEntry = (date, dateText, title) => ({
      date,
      time: "",
      venue: "",
      title,
      artists: [],
      description: `${title} event.`,
      source_text: `${dateText} — ${title}`,
      date_evidence: {
        exact_text: dateText,
        source: "caption",
        is_relative: false,
        resolved_date: date,
      },
      time_evidence: {
        status: "not_stated",
        exact_text: "",
        source: "unknown",
      },
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date: "",
      dateEvidenceText: "",
      postUrl: post.instagramPostUrl,
      title: "",
      venue: "",
      date_evidence: {
        exact_text: "",
        source: "unknown",
        is_relative: false,
        resolved_date: "",
      },
      shared_schedule_context: {
        venue: {
          applies_to_all: true,
          value: "QA Shared Hall",
          evidence: sharedVenueEvidence,
          source: "caption",
        },
        time: {
          applies_to_all: true,
          value: "21:00",
          evidence: sharedTimeEvidence,
          source: "caption",
        },
      },
      schedule_entries: [
        makeScheduleEntry(firstDate, firstText, "Alpha Night"),
        makeScheduleEntry(secondDate, secondText, "Beta Night"),
      ],
    });
    const results = prepare(post, extracted);
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.kind, "ok");
      assert.equal(result.event.venue, "QA Shared Hall");
      assert.equal(result.event.time, "21:00");
      assert.equal(result.event.timeEvidenceKind, "start_time_stated");
      assert.equal(result.event.timeSource, "caption");
      assert.equal(result.event.timeEvidenceText, sharedTimeEvidence);
      assert.equal(result.event.timeStatus, "confirmed");
      assert.equal(result.event.status, "approved");
      assert.equal(result.normalizedFields.normalizedVenue, "QA Shared Hall");
      assert.equal(
        hasEventEvidenceV2AutoApproval(
          result.event.normalizedFieldsJson,
          result.event,
        ),
        true,
      );
      assert.deepEqual(result.event.artists, []);
    }

    const mismatchedSharedVenue = structuredClone(extracted);
    mismatchedSharedVenue.shared_schedule_context.venue.value = "Invented Shared Hall";
    const mismatchedResults = prepare(post, parseExtractedEventData(mismatchedSharedVenue));
    assert.equal(mismatchedResults.length, 2);
    for (const result of mismatchedResults) {
      assert.equal(result.kind, "ok");
      assert.equal(result.event.venue, "");
      assert.equal(result.normalizedFields.normalizedVenue, "");
    }
  });

  runCase("trusted venue account carries its canonical venue across schedule rows", () => {
    const firstDate = isoDateDaysFromNow(23);
    const secondDate = isoDateDaysFromNow(25);
    const firstText = ddmmyyyy(firstDate);
    const secondText = ddmmyyyy(secondDate);
    const sharedVenueEvidence = "THIS WEEK AT BOHO";
    const post = makePost({
      caption: [
        sharedVenueEvidence,
        `${firstText} / @qa_first_artist`,
        `${secondText} / @qa_second_artist`,
      ].join("\n"),
      postId: "qa-trusted-account-schedule-venue",
      username: "bohobar_belgrade",
    });
    const scheduleEntry = (date, dateText, artist) => ({
      date,
      time: "",
      venue: "Boho Bar",
      title: artist,
      artists: [artist],
      description: `${artist} performs.`,
      source_text: `${dateText} / @${artist}`,
      date_evidence: {
        exact_text: dateText,
        source: "caption",
        is_relative: false,
        resolved_date: date,
      },
      time_evidence: {
        status: "not_stated",
        exact_text: "",
        source: "unknown",
      },
    });
    const extracted = makeEventExtraction({
      artists: [],
      caption: post.caption,
      date: "",
      dateEvidenceText: "",
      postUrl: post.instagramPostUrl,
      title: "",
      venue: "Boho Bar",
      date_evidence: {
        exact_text: "",
        source: "unknown",
        is_relative: false,
        resolved_date: "",
      },
      shared_schedule_context: {
        venue: {
          applies_to_all: true,
          value: "Boho Bar",
          evidence: sharedVenueEvidence,
          source: "caption",
        },
        time: {
          applies_to_all: false,
          value: "",
          evidence: "",
          source: "unknown",
        },
      },
      schedule_entries: [
        scheduleEntry(firstDate, firstText, "qa_first_artist"),
        scheduleEntry(secondDate, secondText, "qa_second_artist"),
      ],
      field_confirmation: {
        ...structuredClone(validExtraction.field_confirmation),
        title: confirmation(""),
        location: confirmation(""),
        location_name: confirmation(sharedVenueEvidence),
        artists: confirmation("@qa_first_artist @qa_second_artist"),
      },
    });
    const results = prepare(post, extracted, {
      canonicalVenueNamesByHandle: { bohobar_belgrade: "Boho Bar" },
      configuredVenueNamesByHandle: { bohobar_belgrade: "Boho Bar" },
      sourceRolesByHandle: { bohobar_belgrade: "unknown" },
      selectedImageUrl: "https://images.example.com/boho-week.jpg",
    });
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.kind, "ok");
      assert.equal(result.event.venue, "Boho Bar");
      assert.equal(result.normalizedFields.normalizedVenue, "Boho Bar");
      assert.equal(result.normalizedFields.trustedVenueSource, true);
      assert.equal(result.normalizedFields.venueEvidenceVerified, true);
      assert.equal(result.event.status, "approved");
    }

    const promoterResults = prepare(post, extracted, {
      canonicalVenueNamesByHandle: { bohobar_belgrade: "Boho Bar" },
      configuredVenueNamesByHandle: { bohobar_belgrade: "Boho Bar" },
      sourceRolesByHandle: { bohobar_belgrade: "promoter" },
      selectedImageUrl: "https://images.example.com/boho-week.jpg",
    });
    for (const result of promoterResults) {
      assert.equal(result.kind, "ok");
      assert.equal(
        result.event.venue,
        "Boho Bar",
        "a promoter may carry a shared venue only when the source visibly says it applies",
      );
      assert.equal(result.normalizedFields.trustedVenueSource, false);
    }

    const noSharedVenueEvidence = structuredClone(extracted);
    noSharedVenueEvidence.shared_schedule_context.venue = {
      applies_to_all: false,
      value: "",
      evidence: "",
      source: "unknown",
    };
    const noSharedEvidenceResults = prepare(
      post,
      parseExtractedEventData(noSharedVenueEvidence),
      {
        canonicalVenueNamesByHandle: { bohobar_belgrade: "Boho Bar" },
        configuredVenueNamesByHandle: { bohobar_belgrade: "Boho Bar" },
        sourceRolesByHandle: { bohobar_belgrade: "unknown" },
        selectedImageUrl: "https://images.example.com/boho-week.jpg",
      },
    );
    for (const result of noSharedEvidenceResults) {
      assert.equal(result.kind, "ok");
      assert.equal(
        result.event.venue,
        "",
        "a trusted account alone must not leak its venue across schedule rows",
      );
      assert.equal(result.normalizedFields.normalizedVenue, "");
    }

    const zvezdaEvidence = "NA OTVORENOM U ZVEZDI";
    const zvezdaPost = makePost({
      caption: [
        zvezdaEvidence,
        `${firstText} / @qa_first_artist`,
        `${secondText} / @qa_second_artist`,
      ].join("\n"),
      postId: "qa-zvezda-inflected-shared-venue",
      username: "newcinemazvezda",
    });
    const zvezdaExtraction = structuredClone(extracted);
    zvezdaExtraction.source_caption = zvezdaPost.caption;
    zvezdaExtraction.source_url = zvezdaPost.instagramPostUrl;
    zvezdaExtraction.venue = "New Cinema Zvezda";
    zvezdaExtraction.shared_schedule_context.venue = {
      applies_to_all: true,
      value: "New Cinema Zvezda",
      evidence: zvezdaEvidence,
      source: "caption",
    };
    zvezdaExtraction.schedule_entries = zvezdaExtraction.schedule_entries.map(
      (entry) => ({ ...entry, venue: "New Cinema Zvezda" }),
    );
    zvezdaExtraction.field_confirmation.location_name = confirmation(zvezdaEvidence);
    const zvezdaResults = prepare(
      zvezdaPost,
      parseExtractedEventData(zvezdaExtraction),
      {
        canonicalVenueNamesByHandle: {
          newcinemazvezda: "New Cinema Zvezda",
        },
        configuredVenueNamesByHandle: {
          newcinemazvezda: "New Cinema Zvezda",
        },
        sourceRolesByHandle: { newcinemazvezda: "unknown" },
      },
    );
    for (const result of zvezdaResults) {
      assert.equal(result.kind, "ok");
      assert.equal(result.event.venue, "New Cinema Zvezda");
      assert.equal(result.normalizedFields.normalizedVenue, "New Cinema Zvezda");
    }

    const nearPrefixPost = {
      ...zvezdaPost,
      caption: zvezdaPost.caption.replace("U ZVEZDI", "U ZVEZDARI"),
    };
    const nearPrefixExtraction = structuredClone(zvezdaExtraction);
    nearPrefixExtraction.source_caption = nearPrefixPost.caption;
    nearPrefixExtraction.shared_schedule_context.venue.evidence =
      "NA OTVORENOM U ZVEZDARI";
    nearPrefixExtraction.field_confirmation.location_name = confirmation(
      "NA OTVORENOM U ZVEZDARI",
    );
    const nearPrefixResults = prepare(
      nearPrefixPost,
      parseExtractedEventData(nearPrefixExtraction),
      {
        canonicalVenueNamesByHandle: {
          newcinemazvezda: "New Cinema Zvezda",
        },
        configuredVenueNamesByHandle: {
          newcinemazvezda: "New Cinema Zvezda",
        },
        sourceRolesByHandle: { newcinemazvezda: "unknown" },
      },
    );
    for (const result of nearPrefixResults) {
      assert.equal(result.kind, "ok");
      assert.equal(
        result.event.venue,
        "",
        "a nearby venue name such as Zvezdara must not be accepted as Zvezda",
      );
    }

    const rowAliasLines = [
      `${firstText} / @qa_first_artist u Zvezdi`,
      `${secondText} / @qa_second_artist u Zvezdi`,
    ];
    const rowAliasPost = makePost({
      caption: rowAliasLines.join("\n"),
      postId: "qa-zvezda-row-alias",
      username: "qa_promoter_source",
    });
    const rowAliasExtraction = structuredClone(zvezdaExtraction);
    rowAliasExtraction.source_caption = rowAliasPost.caption;
    rowAliasExtraction.source_url = rowAliasPost.instagramPostUrl;
    rowAliasExtraction.shared_schedule_context.venue = {
      applies_to_all: false,
      value: "",
      evidence: "",
      source: "unknown",
    };
    rowAliasExtraction.schedule_entries = rowAliasExtraction.schedule_entries.map(
      (entry, index) => ({ ...entry, source_text: rowAliasLines[index] }),
    );
    const rowAliasResults = prepare(
      rowAliasPost,
      parseExtractedEventData(rowAliasExtraction),
      {
        canonicalVenueNamesByHandle: {
          qa_promoter_source: "Different Promoter Office",
        },
        configuredVenueNamesByHandle: {},
        sourceRolesByHandle: { qa_promoter_source: "promoter" },
      },
    );
    for (const result of rowAliasResults) {
      assert.equal(result.kind, "ok");
      assert.equal(
        result.event.venue,
        "New Cinema Zvezda",
        "a row-specific Serbian venue inflection must bind without account fallback",
      );
    }

    const shortRowAliasExtraction = structuredClone(rowAliasExtraction);
    shortRowAliasExtraction.schedule_entries =
      shortRowAliasExtraction.schedule_entries.map((entry) => ({
        ...entry,
        venue: "Zvezda",
      }));
    const shortRowAliasResults = prepare(
      rowAliasPost,
      parseExtractedEventData(shortRowAliasExtraction),
      {
        canonicalVenueNamesByHandle: {
          qa_promoter_source: "Different Promoter Office",
        },
        configuredVenueNamesByHandle: {},
        sourceRolesByHandle: { qa_promoter_source: "promoter" },
      },
    );
    for (const result of shortRowAliasResults) {
      assert.equal(result.kind, "ok");
      assert.equal(
        result.event.venue,
        "Zvezda",
        "a short row venue must accept the exact Serbian inflection Zvezdi",
      );
    }

    const rowNearPrefixPost = {
      ...rowAliasPost,
      caption: rowAliasPost.caption.replaceAll("Zvezdi", "Zvezdari"),
    };
    const rowNearPrefixExtraction = structuredClone(rowAliasExtraction);
    rowNearPrefixExtraction.source_caption = rowNearPrefixPost.caption;
    rowNearPrefixExtraction.schedule_entries =
      rowNearPrefixExtraction.schedule_entries.map((entry) => ({
        ...entry,
        venue: "Zvezda",
        source_text: entry.source_text.replace("Zvezdi", "Zvezdari"),
      }));
    const rowNearPrefixResults = prepare(
      rowNearPrefixPost,
      parseExtractedEventData(rowNearPrefixExtraction),
      {
        canonicalVenueNamesByHandle: {
          qa_promoter_source: "Different Promoter Office",
        },
        configuredVenueNamesByHandle: {},
        sourceRolesByHandle: { qa_promoter_source: "promoter" },
      },
    );
    for (const result of rowNearPrefixResults) {
      assert.equal(result.kind, "ok");
      assert.equal(
        result.event.venue,
        "",
        "a row-specific nearby venue name must not pass alias grounding",
      );
    }
  });

  runCase("single-occurrence captions retain the physical venue without trusting promoters", () => {
    const date = isoDateDaysFromNow(28);
    const dateText = ddmmyyyy(date);
    const madlenianumTitle = "JA, EMA – Ljubavni život Eme Bovari";
    const madlenianumSourceLine = `${madlenianumTitle} | Premijera: ${dateText}`;
    const madlenianumPost = makePost({
      caption: [
        madlenianumTitle,
        `Premijera: ${dateText}`,
        "Velika scena Madlenianuma",
      ].join("\n"),
      postId: "qa-single-madlenianum-venue",
      username: "madlenianum",
    });
    const madlenianumExtraction = makeEventExtraction({
      artists: [],
      caption: madlenianumPost.caption,
      date: "",
      dateEvidenceText: "",
      postUrl: madlenianumPost.instagramPostUrl,
      title: "",
      venue: "",
      schedule_entries: [
        {
          date,
          time: "",
          venue: "Opera & Theater Madlenianum",
          title: madlenianumTitle,
          artists: [],
          description: "Premijera predstave.",
          source_text: madlenianumSourceLine,
          date_evidence: {
            exact_text: `Premijera: ${dateText}`,
            source: "caption",
            is_relative: false,
            resolved_date: date,
          },
          time_evidence: {
            status: "not_stated",
            exact_text: "",
            source: "unknown",
          },
        },
      ],
      field_confirmation: {
        ...structuredClone(validExtraction.field_confirmation),
        title: confirmation(madlenianumTitle),
        location: confirmation(""),
        location_name: confirmation("Velika scena Madlenianuma"),
        artists: confirmation(""),
      },
    });
    const madlenianum = assertSingleOk(
      prepare(madlenianumPost, madlenianumExtraction, {
        canonicalVenueNamesByHandle: {
          madlenianum: "Opera & Theater Madlenianum",
        },
        configuredVenueNamesByHandle: {
          madlenianum: "Opera & Theater Madlenianum",
        },
        sourceRolesByHandle: { madlenianum: "unknown" },
      }),
      "Madlenianum single occurrence",
    );
    assert.equal(madlenianum.event.venue, "Opera & Theater Madlenianum");
    assert.equal(madlenianum.normalizedFields.trustedVenueSource, true);

    const delArnoTitle = "Del Arno Band";
    const delArnoSourceLine = `${delArnoTitle} | ${dateText}`;
    const longPlayPost = makePost({
      caption: `${delArnoTitle} nastupa ${dateText} u 20:00 u Botaničkoj bašti Jevremovac.`,
      postId: "qa-single-long-play-promoter",
      username: "longplayofficial",
    });
    const longPlayExtraction = makeEventExtraction({
      artists: [delArnoTitle],
      caption: longPlayPost.caption,
      date: "",
      dateEvidenceText: "",
      postUrl: longPlayPost.instagramPostUrl,
      title: "",
      venue: "Long Play",
      schedule_entries: [
        {
          date,
          time: "20:00",
          venue: "Jevremovac",
          title: delArnoTitle,
          artists: [delArnoTitle],
          description: "Koncert u Botaničkoj bašti Jevremovac.",
          source_text: delArnoSourceLine,
          date_evidence: {
            exact_text: dateText,
            source: "caption",
            is_relative: false,
            resolved_date: date,
          },
          time_evidence: {
            status: "start_time_stated",
            exact_text: "20:00",
            source: "caption",
          },
        },
      ],
      field_confirmation: {
        ...structuredClone(validExtraction.field_confirmation),
        title: confirmation(delArnoTitle),
        location: confirmation(""),
        location_name: confirmation("Botaničkoj bašti Jevremovac"),
        artists: confirmation(delArnoTitle),
      },
    });
    const longPlay = assertSingleOk(
      prepare(longPlayPost, longPlayExtraction, {
        canonicalVenueNamesByHandle: { longplayofficial: "Long Play" },
        configuredVenueNamesByHandle: { longplayofficial: "Long Play" },
        sourceRolesByHandle: { longplayofficial: "promoter" },
      }),
      "Long Play promoter single occurrence",
    );
    assert.equal(longPlay.event.venue, "Jevremovac");
    assert.equal(longPlay.normalizedFields.trustedVenueSource, false);
  });

  runCase("blank venues are unknown rather than the same venue", () => {
    const existing = {
      title: "Cidade de Deus",
      date: "2026-08-11",
      time: "21:00",
      venue: "",
      artists: [],
      instagramPostId: "qa-existing-source",
      instagramPostUrl: "https://www.instagram.com/p/qa-existing-source/",
      eventType: "arts & culture",
      status: "approved",
      updatedAt: 1,
      _id: "qa-existing-event",
    };
    const unrelated = {
      title: "Unrelated Club Night",
      date: existing.date,
      time: "TBD",
      venue: "",
      artists: ["Different Artist"],
      instagramPostId: "qa-unrelated-source",
      instagramPostUrl: "https://www.instagram.com/p/qa-unrelated-source/",
      eventType: "nightlife",
      status: "approved",
    };
    assert.equal(
      classifyExistingApprovedOccurrenceForTesting(existing, unrelated),
      "unrelated",
      "Two absent venue values must not manufacture a same-venue ambiguity.",
    );
    assert.equal(
      classifyExistingApprovedOccurrenceForTesting(existing, {
        ...unrelated,
        title: existing.title,
        time: existing.time,
      }),
      "proven_duplicate",
      "Unknown venues must still fail closed when identity and time prove a duplicate.",
    );
  });

  runCase("unverified shared context cannot leak", () => {
    const firstDate = isoDateDaysFromNow(26);
    const secondDate = isoDateDaysFromNow(27);
    const firstText = ddmmyyyy(firstDate);
    const secondText = ddmmyyyy(secondDate);
    const post = makePost({
      caption: [`${firstText} — Gamma Night`, `${secondText} — Delta Night`].join("\n"),
      postId: "qa-unverified-shared-context",
      username: "qa_unverified_schedule",
    });
    const makeScheduleEntry = (date, dateText, title) => ({
      date,
      time: "",
      venue: "",
      title,
      artists: [],
      description: "",
      source_text: `${dateText} — ${title}`,
      date_evidence: {
        exact_text: dateText,
        source: "caption",
        is_relative: false,
        resolved_date: date,
      },
      time_evidence: {
        status: "start_time_stated",
        exact_text: "Every show starts at 23:00",
        source: "caption",
      },
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date: "",
      dateEvidenceText: "",
      postUrl: post.instagramPostUrl,
      title: "Top Level Program",
      titleEvidenceText: "",
      time: "19:00",
      venue: "Top Level Venue",
      artists: ["Top Level Artist"],
      artistEvidenceText: "",
      description: "Top-level description must not leak.",
      date_evidence: {
        exact_text: "",
        source: "unknown",
        is_relative: false,
        resolved_date: "",
      },
      shared_schedule_context: {
        venue: {
          applies_to_all: true,
          value: "Ungrounded Shared Venue",
          evidence: "All shows at Ungrounded Shared Venue",
          source: "caption",
        },
        time: {
          applies_to_all: true,
          value: "23:00",
          evidence: "Every show starts at 23:00",
          source: "caption",
        },
      },
      schedule_entries: [
        makeScheduleEntry(firstDate, firstText, "Gamma Night"),
        makeScheduleEntry(secondDate, secondText, "Delta Night"),
      ],
    });
    const results = prepare(post, extracted);
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.kind, "ok");
      assert.equal(result.event.venue, "");
      assert.equal(result.event.time, TBD_EVENT_TIME);
      assert.deepEqual(result.event.artists, []);
      assert.notEqual(result.event.description, "Top-level description must not leak.");
    }
  });

  runCase("one overall nightlife window coalesces consecutive DJ slots", () => {
    const date = isoDateDaysFromNow(2);
    const dateText = ddmmyyyy(date);
    const post = makePost({
      caption: "Male izmene i nova imena u klubu.",
      postId: "qa-para-lineup-timetable",
      postedAt: semanticQaNow.toISOString(),
      username: "para_klub",
    });
    const dateEvidence = {
      exact_text: dateText,
      source: "poster",
      is_relative: false,
      resolved_date: date,
    };
    const slot = (time, title, artists) => ({
      date: dateText,
      time,
      venue: "Para klub Beograd",
      title,
      artists,
      description: `${title} DJ set.`,
      source_text: `${time.replace("-", " - ")} - ${title}`,
      date_evidence: dateEvidence,
      time_evidence: {
        status: "start_time_stated",
        exact_text: time,
        source: "poster",
      },
    });
    const extracted = makeEventExtraction({
      caption: post.caption,
      date: "",
      dateEvidenceText: "",
      postUrl: post.instagramPostUrl,
      title: "",
      titleEvidenceText: "Anshi b2b Cvayn, Madji, Vagabond",
      titleEvidenceSource: "poster",
      time: "",
      venue: "Para klub Beograd",
      artists: [],
      artistEvidenceText: "Anshi b2b Cvayn, Madji, Vagabond",
      artistEvidenceSource: "poster",
      description: "Three DJ sets featuring Anshi b2b Cvayn, Madji and Vagabond.",
      shared_schedule_context: {
        venue: {
          applies_to_all: true,
          value: "Para klub Beograd",
          evidence: "para (logo/header) on poster",
          source: "poster",
        },
        time: {
          applies_to_all: true,
          value: "14:00 - 22:00",
          evidence: `${dateText} 14:00 - 22:00`,
          source: "poster",
        },
      },
      schedule_entries: [
        slot("14:00-17:00", "Anshi b2b Cvayn", ["Anshi", "Cvayn"]),
        slot("17:00-19:30", "Madji", ["Madji"]),
        slot("19:30-22:00", "Vagabond", ["Vagabond"]),
      ],
    });
    const prepared = assertSingleOk(
      prepare(post, extracted, {
        selectedImageUrl: "https://cdn.example.com/para-lineup.jpg",
        canonicalVenueNamesByHandle: { para_klub: "Para klub Beograd" },
        configuredVenueNamesByHandle: { para_klub: "Para klub Beograd" },
        sourceRolesByHandle: { para_klub: "venue" },
      }),
      "Para lineup timetable",
    );
    assert.equal(
      prepared.event.status,
      "approved",
      `Para lineup timetable should auto-approve: ${JSON.stringify(
        prepared.normalizedFields.moderationPendingReasons,
      )}`,
    );
    assert.deepEqual(
      {
        artists: prepared.event.artists,
        description: prepared.event.description,
        status: prepared.event.status,
        time: prepared.event.time,
        title: prepared.event.title,
        venue: prepared.event.venue,
      },
      {
        artists: ["Anshi", "Cvayn", "Madji", "Vagabond"],
        description:
          "14:00–17:00 Anshi b2b Cvayn; 17:00–19:30 Madji; 19:30–22:00 Vagabond.",
        status: "approved",
        time: "14:00-22:00",
        title: "Anshi b2b Cvayn, Madji & Vagabond",
        venue: "Para klub Beograd",
      },
    );
    assert.equal(prepared.normalizedFields.lineupScheduleCoalesced, true);
    assert.equal(prepared.normalizedFields.lineupScheduleCoalescingPolicyVersion, 2);
    assert.equal(prepared.normalizedFields.lineupScheduleSourceRowCount, 3);
    assert.equal(prepared.normalizedFields.multiEventSplitCount, 3);
    assert.equal(prepared.normalizedFields.splitEventTotal, 1);
    assert.equal(prepared.normalizedFields.identityEvidenceVerified, true);
    assert.equal(prepared.normalizedFields.structuredEvidenceVerified, true);

    const distinctShows = parseExtractedEventData({
      ...structuredClone(extracted),
      schedule_entries: [
        slot("14:00-17:00", "Sunset Party", ["Anshi"]),
        slot("17:00-22:00", "Red Hot Matine", ["Madji"]),
      ],
    });
    assert.equal(
      prepare(post, distinctShows, {
        selectedImageUrl: "https://cdn.example.com/distinct-shows.jpg",
        canonicalVenueNamesByHandle: { para_klub: "Para klub Beograd" },
        configuredVenueNamesByHandle: { para_klub: "Para klub Beograd" },
        sourceRolesByHandle: { para_klub: "venue" },
      }).length,
      2,
      "independently named shows must remain separate even when their windows are contiguous",
    );

    const differentRooms = parseExtractedEventData({
      ...structuredClone(extracted),
      shared_schedule_context: {
        ...structuredClone(extracted.shared_schedule_context),
        venue: {
          applies_to_all: false,
          value: "",
          evidence: "",
          source: "unknown",
        },
      },
      schedule_entries: [
        {
          ...slot("14:00-17:00", "Anshi", ["Anshi"]),
          source_text: "14:00 - 17:00 - Anshi - Para klub Beograd",
        },
        {
          ...slot("17:00-22:00", "Madji", ["Madji"]),
          venue: "Para Back Room",
          source_text: "17:00 - 22:00 - Madji - Para Back Room",
        },
      ],
    });
    const differentRoomResults = prepare(post, differentRooms, {
        selectedImageUrl: "https://cdn.example.com/different-rooms.jpg",
        sourceRolesByHandle: { para_klub: "promoter" },
      });
    assert.equal(
      differentRoomResults.length,
      2,
      "different physical rooms must never be collapsed into one lineup event",
    );
    assert.deepEqual(
      differentRoomResults.map((result) => ({
        kind: result.kind,
        venue: result.kind === "ok" ? result.event.venue : null,
      })),
      [
        { kind: "ok", venue: "Para klub Beograd" },
        { kind: "ok", venue: "Para Back Room" },
      ],
    );

    const planCandidate = (id, title, artists, time, sourceText = `${time} ${title}`) => ({
      id,
      title,
      date,
      time,
      venue: "Para klub Beograd",
      artists,
      sourceText,
      source: "poster",
      timeEvidenceText: time,
      timeEvidenceVerified: true,
    });
    const buildPlan = (candidates) =>
      buildNightlifeLineupCoalescingPlan({
        eventType: "nightlife",
        candidates,
        sourceConflictCount: 0,
        sharedTime: { value: "14:00-22:00", verified: true },
      });
    assert.equal(
      buildPlan([
        planCandidate("a", "Anshi", ["Anshi"], ""),
        planCandidate("b", "Madji", ["Madji"], ""),
      ]),
      null,
      "untimed same-date artist rows are not enough to prove one occurrence",
    );
    assert.equal(
      buildPlan([
        planCandidate("a", "Anshi", ["Anshi"], "22:00"),
        planCandidate("b", "Madji", ["Madji"], "22:00"),
      ]),
      null,
      "a repeated start time is not enough to prove one occurrence",
    );
    assert.equal(
      buildPlan([
        planCandidate("a", "Anshi", ["Anshi"], "14:00-17:00", "Anshi"),
        planCandidate("b", "Madji", ["Madji"], "17:00-22:00", "Madji"),
      ]),
      null,
      "modeled slot times must be present in each exact row source snippet",
    );
    assert.equal(
      buildPlan([
        planCandidate("a", "Anshi", ["Anshi"], "14:00-17:00"),
        planCandidate("b", "Madji", ["Madji"], "18:00-22:00"),
      ]),
      null,
      "a gap between independently timed sets must not be silently merged",
    );
    assert.equal(
      titleContainsOnlyBilledArtists("Live Aid", ["Aid"]),
      false,
      "the word Live is identity-bearing and must not be stripped from titles",
    );
  });

  runCase("an explicit after-midnight takeover stays inside the named nightlife event", () => {
    const date = isoDateDaysFromNow(2);
    const dateText = ddmmyyyy(date);
    const venue = "Ben Akiba";
    const primarySourceText =
      "Saturday begins with Disco Retro Party from 8 PM, where DJ Munja & DJ File bring timeless classics back to the dancefloor.";
    const continuationSourceText =
      "After midnight, Malina takes over, carrying the night into a new chapter.";
    const directCandidate = ({
      id,
      title,
      artists,
      time,
      sourceText,
      timeEvidenceKind,
      source = "caption",
    }) => ({
      id,
      title,
      date,
      time,
      venue,
      artists,
      sourceText,
      source,
      sourcePostIdentity: "qa-ben-after-midnight-continuation",
      timeEvidenceText: time ? "from 8 PM" : "",
      timeEvidenceVerified: true,
      timeEvidenceKind,
    });
    const primary = directCandidate({
      id: "disco",
      title: "DISCO",
      artists: ["DJ Munja", "DJ File"],
      time: "20:00",
      sourceText: primarySourceText,
      timeEvidenceKind: "start_time_stated",
    });
    const continuation = directCandidate({
      id: "malina",
      title: "Malina",
      artists: ["Malina"],
      time: "",
      sourceText: continuationSourceText,
      timeEvidenceKind: "not_stated",
    });
    const buildPlan = (candidates, sourceConflictCount = 0) =>
      buildNightlifeLineupCoalescingPlan({
        eventType: "nightlife",
        candidates,
        sourceConflictCount,
        sharedTime: { value: "", verified: false },
      });
    assert.deepEqual(buildPlan([primary, continuation]), {
      candidateIds: ["disco", "malina"],
      title: "DISCO",
      date,
      time: "20:00",
      venue,
      artists: ["DJ Munja", "DJ File", "Malina"],
      description: "Lineup: DJ Munja, DJ File & Malina; Malina takes over after midnight.",
      sourceTexts: [primarySourceText, continuationSourceText],
      slots: [
        {
          title: "DISCO",
          time: "20:00",
          artists: ["DJ Munja", "DJ File"],
          sourceText: primarySourceText,
          source: "caption",
        },
        {
          title: "Malina",
          time: "",
          artists: ["Malina"],
          sourceText: continuationSourceText,
          source: "caption",
        },
      ],
      timingMode: "after_midnight_continuation",
    });
    for (const sourceText of [
      "After midnight Malina takes over the booth",
      "Nakon ponoći Malina preuzima pult",
      "Posle ponoći pult preuzima Malina",
      "Иза поноћи Малина преузима пулт",
    ]) {
      assert.equal(
        explicitlyStatesAfterMidnightTakeover(sourceText),
        true,
        `Expected a strong takeover phrase: ${sourceText}`,
      );
    }
    for (const sourceText of [
      "After Midnight Party with Malina",
      "Malina takes over at 23h",
      "Malina takes over before midnight; after midnight the party continues",
      "Posle ponoći nastupa Malina",
      "Malina preuzima pult u 23h",
    ]) {
      assert.equal(
        explicitlyStatesAfterMidnightTakeover(sourceText),
        false,
        `A partial continuation hint must not be sufficient: ${sourceText}`,
      );
    }
    assert.equal(
      buildPlan([
        primary,
        { ...continuation, sourceText: `${dateText} / MALINA AFTER MIDNIGHT` },
      ]),
      null,
      "an ordinary after-midnight performer row without takeover language stays separate",
    );
    assert.equal(
      buildPlan([
        primary,
        { ...continuation, title: "Malina Showcase" },
      ]),
      null,
      "an independently named show stays separate even when its copy says takes over",
    );
    assert.equal(
      buildPlan([
        primary,
        {
          ...continuation,
          time: "23:00",
          timeEvidenceText: "23H",
          timeEvidenceKind: "start_time_stated",
        },
      ]),
      null,
      "two independently timed same-date rows stay separate",
    );
    assert.equal(
      buildPlan([{ ...primary, time: "20:30" }, continuation]),
      null,
      "a source start of 8 PM cannot prove a modeled 20:30 start",
    );
    assert.equal(
      buildPlan([{ ...primary, timeEvidenceVerified: false }, continuation]),
      null,
      "an unverified primary start cannot anchor a continuation fold",
    );
    assert.equal(
      buildPlan([{ ...primary, source: "poster" }, continuation]),
      null,
      "cross-source rows cannot manufacture a takeover continuation",
    );
    assert.equal(
      buildPlan([
        primary,
        { ...continuation, sourcePostIdentity: "another-instagram-post" },
      ]),
      null,
      "cross-post rows cannot manufacture a takeover continuation",
    );
    assert.equal(
      buildPlan([primary, continuation], 1),
      null,
      "source conflicts block deterministic continuation folding",
    );

    const post = makePost({
      caption: ["BEN AKIBA", dateText, primarySourceText, continuationSourceText].join("\n"),
      postId: "qa-ben-after-midnight-continuation",
      postType: "video",
      postedAt: semanticQaNow.toISOString(),
      username: "benakiba",
    });
    const dateEvidence = {
      exact_text: dateText,
      source: "caption",
      is_relative: false,
      resolved_date: date,
    };
    const primaryEntry = {
      date: dateText,
      time: "20:00",
      venue,
      title: "DISCO",
      artists: ["DJ Munja", "DJ File"],
      description: "DISCO with DJ Munja and DJ File.",
      source_text: primarySourceText,
      date_evidence: dateEvidence,
      time_evidence: {
        status: "start_time_stated",
        exact_text: "from 8 PM",
        source: "caption",
      },
    };
    const continuationEntry = {
      date: dateText,
      time: "",
      venue,
      title: "Malina",
      artists: ["Malina"],
      description: "Malina takes over after midnight.",
      source_text: continuationSourceText,
      date_evidence: dateEvidence,
      time_evidence: {
        status: "not_stated",
        exact_text: "",
        source: "unknown",
      },
    };
    const extracted = makeEventExtraction({
      caption: post.caption,
      date: "",
      dateEvidenceText: "",
      postUrl: post.instagramPostUrl,
      title: "DISCO",
      titleEvidenceSource: "caption",
      titleEvidenceText: "DISCO",
      time: "",
      venue,
      artists: ["DJ Munja", "DJ File", "Malina"],
      artistEvidenceSource: "caption",
      artistEvidenceText: "DJ MUNJA / DJ FILE / MALINA",
      description: "DISCO with DJ Munja, DJ File and Malina.",
      date_evidence: {
        exact_text: "",
        source: "unknown",
        is_relative: false,
        resolved_date: "",
      },
      time_evidence: {
        status: "not_stated",
        exact_text: "",
        source: "unknown",
      },
      shared_schedule_context: {
        venue: {
          applies_to_all: true,
          value: venue,
          evidence: "BEN AKIBA",
          source: "caption",
        },
        time: {
          applies_to_all: false,
          value: "",
          evidence: "",
          source: "unknown",
        },
      },
      schedule_entries: [primaryEntry, continuationEntry],
    });
    const prepareOptions = {
      canonicalVenueNamesByHandle: { benakiba: venue },
      configuredVenueNamesByHandle: { benakiba: venue },
      sourceRolesByHandle: { benakiba: "venue" },
    };
    const prepared = assertSingleOk(
      prepare(post, extracted, prepareOptions),
      "Ben Akiba after-midnight continuation",
    );
    assert.deepEqual(
      {
        title: prepared.event.title,
        time: prepared.event.time,
        venue: prepared.event.venue,
        artists: prepared.event.artists,
        description: prepared.event.description,
        status: prepared.event.status,
      },
      {
        title: "DISCO",
        time: "20:00",
        venue,
        artists: ["DJ Munja", "DJ File", "Malina"],
        description: "Lineup: DJ Munja, DJ File & Malina; Malina takes over after midnight.",
        status: "approved",
      },
    );
    assert.equal(prepared.normalizedFields.lineupScheduleCoalesced, true);
    assert.equal(
      prepared.normalizedFields.lineupScheduleTimingMode,
      "after_midnight_continuation",
    );
    assert.deepEqual(prepared.normalizedFields.lineupScheduleSourceEvidence, [
      { text: primarySourceText, source: "caption" },
      { text: continuationSourceText, source: "caption" },
    ]);
    assert.equal(prepared.normalizedFields.lineupScheduleCoalescingPolicyVersion, 2);
    assert.equal(prepared.normalizedFields.lineupScheduleSourceRowCount, 2);
    assert.equal(prepared.normalizedFields.multiEventSplitCount, 2);
    assert.equal(prepared.normalizedFields.splitEventTotal, 1);
    assert.equal(prepared.normalizedFields.identityEvidenceVerified, true);
    assert.equal(prepared.normalizedFields.timeEvidenceVerified, true);
    assert.equal(prepared.normalizedFields.structuredEvidenceVerified, true);

    const ordinarySameNight = parseExtractedEventData({
      ...structuredClone(extracted),
      schedule_entries: [
        primaryEntry,
        {
          ...continuationEntry,
          source_text: `${dateText} / BEN AKIBA / MALINA AFTER MIDNIGHT`,
        },
      ],
    });
    assert.equal(
      prepare(post, ordinarySameNight, prepareOptions).length,
      2,
      "ordinary same-date rows without explicit takeover language remain separate",
    );
  });

  runCase("Red Bara is a strict inflection of the Red Bar venue name", () => {
    assert.equal(venueValueAppearsInEventEvidence("RED BAR", "sprat Red Bara"), true);
    assert.equal(venueValueAppearsInEventEvidence("RED BAR", "Blue Bara"), false);
    assert.equal(venueValueAppearsInEventEvidence("RED BAR", "Red Star Bara"), false);
    assert.equal(venueValueAppearsInEventEvidence("bar", "Red Bara"), false);

    const date = isoDateDaysFromNow(2);
    const dateText = ddmmyyyy(date);
    const caption = [
      "Sutra se penjemo na prvi sprat Red Bara, gde vas od 15h čeka Red Hot Matine i Kaizen za pultom.",
      `${dateText} | od 15h`,
      "Kaizen",
      "sprat Red Bara",
    ].join("\n");
    const post = makePost({
      caption,
      postId: "qa-red-bar-inflection",
      postedAt: semanticQaNow.toISOString(),
      username: "redbar_beograd",
    });
    const sourceLine = `${dateText} | od 15h\nKaizen\nsprat Red Bara`;
    const extracted = makeEventExtraction({
      caption,
      date: dateText,
      dateEvidenceText: dateText,
      postUrl: post.instagramPostUrl,
      title: "Red Hot Matine",
      titleEvidenceText: "Red Hot Matine",
      time: "15:00",
      timeEvidence: {
        status: "start_time_stated",
        exact_text: "od 15h",
        source: "caption",
      },
      venue: "RED BAR",
      artists: ["Kaizen"],
      artistEvidenceText: "Kaizen",
      description: "Matine sa Kaizen za pultom.",
      shared_schedule_context: {
        venue: {
          applies_to_all: true,
          value: "RED BAR",
          evidence: "sprat Red Bara",
          source: "caption",
        },
        time: {
          applies_to_all: true,
          value: "15:00",
          evidence: "od 15h",
          source: "caption",
        },
      },
      schedule_entries: [
        {
          date: dateText,
          time: "15:00",
          venue: "RED BAR",
          title: "Red Hot Matine",
          artists: ["Kaizen"],
          description: "Matine sa Kaizen za pultom.",
          source_text: sourceLine,
          date_evidence: {
            exact_text: dateText,
            source: "caption",
            is_relative: false,
            resolved_date: date,
          },
          time_evidence: {
            status: "start_time_stated",
            exact_text: "od 15h",
            source: "caption",
          },
        },
      ],
    });
    const prepared = assertSingleOk(
      prepare(post, extracted, {
        canonicalVenueNamesByHandle: { redbar_beograd: "RED BAR" },
        configuredVenueNamesByHandle: { redbar_beograd: "RED BAR" },
        sourceRolesByHandle: { redbar_beograd: "promoter" },
      }),
      "Red Bar inflection",
    );
    assert.equal(prepared.event.venue, "RED BAR");
    assert.equal(prepared.event.status, "approved");
    assert.equal(prepared.normalizedFields.venueEvidenceVerified, true);
  });

  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} event evidence semantic QA case(s) failed.`);
  }
}

function assertRequired(schema, fields, label) {
  for (const field of fields) {
    assert.ok(schema.required.includes(field), `${label} should require ${field}.`);
  }
}

const previousOpenAiKey = process.env.OPENAI_API_KEY;
const previousVisionModel = process.env.OPENAI_VISION_MODEL;
const originalFetch = globalThis.fetch;
const requestBodies = [];
let responseNumber = 0;

try {
  process.env.OPENAI_API_KEY = "qa-openai-key";
  process.env.OPENAI_VISION_MODEL = "qa-openai-vision-model";
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://api.openai.com/v1/responses");
    assert.equal(init?.method, "POST");
    requestBodies.push(JSON.parse(String(init?.body)));
    responseNumber += 1;

    const extraction = structuredClone(validExtraction);
    // Fresh compact outputs never echo source input; the transport wrapper
    // restores both exact values before durable caching.
    extraction.source_caption = "";
    extraction.source_url = "";
    if (responseNumber === 2) {
      delete extraction.date_evidence;
    } else if (responseNumber === 3) {
      extraction.is_event = false;
      extraction.non_event_reason = "";
    }

    return Response.json({
      model: "qa-openai-vision-model",
      usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
      output_text: JSON.stringify(extraction),
    });
  };

  const result = await extractEventDataFromInstagramPost({
    caption: validExtraction.source_caption,
    imageDataUrl: "data:image/jpeg;base64,AA==",
    instagramPostUrl: validExtraction.source_url,
    instagramHandle: "qa_club",
    instagramPostTimestamp: "2026-08-11T10:00:00.000Z",
  });

  assert.equal(result.extraction_contract_version, "event_evidence_v2");
  assert.equal(result.is_event, true);
  assert.equal(result.date_evidence.resolved_date, "2026-08-12");
  assert.equal(result.time_evidence.status, "doors_open_only");
  assert.equal(result.schedule_entries[0]?.venue, "QA Club");
  assert.equal(result.source_conflicts[0]?.field, "venue");

  const request = requestBodies[0];
  assert.equal(request.model, "qa-openai-vision-model");
  assert.equal(request.max_output_tokens, 8192);
  assert.equal(request.reasoning.effort, "medium");
  assert.equal(request.text.verbosity, "low");
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.name, "nightlife_event_extraction");
  assert.ok(
    request.input[1].content.some((item) => item.type === "input_image"),
    "The Responses API request should retain poster image input.",
  );

  const schema = request.text.format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schedule_entries.maxItems, 64);
  assert.equal(schema.properties.source_conflicts.maxItems, 32);
  assert.equal(
    schema.properties.field_confirmation.properties.title.properties.evidence_snippets.maxItems,
    1,
  );
  assert.equal(JSON.stringify(schema).includes("maxLength"), false);
  assert.equal(schema.properties.source_caption.pattern, "^$");
  assert.equal(schema.properties.source_url.pattern, "^$");
  assert.equal(
    new RegExp(schema.properties.reasoning_notes.pattern).test("x".repeat(161)),
    false,
  );
  assert.deepEqual(schema.properties.extraction_contract_version.enum, [
    "event_evidence_v2",
  ]);
  assertRequired(
    schema,
    [
      "extraction_contract_version",
      "is_event",
      "non_event_reason",
      "date_evidence",
      "time_evidence",
      "source_conflicts",
      "shared_schedule_context",
    ],
    "Extraction schema",
  );
  assertRequired(
    schema.properties.date_evidence,
    ["exact_text", "source", "is_relative", "resolved_date"],
    "Date evidence schema",
  );
  assert.deepEqual(schema.properties.time_evidence.properties.status.enum, [
    "start_time_stated",
    "not_stated",
    "unreadable",
    "doors_open_only",
  ]);
  assert.deepEqual(schema.properties.source_conflicts.items.properties.field.enum, [
    "date",
    "time",
    "venue",
    "title",
    "artists",
  ]);
  assertRequired(
    schema.properties.shared_schedule_context,
    ["venue", "time"],
    "Shared schedule context schema",
  );
  assertRequired(
    schema.properties.schedule_entries.items,
    ["venue", "date_evidence", "time_evidence"],
    "Schedule entry schema",
  );

  await assert.rejects(
    extractEventDataFromInstagramPost({
      caption: validExtraction.source_caption,
      instagramPostUrl: validExtraction.source_url,
      instagramHandle: "qa_club",
      instagramPostTimestamp: "2026-08-11T10:00:00.000Z",
      extractionMode: "caption_only",
    }),
    (error) => isOpenAiPermanentError(error),
    "A response missing required v2 evidence must fail validation without retrying.",
  );
  await assert.rejects(
    extractEventDataFromInstagramPost({
      caption: "Venue closure notice.",
      instagramPostUrl: "https://www.instagram.com/p/qa-non-event-reason/",
      instagramHandle: "qa_club",
      instagramPostTimestamp: "2026-08-11T10:00:00.000Z",
      extractionMode: "caption_only",
    }),
    (error) => isOpenAiPermanentError(error),
    "A non-event response without a reason must fail validation without retrying.",
  );
  assert.equal(responseNumber, 3, "Each QA extraction should make exactly one mocked transport.");
} finally {
  globalThis.fetch = originalFetch;
  if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAiKey;
  if (previousVisionModel === undefined) delete process.env.OPENAI_VISION_MODEL;
  else process.env.OPENAI_VISION_MODEL = previousVisionModel;
}

runSemanticNormalizationQa();

console.log("Event extraction contract QA passed.");
