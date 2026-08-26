import assert from "node:assert/strict";
import {
  buildApprovedCrossPostCampaignCohorts,
  runApprovedCrossPostCampaignAutoCoalescing,
} from "../lib/events/approved-cross-post-campaign-automerge.ts";
import {
  deriveAutomaticCrossPostCampaignIdentity,
  deriveExclusiveHashtagCrossPostCampaignIdentity,
  deriveCrossPostPromotionSharedEvidenceAnchors,
} from "../lib/events/cross-post-promotion-coalescing.ts";
import { runApprovedEventAutoMergeOnceForCompletedRun } from "../lib/events/approved-event-automerge.ts";

const serviceSecret = "qa-cross-post-auto-secret";
const targetVenue = {
  _id: "venue-kc-grad",
  name: "KC Grad",
  instagramHandle: "kcgrad",
  updatedAt: 700,
};

function event(index, overrides = {}) {
  const postId = `post-${index}`;
  const title = index === 0 ? "Ariana Grande Theme Party" : `Ariana promo ${index}`;
  const artists = index === 0 ? ["DJ Scala"] : [`Guest DJ ${index}`];
  const caption =
    `Petal album night at @kcgrad, 26 August from 20h. ` +
    `#arianagrande #petal slide${index}`;
  return {
    _id: `event-${index}`,
    title,
    date: "2099-08-26",
    time: "20:00",
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
    timeConfidence: 0.95,
    venue: "KC Grad",
    venueId: targetVenue._id,
    venueInstagramHandle: targetVenue.instagramHandle,
    artists,
    description: `Exact campaign slide ${index}`,
    ...(index === 0
      ? { imageUrl: "https://images.example/primary.jpg", imageStorageId: "storage-0" }
      : {}),
    instagramPostUrl: `https://www.instagram.com/p/auto${index}/`,
    instagramPostId: postId,
    eventType: "nightlife",
    sourceCaption: caption,
    sourcePostedAt: `2099-08-${String(20 + Math.min(index, 5)).padStart(2, "0")}T12:00:00.000Z`,
    normalizedFieldsJson: JSON.stringify({
      sourceGroundingInstagramHandle: "1by1.party",
      dateEvidenceVerified: true,
      timeEvidenceVerified: true,
      title,
      normalizedDate: "2099-08-26",
      time: "20:00",
      normalizedVenue: "KC Grad",
      artists,
    }),
    sourceOccurrenceKey: `occurrence-${index}`,
    sourceConflictFields: [],
    status: "approved",
    createdAt: 100 + index,
    updatedAt: 300 + index,
    ...overrides,
  };
}

function contextCandidate(sourceEvent, index) {
  return {
    event: structuredClone(sourceEvent),
    sourceLink: {
      _id: `link-${index}`,
      updatedAt: 400 + index,
      sourceIdentity: `source-identity-${index}`,
      sourceFingerprint: `source-fingerprint-${index}`,
      sourceOccurrenceKey: sourceEvent.sourceOccurrenceKey,
      sourceHandle: "1by1.party",
    },
    receipt: { _id: `receipt-${index}`, updatedAt: 500 + index },
  };
}

const exactAnchors = deriveCrossPostPromotionSharedEvidenceAnchors({
  captions: [event(0).sourceCaption, event(1).sourceCaption],
  sourceHandle: "1by1.party",
  canonicalVenueName: targetVenue.name,
  canonicalVenueHandle: targetVenue.instagramHandle,
});
assert.deepEqual(exactAnchors?.slice(0, 2), ["arianagrande", "petal"]);
assert.equal(
  deriveAutomaticCrossPostCampaignIdentity([
    event(0).sourceCaption,
    event(1).sourceCaption,
  ]),
  null,
);
assert.equal(
  deriveAutomaticCrossPostCampaignIdentity([
    "A https://tickets.example/events/ariana-petal-2099-08-26",
    "B https://tickets.example/events/ariana-petal-2099-08-26",
  ]),
  "https://tickets.example/events/ariana-petal-2099-08-26",
);

