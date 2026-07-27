import assert from "node:assert/strict";

import { isSensibleEventTitleForApproval } from "../lib/events/event-title-approval.ts";
import {
  areApprovedEventOccurrencesSemanticDuplicates,
  decideApprovedEventOccurrenceDuplicate,
} from "../lib/events/approved-event-duplicates.ts";
import { prepareEventsForInsert } from "../lib/pipeline/run-instagram-ingestion.ts";

const FIXED_NOW = new Date("2026-07-27T12:00:00.000Z");

function makePost({ caption, handle, postId, postedAt = "2026-07-26T10:00:00.000Z" }) {
  return {
    postId,
    caption,
    altText: null,
    imageUrl: "https://example.com/source.jpg",
    imageUrls: ["https://example.com/source.jpg"],
    postType: "image",
    locationName: null,
    instagramPostUrl: `https://www.instagram.com/p/${postId}/`,
    postedAt,
    username: handle,
  };
}

function makeFieldConfirmation(confidence = 0.95) {
  const entry = {
    confidence,
    found_in: ["caption"],
    evidence: "Source caption evidence",
    evidence_snippets: [{ source: "caption", text: "Source caption evidence" }],
    notes: "Source caption evidence.",
  };
  return {
    title: entry,
    location: entry,
    location_name: {
      ...entry,
      found_in: ["caption", "canonical_hint"],
    },
    price: { confidence: 0, found_in: [], evidence: "", evidence_snippets: [], notes: "" },
    start_time: entry,
    short_description: entry,
    artists: entry,
  };
}

function makeExtracted(overrides = {}) {
  return {
    title: "QA Event",
    date: "30.07.2026",
    time: "21:00",
    venue: "QA Venue",
    city: "Belgrade",
    country: "Serbia",
    price: "",
    currency: "",
    artists: [],
    category: "nightlife",
    description: "Source-grounded event.",
    confidence: 0.95,
    reasoning_notes: "Source-grounded event.",
    source_caption: "",
    source_url: "https://www.instagram.com/p/qa/",
    schedule_entries: [],
    field_confirmation: makeFieldConfirmation(),
    ...overrides,
  };
}

function prepare({ caption, extracted, handle, venue, postId, postedAt }) {
  return prepareEventsForInsert(
    makePost({ caption, handle, postId, postedAt }),
    extracted,
    "https://example.com/source.jpg",
    { [handle]: venue },
    {},
    { [handle]: venue },
    { eventDateFilterNow: FIXED_NOW },
  ).filter((result) => result.kind === "ok");
}

assert.equal(
  isSensibleEventTitleForApproval({ title: "A SOIREE OF MEANING", venue: "B3 Art Space" }),
  true,
  "A valid English title beginning with the article 'A' must not be rejected as a broken sentence.",
);

const producersCaption = `30. Jul • 21h

🎬 THE PRODUCERS (1968)

Treće filmsko veče u La Variété-u donosimo uz jedan od najduhovitijih filmskih klasika svih vremena.

🚪 Otvaramo u 20h
🎥 Projekcija počinje u 21h
🎟 Ulaz je slobodan.`;
const producers = prepare({
  caption: producersCaption,
  handle: "la_variete",
  postId: "calibration-producers",
  postedAt: "2026-07-26T10:37:20.000Z",
  venue: "La Variete",
  extracted: makeExtracted({
    title: "THE PRODUCERS (1968)",
    date: "30.07.2026",
    time: "21:00",
    venue: "La Variete",
    category: "arts & culture",
    description: "Projekcija filma THE PRODUCERS (1968).",
    source_caption: producersCaption,
    schedule_entries: [{
      date: "30.07.2026",
      time: "21:00",
      title: "THE PRODUCERS (1968)",
      artists: [],
      description: "Projekcija filma.",
      source_text: "30. Jul • 21h\n🎬 THE PRODUCERS (1968)",
    }],
  }),
});
assert.equal(producers.length, 1);
assert.equal(producers[0].event.status, "approved", "One date header plus one marked film row is a grounded occurrence.");

const auralCaption = "I ovog utorka - 28.07. - u Nassau - AURAL APOTHECARY pušta Post Punk, Dark Disco & Weird Folk!";
const aural = prepare({
  caption: auralCaption,
  handle: "nassau_bar",
  postId: "calibration-aural",
  venue: "Nassau Bar",
  extracted: makeExtracted({
    title: "Aural Apothecary",
    date: "28.07.2026",
    time: "21:00",
    venue: "Nassau Bar",
    artists: ["Aural Apothecary"],
    source_caption: auralCaption,
    schedule_entries: [{
      date: "28.07.2026",
      time: "21:00",
      title: "Aural Apothecary",
      artists: ["Aural Apothecary"],
      description: "Post Punk / Dark Disco / Weird Folk night.",
      source_text: "TUESDAY 21h\nAURAL APOTHECARY\nNASSAU",
    }],
  }),
});
assert.equal(aural.length, 1);
assert.equal(aural[0].event.status, "approved", "A locally billed artist, explicit date, and venue account establish an event.");
assert.equal(aural[0].event.time, "TBD", "A poster/model-only time must be demoted rather than published as sourced fact.");
const auralNormalized = JSON.parse(aural[0].event.normalizedFieldsJson);
assert.equal(auralNormalized.unsourcedTimeDemotedToTbd, true);
assert.equal(auralNormalized.sourceGroundingTimeVerified, null);
assert.ok(auralNormalized.moderationSignals.includes("unsourced_time_demoted_to_tbd"));

