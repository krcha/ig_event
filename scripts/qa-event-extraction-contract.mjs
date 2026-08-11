import assert from "node:assert/strict";
import {
  extractEventDataFromInstagramPost,
  isOpenAiPermanentError,
  parseExtractedEventData,
} from "../lib/ai/extract-event-data.ts";
import { TBD_EVENT_TIME } from "../lib/events/event-time.ts";
import {
  assertServiceUpdateEventPolicy,
  hasEventEvidenceV2AutoApproval,
} from "../lib/events/event-update-precondition.ts";
import { prepareEventsForInsert } from "../lib/pipeline/run-instagram-ingestion.ts";

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
    });
    const prepared = assertSingleOk(prepare(post, extracted), "missing time");
    assert.equal(prepared.event.status, "approved");
    assert.equal(prepared.event.time, TBD_EVENT_TIME);
    assert.equal(prepared.event.timeEvidenceKind, "not_stated");
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
  assert.equal(request.max_output_tokens, 4096);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.name, "nightlife_event_extraction");
  assert.ok(
    request.input[1].content.some((item) => item.type === "input_image"),
    "The Responses API request should retain poster image input.",
  );

  const schema = request.text.format.schema;
  assert.equal(schema.additionalProperties, false);
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