function historyPost(sourceEvent) {
  const fields = JSON.parse(sourceEvent.normalizedFieldsJson);
  return {
    handle: fields.sourceGroundingInstagramHandle,
    postId: sourceEvent.instagramPostId,
    caption: sourceEvent.sourceCaption,
    postedAt: sourceEvent.sourcePostedAt,
  };
}

const exactNoUrlCampaignIdentity = deriveExclusiveHashtagCrossPostCampaignIdentity({
  sourceHandle: "1by1.party",
  targetVenueId: targetVenue._id,
  date: "2099-08-26",
  time: "20:00",
  eventType: "nightlife",
  anchors: ["arianagrande", "petal"],
  candidatePostIds: [event(0), event(1), event(2)].map(
    (candidate) => candidate.instagramPostId,
  ),
  historyPosts: [event(0), event(1), event(2)].map(historyPost),
  historyComplete: true,
});
assert.match(
  exactNoUrlCampaignIdentity ?? "",
  /^instagram-exclusive-hashtag-campaign-v1:/,
);
assert.equal(
  deriveExclusiveHashtagCrossPostCampaignIdentity({
    sourceHandle: "1by1.party",
    targetVenueId: targetVenue._id,
    date: "2099-08-26",
    time: "20:00",
    eventType: "nightlife",
    anchors: ["arianagrande", "petal"],
    candidatePostIds: [event(0), event(1), event(2)].map(
      (candidate) => candidate.instagramPostId,
    ),
    historyPosts: [
      ...[event(0), event(1), event(2)].map(historyPost),
      {
        handle: "1by1.party",
        postId: "another-ariana-occurrence",
        caption: "Another date #arianagrande #petal",
        postedAt: "2099-08-10T12:00:00.000Z",
      },
    ],
    historyComplete: true,
  }),
  null,
  "A hashtag pair reused by another persisted source post must not identify one occurrence.",
);
assert.equal(
  deriveCrossPostPromotionSharedEvidenceAnchors({
    captions: [
      "Saturday party tonight at KC Grad, vidimo se 20h.",
      "Saturday party tonight at @kcgrad, vidimo se 20h.",
    ],
    sourceHandle: "1by1.party",
    canonicalVenueName: targetVenue.name,
    canonicalVenueHandle: targetVenue.instagramHandle,
  }),
  null,
  "Date, venue, and promotional boilerplate must not become campaign anchors.",
);
assert.equal(
  deriveCrossPostPromotionSharedEvidenceAnchors({
    captions: [
      "Techno Night Alpha with DJ Alpha at @kcgrad. Rezervacije putem linka.",
      "Jazz Concert Beta with Band Beta at @kcgrad. Rezervacije putem linka.",
    ],
    sourceHandle: "1by1.party",
    canonicalVenueName: targetVenue.name,
    canonicalVenueHandle: targetVenue.instagramHandle,
  }),
  null,
  "Repeated reservation boilerplate is not a durable cross-post campaign identifier.",
);
assert.equal(
  deriveCrossPostPromotionSharedEvidenceAnchors({
    captions: [
      "Techno Night Alpha at @kcgrad. #rezervacije #weekend",
      "Jazz Concert Beta at @kcgrad. #rezervacije #weekend",
    ],
    sourceHandle: "1by1.party",
    canonicalVenueName: targetVenue.name,
    canonicalVenueHandle: targetVenue.instagramHandle,
  }),
  null,
  "Generic hashtags are not durable cross-post campaign identifiers.",
);
for (const captions of [
  [
    "Techno Night Alpha at @kcgrad 20h. #belgradenightlife #electronicmusic",
    "House Night Beta at @kcgrad 20h. #belgradenightlife #electronicmusic",
    "Jazz Night Gamma at @kcgrad 20h. #belgradenightlife #electronicmusic",
  ],
  [
    "Jazz Program Alpha at @kcgrad 20h. #visitbelgrade #belgrademusic",
    "Techno Program Beta at @kcgrad 20h. #visitbelgrade #belgrademusic",
    "Theatre Program Gamma at @kcgrad 20h. #visitbelgrade #belgrademusic",
  ],
  [
    "Gallery Program Alpha at @kcgrad 20h. #summerprogram #kcgradculture",
    "Club Program Beta at @kcgrad 20h. #summerprogram #kcgradculture",
    "Workshop Program Gamma at @kcgrad 20h. #summerprogram #kcgradculture",
  ],
]) {
  assert.equal(
    deriveAutomaticCrossPostCampaignIdentity(captions),
    null,
    "Account-wide or series hashtags must not supply an occurrence-specific identity.",
  );
  const hashtagPair = [...captions[0].matchAll(/#([a-z]+)/giu)].map(
    (match) => match[1],
  );
  assert.equal(
    deriveExclusiveHashtagCrossPostCampaignIdentity({
      sourceHandle: "1by1.party",
      targetVenueId: targetVenue._id,
      date: "2099-08-26",
      time: "20:00",
      eventType: "nightlife",
      anchors: hashtagPair,
      candidatePostIds: ["generic-0", "generic-1", "generic-2"],
      historyPosts: captions.map((caption, index) => ({
        handle: "1by1.party",
        postId: `generic-${index}`,
        caption,
        postedAt: `2099-08-${20 + index}T12:00:00.000Z`,
      })),
      historyComplete: true,
    }),
    null,
    "Bounded history exclusivity must not promote generic city/category/series tags into occurrence identity.",
  );
}
for (const genericUrl of [
  "https://kcgrad.rs/events",
  "https://tickets.example/events",
  "https://venue.example/event-calendar",
  "https://kcgrad.rs/events/belgrade-nightlife",
  "https://tickets.example/events/summer-program-2026",
]) {
  assert.equal(
    deriveAutomaticCrossPostCampaignIdentity([
      `Techno Night Alpha ${genericUrl}`,
      `Jazz Concert Beta ${genericUrl}`,
    ]),
    null,
    "A generic event listing or calendar URL is not occurrence identity.",
  );
}

const positiveEvents = [event(0), event(1), event(2)];
const grouped = buildApprovedCrossPostCampaignCohorts(positiveEvents, {
  today: "2099-01-01",
});
assert.equal(grouped.cohorts.length, 1);
assert.deepEqual(
  grouped.cohorts[0].events.map((candidate) => candidate._id),
  ["event-0", "event-1", "event-2"],
  "The source-bound durable primary image must deterministically keep the first slot.",
);

const promoterVenue = {
  _id: "venue-promoter",
  name: "JEDNA PO JEDNA",
  instagramHandle: "1by1.party",
};
const exactLiveMixedVenueEvents = [
  event(0, {
    imageUrl: undefined,
    imageStorageId: undefined,
    artists: ["DJ Scala"],
    description: "Canonical target-bound keeper",
  }),
  event(1, {
    venueId: undefined,
    venue: "KC Gradu",
    imageUrl: "https://images.example/wrong-venue-stronger.jpg",
    imageStorageId: "wrong-venue-stronger-storage",
    artists: ["Guest 1", "Guest 2", "Guest 3", "Guest 4"],
    description: "A deliberately stronger wrong-venue candidate. ".repeat(20),
  }),
  event(2, {
    venueId: promoterVenue._id,
    venue: promoterVenue.name,
    venueInstagramHandle: promoterVenue.instagramHandle,
  }),
  event(3, {
    venueId: promoterVenue._id,
    venue: promoterVenue.name,
    venueInstagramHandle: promoterVenue.instagramHandle,
  }),
  event(4, { venueId: undefined, venue: "" }),
];
const exactLiveMixedVenueGroup = buildApprovedCrossPostCampaignCohorts(
  exactLiveMixedVenueEvents,
  {
    today: "2099-01-01",
    venues: [targetVenue, promoterVenue],
  },
);
assert.equal(exactLiveMixedVenueGroup.cohorts.length, 1);
assert.equal(exactLiveMixedVenueGroup.cohorts[0].targetVenueId, targetVenue._id);
assert.equal(
  exactLiveMixedVenueGroup.cohorts[0].events[0]._id,
  "event-0",
  "The primary must be the exact persisted canonical venue binding even when a repaired candidate has a much stronger image/artist score.",
);
assert.deepEqual(
  new Set(
    exactLiveMixedVenueGroup.cohorts[0].events.map((candidate) => candidate._id),
  ),
  new Set(exactLiveMixedVenueEvents.map((candidate) => candidate._id)),
  "Exact @kcgrad/KC Grad caption evidence must repair the cohort key without trusting promoter or missing venue IDs.",
);

const correctOtherVenue = {
  _id: "venue-other-correct",
  name: "Other Correct Venue",
  instagramHandle: "other.correct.venue",
};
const bareCollaboratorMention = buildApprovedCrossPostCampaignCohorts(
  [
    event(0),
    event(90, {
      venueId: correctOtherVenue._id,
      venue: correctOtherVenue.name,
      venueInstagramHandle: correctOtherVenue.instagramHandle,
      sourceCaption:
        "Special guest @kcgrad joins this separate program. #arianagrande #petal",
    }),
  ],
  {
    today: "2099-01-01",
    venues: [targetVenue, correctOtherVenue],
  },
);
assert.equal(
  bareCollaboratorMention.cohorts.length,
  0,
  "A bare collaborator @handle must not replace a different persisted canonical venue.",
);

const separated = buildApprovedCrossPostCampaignCohorts(
  [
    event(0),
    event(1, { time: "21:00" }),
    event(2, { venueId: "another-venue" }),
    event(3, {
      normalizedFieldsJson: JSON.stringify({
        ...JSON.parse(event(3).normalizedFieldsJson),
        sourceGroundingInstagramHandle: "another.promoter",
      }),
    }),
  ],
  { today: "2099-01-01" },
);
assert.equal(separated.cohorts.length, 0);

const oversized = buildApprovedCrossPostCampaignCohorts(
  Array.from({ length: 9 }, (_, index) => event(index)),
  { today: "2099-01-01" },
);
assert.equal(oversized.cohorts.length, 0);
assert.equal(oversized.skipped[0]?.reason, "campaign_cohort_exceeds_safe_bound");

function clientFor(events, options = {}) {
  const candidates = (options.contextEvents ?? events).map(contextCandidate);
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.event._id, candidate]),
  );
  const historyPosts = options.historyPosts ?? events.map(historyPost);
  let contextState = "ready";
  const calls = { list: 0, context: 0, mutation: 0, mutationArgs: [] };
  return {
    calls,
    client: {
      async query(reference, args) {
        if (reference === "events:listByStatusPaginated") {
          calls.list += 1;
          assert.equal(args.serviceSecret, serviceSecret);
          return { page: events, isDone: true, continueCursor: "" };
        }
        if (reference === "venues:listPublicVenueFields") {
          assert.equal(args.limit, 2_000);
          return [targetVenue];
        }
        if (reference === "events:getCrossPostPromotionCoalescingContext") {
          calls.context += 1;
          assert.equal(args.serviceSecret, serviceSecret);
          return {
            state: contextState,
            targetVenue,
            candidates: args.eventIds.map((eventId) => candidatesById.get(eventId)),
          };
        }
        if (reference === "scrapedPosts:listByHandlePaginated") {
          assert.equal(args.serviceSecret, serviceSecret);
          const matching = historyPosts.filter(
            (post) => post.handle === args.handle,
          );
          const start = args.paginationOpts.cursor
            ? Number(args.paginationOpts.cursor)
            : 0;
          const end = Math.min(
            matching.length,
            start + args.paginationOpts.numItems,
          );
          return {
            page: matching.slice(start, end),
            isDone: end >= matching.length,
            continueCursor: end >= matching.length ? "" : String(end),
          };
        }
        throw new Error(`Unexpected query: ${reference}`);
      },
      async mutation(reference, args) {
        assert.equal(reference, "events:coalesceApprovedCrossPostPromotionOccurrences");
        calls.mutation += 1;
        calls.mutationArgs.push(structuredClone(args));
        assert.equal(args.serviceSecret, serviceSecret);
        if (options.uncertainFirstMutation && calls.mutation === 1) {
          contextState = "already_coalesced";
          throw new Error("response lost after committed mutation");
        }
        contextState = "already_coalesced";
        return { foldedVariantIds: args.duplicates.map((candidate) => candidate.id) };
      },
    },
  };
}