const inVitroCaption = `Pravo mesto za izlazak ove subote.

🗓 Subota, 01.08. | In Vitro Band

📱 061 2525 522
📍 Studentski trg 15`;
const inVitro = prepare({
  caption: inVitroCaption,
  handle: "santodomingodorcol",
  postId: "calibration-in-vitro",
  venue: "Santo Domingo Dorćol",
  extracted: makeExtracted({
    title: "",
    date: "",
    time: "",
    venue: "Santo Domingo Dorćol",
    artists: ["In Vitro Band"],
    category: "live music",
    description: "Live performance by In Vitro Band.",
    source_caption: inVitroCaption,
    schedule_entries: [{
      date: "01.08.2026",
      time: "",
      title: "In Vitro Band",
      artists: ["In Vitro Band"],
      description: "Live performance.",
      source_text: "🗓 Subota, 01.08. | In Vitro Band",
    }],
  }),
});
assert.deepEqual(
  inVitro.filter((result) => result.event.status === "approved").map((result) => result.event.title),
  ["In Vitro Band"],
  "Decorative date fragments must be removed from the one approved schedule-row title.",
);

const campaignCaption = "Najuzbudljivije Letnje Osveženje. Ovog leta osvoji nagrade uz naš novi proizvod. 13.08.2026.";
const campaign = prepare({
  caption: campaignCaption,
  handle: "campaign_brand",
  postId: "calibration-generic-campaign",
  venue: "Campaign Brand",
  extracted: makeExtracted({
    title: "Najuzbudljivije Letnje Osveženje",
    date: "13.08.2026",
    time: "",
    venue: "Campaign Brand",
    artists: [],
    source_caption: campaignCaption,
  }),
});
assert.equal(campaign[0].event.status, "pending", "A dated promotional campaign is not automatically an event.");

const unsupportedParticipationCaption = "Mimart Theatre participates in Sarajevo Film Festival this August. Follow us for details.";
const unsupportedParticipation = prepare({
  caption: unsupportedParticipationCaption,
  handle: "mimart_theatre",
  postId: "calibration-unsupported-participation",
  venue: "Mimart Theatre",
  extracted: makeExtracted({
    title: "Sarajevo Film Festival",
    date: "13.08.2026",
    time: "",
    venue: "Mimart Theatre",
    artists: ["Mimart Theatre"],
    source_caption: unsupportedParticipationCaption,
  }),
});
assert.equal(
  unsupportedParticipation[0].event.status,
  "pending",
  "Broad festival participation without a physical venue and day-specific occurrence stays pending.",
);

const multiDateCaption = `31.07. | Grof K.T.I
01.08. | Odopt`;
const multiDate = prepare({
  caption: multiDateCaption,
  handle: "qa_multi_date_venue",
  postId: "calibration-multi-date",
  venue: "QA Multi Date Venue",
  extracted: makeExtracted({
    title: "",
    date: "",
    time: "",
    venue: "QA Multi Date Venue",
    artists: [],
    source_caption: multiDateCaption,
    schedule_entries: [
      { date: "31.07.2026", time: "", title: "Grof K.T.I", artists: ["Grof K.T.I"], description: "Live performance.", source_text: "31.07. | Grof K.T.I" },
      { date: "01.08.2026", time: "", title: "Odopt", artists: ["Odopt"], description: "Live performance.", source_text: "01.08. | Odopt" },
    ],
  }),
});
assert.deepEqual(
  multiDate.map(({ event }) => [event.title, event.date, event.status]),
  [
    ["Grof K.T.I", "2026-07-31", "approved"],
    ["Odopt", "2026-08-01", "approved"],
  ],
  "Every independently grounded row in one source post remains a distinct auto-approved occurrence.",
);

const hashtagOnlyCaption = "30.07.2026 @ QA Venue #GhostAct";
const hashtagOnly = prepare({
  caption: hashtagOnlyCaption,
  handle: "qa_hashtag_venue",
  postId: "calibration-hashtag-only",
  venue: "QA Hashtag Venue",
  extracted: makeExtracted({
    title: "GhostAct",
    date: "30.07.2026",
    time: "",
    venue: "QA Hashtag Venue",
    artists: ["GhostAct"],
    source_caption: hashtagOnlyCaption,
  }),
});
assert.equal(hashtagOnly[0].event.status, "pending", "Hashtags alone never establish event identity.");

