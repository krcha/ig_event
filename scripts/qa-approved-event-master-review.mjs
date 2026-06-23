import assert from "node:assert/strict";
import {
  normalizeApprovedEventMasterReviewPayload,
} from "../lib/ai/review-approved-events.ts";

function makeEvent(id, overrides = {}) {
  return {
    id,
    title: `Event ${id}`,
    date: "2099-06-26",
    time: "22:00",
    venue: "QA Venue",
    artists: [`Artist ${id}`],
    description: `Description ${id}`,
    imageUrl: `https://images.example.com/${id}.jpg`,
    instagramPostUrl: `https://instagram.com/p/${id}/`,
    ticketPrice: null,
    eventType: "nightlife",
    sourceCaption: `Caption ${id}`,
    sourcePostedAt: "2099-06-20T10:00:00.000Z",
    normalizedFieldsJson: JSON.stringify({
      normalizedDate: "2099-06-26",
      normalizedVenue: "QA Venue",
      splitEventIndex: 1,
      splitEventTotal: 1,
    }),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeGroup(groupId, ids) {
  return {
    groupId,
    eventIds: ids,
    events: ids.map((id) => makeEvent(id)),
  };
}

function makePatch(overrides = {}) {
  return {
    title: " Primary Event ",
    date: "2099-06-26",
    time: "22:00",
    venue: "QA Venue",
    artists: ["DJ One", "DJ One", "DJ Two", ""],
    description: "Better description.",
    ticketPrice: "",
    eventType: "nightlife",
    imageUrl: "https://images.example.com/primary.jpg",
    ...overrides,
  };
}

function makePayload(overrides = {}) {
  return {
    overview: "QA review.",
    review_groups: [],
    skipped_groups: [],
    ...overrides,
  };
}

const actionable = normalizeApprovedEventMasterReviewPayload({
  candidateGroups: [makeGroup("candidate_1", ["a", "b"])],
  payload: makePayload({
    review_groups: [
      {
        group_id: "candidate_1",
        confidence: "1.4",
        reasoning: "Same date, venue, and source evidence.",
        recommended_action: "merge_delete",
        primary_event_id: "a",
        duplicate_event_ids: ["b"],
        primary_patch: makePatch(),
      },
    ],
  }),
});
assert.equal(actionable.reviewGroups.length, 1);
assert.equal(actionable.skippedGroups.length, 0);
assert.equal(actionable.reviewGroups[0].confidence, 1);
assert.equal(actionable.reviewGroups[0].primaryPatch.title, "Primary Event");
assert.deepEqual(actionable.reviewGroups[0].primaryPatch.artists, ["DJ One", "DJ Two"]);

const skipped = normalizeApprovedEventMasterReviewPayload({
  candidateGroups: [makeGroup("candidate_2", ["c", "d"])],
  payload: makePayload({
    skipped_groups: [
      {
        group_id: "candidate_2",
        reason_code: "different_artists",
        reasoning: "Same venue and date, but different billed acts.",
        candidate_event_ids: ["c", "d"],
      },
    ],
  }),
});
assert.equal(skipped.reviewGroups.length, 0);
assert.equal(skipped.skippedGroups.length, 1);
assert.equal(skipped.skippedGroups[0].reasonCode, "different_artists");
assert.deepEqual(skipped.skippedGroups[0].candidateEventIds, ["c", "d"]);

const omitted = normalizeApprovedEventMasterReviewPayload({
  candidateGroups: [makeGroup("candidate_3", ["e", "f"])],
  payload: makePayload(),
});
assert.equal(omitted.reviewGroups.length, 0);
assert.equal(omitted.skippedGroups.length, 1);
assert.equal(omitted.skippedGroups[0].reasonCode, "not_returned_by_model");

const invalidDuplicate = normalizeApprovedEventMasterReviewPayload({
  candidateGroups: [makeGroup("candidate_4", ["g", "h"])],
  payload: makePayload({
    review_groups: [
      {
        group_id: "candidate_4",
        confidence: 0.95,
        reasoning: "References an outsider id.",
        recommended_action: "delete_only",
        primary_event_id: "g",
        duplicate_event_ids: ["outsider"],
        primary_patch: makePatch(),
      },
    ],
  }),
});
assert.equal(invalidDuplicate.reviewGroups.length, 0);
assert.equal(invalidDuplicate.skippedGroups.length, 1);
assert.equal(invalidDuplicate.skippedGroups[0].reasonCode, "invalid_ai_action");

const primaryEqualsDuplicate = normalizeApprovedEventMasterReviewPayload({
  candidateGroups: [makeGroup("candidate_5", ["i", "j"])],
  payload: makePayload({
    review_groups: [
      {
        group_id: "candidate_5",
        confidence: 0.95,
        reasoning: "Primary equals duplicate.",
        recommended_action: "delete_only",
        primary_event_id: "i",
        duplicate_event_ids: ["i"],
        primary_patch: makePatch(),
      },
    ],
  }),
});
assert.equal(primaryEqualsDuplicate.reviewGroups.length, 0);
assert.equal(primaryEqualsDuplicate.skippedGroups.length, 1);
assert.equal(primaryEqualsDuplicate.skippedGroups[0].reasonCode, "invalid_ai_action");

const mixed = normalizeApprovedEventMasterReviewPayload({
  candidateGroups: [
    makeGroup("candidate_6", ["k", "l"]),
    makeGroup("candidate_7", ["m", "n"]),
  ],
  payload: makePayload({
    review_groups: [
      {
        group_id: "candidate_6",
        confidence: 0.94,
        reasoning: "Clear duplicate repost.",
        recommended_action: "merge_delete",
        primary_event_id: "k",
        duplicate_event_ids: ["l"],
        primary_patch: makePatch(),
      },
    ],
    skipped_groups: [
      {
        group_id: "candidate_7",
        reason_code: "same_night_different_event",
        reasoning: "Same venue and date, but separate split-row events.",
        candidate_event_ids: ["m", "n"],
      },
    ],
  }),
});
assert.equal(mixed.reviewGroups.length, 1);
assert.equal(mixed.skippedGroups.length, 1);
assert.equal(mixed.skippedGroups[0].reasonCode, "same_night_different_event");

console.log("QA passed: approved-event master review normalizes actions and skipped groups.");