const positive = clientFor(positiveEvents);
const positiveSummary = await runApprovedCrossPostCampaignAutoCoalescing(
  positive.client,
  { serviceSecret },
);
assert.equal(positiveSummary.coalescedGroupCount, 1);
assert.equal(positiveSummary.foldedVariantCount, 2);
assert.equal(positiveSummary.failedCount, 0);
assert.equal(positive.calls.mutation, 1);
assert.deepEqual(positive.calls.mutationArgs[0].sharedEvidenceAnchors.slice(0, 2), [
  "arianagrande",
  "petal",
]);
assert.deepEqual(positive.calls.mutationArgs[0].primary.id, "event-0");
assert.equal(
  positive.calls.mutationArgs[0].automaticCampaignIdentity,
  exactNoUrlCampaignIdentity,
);
assert.deepEqual(
  positive.calls.mutationArgs[0].duplicates.map((candidate) => candidate.id),
  ["event-1", "event-2"],
);
assert.match(positive.calls.mutationArgs[0].operationId, /^auto-cross-post-v1:[a-f0-9]{40}$/);

const exactLiveMixedVenueClient = clientFor(exactLiveMixedVenueEvents);
const exactLiveMixedVenueSummary =
  await runApprovedCrossPostCampaignAutoCoalescing(
    exactLiveMixedVenueClient.client,
    { serviceSecret },
  );