const splitEvidenceCaption = `QA Split Evidence announces a new project.
31.07.2026
Follow for details.`;
const splitEvidence = prepare({
  caption: splitEvidenceCaption,
  handle: "qa_split_evidence",
  postId: "calibration-split-evidence",
  venue: "QA Split Evidence Venue",
  extracted: makeExtracted({
    title: "QA Split Evidence",
    date: "31.07.2026",
    time: "",
    venue: "QA Split Evidence Venue",
    artists: [],
    source_caption: splitEvidenceCaption,
  }),
});
assert.equal(
  splitEvidence[0].event.status,
  "pending",
  "Identity and date from unrelated caption blocks must never be stitched into approval evidence.",
);

const sentenceLeakageCaption = "QA Leakage Artist releases a new single. QA Leakage Artist performs live. 31.07.2026.";
const sentenceLeakage = prepare({
  caption: sentenceLeakageCaption,
  handle: "qa_sentence_leakage",
  postId: "calibration-sentence-leakage",
  venue: "QA Sentence Leakage Venue",
  extracted: makeExtracted({
    title: "QA Leakage Artist",
    date: "31.07.2026",
    time: "",
    venue: "QA Sentence Leakage Venue",
    artists: ["QA Leakage Artist"],
    source_caption: sentenceLeakageCaption,
  }),
});
assert.equal(
  sentenceLeakage[0].event.status,
  "pending",
  "A performer cue and date in different sentences must not be composed into one occurrence.",
);

function duplicateRecord(overrides = {}) {
  return {
    id: "event-a",
    title: "Aural Apothecary",
    date: "2026-07-28",
    time: "TBD",
    venue: "Nassau Bar",
    artists: ["Aural Apothecary"],
    description: "Post punk night.",
    imageUrl: "https://example.com/source.jpg",
    instagramPostUrl: "https://www.instagram.com/p/source-a/",
    instagramPostId: "source-a",
    ticketPrice: null,
    eventType: "nightlife",
    sourceCaption: auralCaption,
    sourcePostedAt: "2026-07-26T10:00:00.000Z",
    normalizedFieldsJson: JSON.stringify({ normalizedDate: "2026-07-28" }),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

assert.equal(
  areApprovedEventOccurrencesSemanticDuplicates(
    duplicateRecord(),
    duplicateRecord({ id: "event-b", instagramPostId: "source-b", instagramPostUrl: "https://www.instagram.com/p/source-b/" }),
  ),
  true,
  "Same identity/date/venue occurrence is a duplicate even when reposted.",
);
assert.deepEqual(
  decideApprovedEventOccurrenceDuplicate(
    duplicateRecord(),
    duplicateRecord({ id: "event-reason-code", instagramPostId: "source-reason-code" }),
  ),
  { isDuplicate: true, reason: "semantic_duplicate" },
  "Duplicate policy returns a stable machine-readable reason code.",
);
assert.equal(
  areApprovedEventOccurrencesSemanticDuplicates(
    duplicateRecord({ artists: [], description: undefined, sourceCaption: undefined }),
    duplicateRecord({ id: "event-no-second-channel", artists: [], description: undefined, sourceCaption: undefined }),
  ),
  false,
  "A shared title/date/venue without an independent identity channel is not enough to prove duplication.",
);
assert.equal(
  areApprovedEventOccurrencesSemanticDuplicates(
    duplicateRecord(),
    duplicateRecord({
      id: "event-b",
      title: "Different Live Act",
      artists: ["Different Live Act"],
      time: "23:30",
      instagramPostId: "source-b",
      instagramPostUrl: "https://www.instagram.com/p/source-b/",
      sourceCaption: "Different Live Act at 23:30.",
    }),
  ),
  false,
  "Sharing only date and venue must not make a distinct occurrence a duplicate.",
);
assert.equal(
  areApprovedEventOccurrencesSemanticDuplicates(
    duplicateRecord({
      title: "QA Showcase Artist A",
      artists: ["QA Showcase Artist A"],
      description: undefined,
      sourceCaption: "QA Showcase Artist A performs.",
    }),
    duplicateRecord({
      id: "event-prefix-b",
      title: "QA Showcase Artist B",
      artists: ["QA Showcase Artist B"],
      description: undefined,
      sourceCaption: "QA Showcase Artist B performs.",
      instagramPostId: "source-prefix-b",
      instagramPostUrl: "https://www.instagram.com/p/source-prefix-b/",
    }),
  ),
  false,
  "Shared artist/title prefixes must not suppress distinct billed identities.",
);
assert.equal(
  areApprovedEventOccurrencesSemanticDuplicates(
    duplicateRecord({ normalizedFieldsJson: JSON.stringify({ normalizedDate: "2026-07-28", multiEventSplitDetected: true, multiEventSplitCount: 2, splitEventIndex: 0 }) }),
    duplicateRecord({
      id: "event-b",
      title: "Second Screening",
      date: "2026-07-29",
      artists: [],
      normalizedFieldsJson: JSON.stringify({ normalizedDate: "2026-07-29", multiEventSplitDetected: true, multiEventSplitCount: 2, splitEventIndex: 1 }),
    }),
  ),
  false,
  "Different dated occurrences from one post are never duplicates merely because they share a post.",
);

console.log("QA passed: future source-grounded event auto-approval calibration and semantic duplicate policy.");