assert.equal(exactLiveMixedVenueClient.calls.mutation, 1);
assert.equal(exactLiveMixedVenueSummary.coalescedGroupCount, 1);
assert.equal(
  exactLiveMixedVenueClient.calls.mutationArgs[0].targetVenueId,
  targetVenue._id,
);
assert.equal(
  exactLiveMixedVenueClient.calls.mutationArgs[0].primary.id,
  "event-0",
  "The automatic mutation must receive the exact target-bound keeper, not the strongest repaired variant.",
);

const uncertain = clientFor(positiveEvents, { uncertainFirstMutation: true });
const uncertainSummary = await runApprovedCrossPostCampaignAutoCoalescing(
  uncertain.client,
  { serviceSecret },
);
assert.equal(uncertainSummary.alreadyCoalescedGroupCount, 1);
assert.equal(uncertainSummary.failedCount, 0);
assert.equal(uncertain.calls.mutation, 1);
assert.equal(uncertain.calls.context, 2);

const venueChangedAfterScan = clientFor(positiveEvents, {
  contextEvents: positiveEvents.map((candidate, index) =>
    index === 1 ? { ...candidate, venueId: "admin-corrected-venue" } : candidate,
  ),
});
const venueChangedSummary = await runApprovedCrossPostCampaignAutoCoalescing(
  venueChangedAfterScan.client,
  { serviceSecret },
);
assert.equal(venueChangedAfterScan.calls.mutation, 0);
assert.equal(venueChangedSummary.skippedGroupCount, 1);
assert.equal(
  venueChangedSummary.skipped[0]?.reason,
  "fresh_context_cohort_mismatch",
  "A fresh admin venue correction must never be overwritten using the stale scanned cohort.",
);

const priorAggregateAttestation = {
  policyVersion: 1,
  operationId: "auto-cross-post-v1:1111111111111111111111111111111111111111",
  primaryEventId: "event-0",
  targetVenueId: targetVenue._id,
  lineageDepth: 1,
  totalSourceCount: 3,
  campaignAnchors: ["arianagrande", "petal"],
  campaignPostIds: [event(0), event(1), event(2)].map(
    (candidate) => candidate.instagramPostId,
  ),
  automaticCampaignIdentity: exactNoUrlCampaignIdentity,
  publicBinding: {
    title: event(0).title,
    date: event(0).date,
    time: event(0).time,
    venue: targetVenue.name,
    artists: ["DJ Scala", "Guest DJ 1", "Guest DJ 2"],
  },
  sources: [event(0), event(1), event(2)].map((candidate, index) => ({
    eventId: candidate._id,
    eventUpdatedAt: 900 + index,
    sourceLinkId: `prior-link-${index}`,
    sourceLinkUpdatedAt: 800 + index,
    receiptId: `prior-receipt-${index}`,
    receiptUpdatedAt: 700 + index,
    sourceIdentity: `prior-source-${index}`,
    sourceFingerprint: `prior-fingerprint-${index}`,
    sourceOccurrenceKey: candidate.sourceOccurrenceKey,
    instagramPostId: candidate.instagramPostId,
    instagramPostUrl: candidate.instagramPostUrl,
    sourceHandle: "1by1.party",
  })),
};
const existingAggregateEvent = event(0, {
  artists: priorAggregateAttestation.publicBinding.artists,
  normalizedFieldsJson: JSON.stringify({
    ...JSON.parse(event(0).normalizedFieldsJson),
    crossPostCampaignAggregateAttestation: priorAggregateAttestation,
  }),
  updatedAt: 900,
});
const dayTwo = clientFor([event(3), existingAggregateEvent], {
  contextEvents: [existingAggregateEvent, event(3)],
  historyPosts: [event(0), event(1), event(2), event(3)].map(historyPost),
});
const dayTwoSummary = await runApprovedCrossPostCampaignAutoCoalescing(dayTwo.client, {
  serviceSecret,
});
assert.equal(dayTwoSummary.coalescedGroupCount, 1);
assert.equal(dayTwo.calls.mutation, 1);
assert.equal(dayTwo.calls.mutationArgs[0].primary.id, existingAggregateEvent._id);
assert.deepEqual(
  dayTwo.calls.mutationArgs[0].duplicates.map((candidate) => candidate.id),
  ["event-3"],
);
assert.deepEqual(dayTwo.calls.mutationArgs[0].sharedEvidenceAnchors, [
  "arianagrande",
  "petal",
]);

const differentThemeEvents = [
  event(0, {
    sourceCaption: "Ariana Grande Petal night at @kcgrad 26 August 20h. #arianagrande #petal",
  }),
  event(1, {
    sourceCaption: "Balkan Brass Orkestar at @kcgrad 26 August 20h. #balkanbrass #orkestar",
  }),
];
const differentTheme = clientFor(differentThemeEvents);
const differentThemeSummary = await runApprovedCrossPostCampaignAutoCoalescing(
  differentTheme.client,
  { serviceSecret },
);
assert.equal(differentTheme.calls.mutation, 0);
assert.equal(differentThemeSummary.coalescedGroupCount, 0);
assert.equal(differentThemeSummary.skippedGroupCount, 1);
assert.equal(
  differentThemeSummary.skipped[0]?.reason,
  "shared_campaign_proof_insufficient",
);

const sharedBoilerplateEvents = [
  event(0, {
    title: "Techno Night Alpha",
    artists: ["DJ Alpha"],
    sourceCaption:
      "Techno Night Alpha with DJ Alpha at @kcgrad 26 August 20h. Rezervacije putem linka.",
  }),
  event(1, {
    title: "Jazz Concert Beta",
    artists: ["Band Beta"],
    sourceCaption:
      "Jazz Concert Beta with Band Beta at @kcgrad 26 August 20h. Rezervacije putem linka.",
  }),
];
const sharedBoilerplate = clientFor(sharedBoilerplateEvents);
const sharedBoilerplateSummary = await runApprovedCrossPostCampaignAutoCoalescing(
  sharedBoilerplate.client,
  { serviceSecret },
);
assert.equal(sharedBoilerplate.calls.mutation, 0);
assert.equal(sharedBoilerplateSummary.coalescedGroupCount, 0);
assert.equal(sharedBoilerplateSummary.skippedGroupCount, 1);
assert.equal(
  sharedBoilerplateSummary.skipped[0]?.reason,
  "shared_campaign_proof_insufficient",
);

for (const [firstTag, secondTag] of [
  ["belgradenightlife", "electronicmusic"],
  ["visitbelgrade", "belgrademusic"],
  ["summerprogram", "kcgradculture"],
]) {
  const genericSeriesEvents = [0, 1, 2].map((index) =>
    event(200 + index, {
      title: `Distinct simultaneous program ${index}`,
      artists: [`Distinct Artist ${index}`],
      sourceCaption:
        `Distinct simultaneous program ${index} at @kcgrad. ` +
        `#${firstTag} #${secondTag}`,
    }),
  );
  const genericSeries = clientFor(genericSeriesEvents);
  const genericSeriesSummary = await runApprovedCrossPostCampaignAutoCoalescing(
    genericSeries.client,
    { serviceSecret },
  );
  assert.equal(genericSeries.calls.mutation, 0);
  assert.equal(genericSeriesSummary.coalescedGroupCount, 0);
  assert.equal(genericSeriesSummary.skippedGroupCount, 1);
}

const invalidLeadingEvents = Array.from({ length: 32 }, (_, cohortIndex) =>
  [0, 1].map((variantIndex) => {
    const index = 1_000 + cohortIndex * 2 + variantIndex;
    const sourceHandle = `00-invalid-${String(cohortIndex).padStart(2, "0")}`;
    const base = event(index);
    return {
      ...base,
      sourceCaption:
        `Unrelated same-slot item ${cohortIndex}-${variantIndex} at KC Grad. ` +
        "#belgradenightlife #electronicmusic",
      normalizedFieldsJson: JSON.stringify({
        ...JSON.parse(base.normalizedFieldsJson),
        sourceGroundingInstagramHandle: sourceHandle,
      }),
    };
  }),
).flat();
const trailingValid = clientFor([
  ...invalidLeadingEvents,
  event(0),
  event(1),
  event(2),
]);
const trailingValidSummary = await runApprovedCrossPostCampaignAutoCoalescing(
  trailingValid.client,
  { serviceSecret },
);
assert.equal(trailingValidSummary.candidateGroupCount, 33);
assert.equal(trailingValid.calls.mutation, 1);
assert.equal(trailingValidSummary.coalescedGroupCount, 1);
assert.equal(
  trailingValidSummary.skipped.filter(
    (item) => item.reason === "shared_campaign_proof_insufficient",
  ).length,
  32,
  "Proof-ineligible leading cohorts must not consume the bounded mutation budget or starve a later valid cohort.",
);

{
  const integration = clientFor(positiveEvents);
  const baseQuery = integration.client.query.bind(integration.client);
  let approvedListCalls = 0;
  integration.client.query = async (reference, args) => {
    if (reference === "events:listByStatusPaginated") {
      approvedListCalls += 1;
      if (approvedListCalls === 1) {
        return { page: [], isDone: true, continueCursor: "" };
      }
    }
    return baseQuery(reference, args);
  };
  const first = await runApprovedEventAutoMergeOnceForCompletedRun(
    integration.client,
    {
      runId: "qa-completed-run-cross-post-campaign",
      serviceSecret,
    },
  );
  const replay = await runApprovedEventAutoMergeOnceForCompletedRun(
    integration.client,
    {
      runId: "qa-completed-run-cross-post-campaign",
      serviceSecret,
    },
  );
  assert.equal(first.crossPostCampaignCoalescing?.coalescedGroupCount, 1);
  assert.equal(replay.crossPostCampaignCoalescing?.coalescedGroupCount, 1);
  assert.equal(approvedListCalls, 2);
  assert.equal(
    integration.calls.mutation,
    1,
    "The completed-run single-flight must own both strict cleanup and the campaign sweep.",
  );
}

console.log(
  "Approved cross-post campaign automerge QA passed: completed-run cohorts require exact source/venue/date/reliable-time identity plus two deterministic shared campaign hashtags, distinct artists aggregate through the existing mutation, uncertain responses read back idempotently, and different themes or shared boilerplate remain public as separate events.",
);
