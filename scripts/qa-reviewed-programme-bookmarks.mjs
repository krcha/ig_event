import assert from "node:assert/strict";
import { getPublicApprovedEventHandler } from "../convex/eventDomain/publicReads.ts";
import {
  evaluateEventPublication,
  isEventPubliclyVisible,
} from "../convex/publicationPolicy.ts";

const alias = {
  _id: "hotel",
  status: "approved",
  reviewedDuplicateOf: "restaurant",
  publicationState: "publishable",
};
const canonical = {
  _id: "restaurant",
  status: "approved",
  reviewedSourceUpdate: { sourceEventId: "hotel" },
};
const events = new Map([
  ["hotel", alias],
  ["restaurant", canonical],
]);
const ctx = {
  db: {
    normalizeId: (_table, id) => id,
    get: async (id) => events.get(id) ?? null,
  },
};
const bookmark = { id: "hotel", followReviewedBookmark: true };
assert.equal(await isEventPubliclyVisible(ctx, alias), false);
assert.equal(
  (await evaluateEventPublication(ctx, alias)).reason,
  "reviewed_duplicate_represented",
);
assert.equal(await getPublicApprovedEventHandler(ctx, { id: "hotel" }), null);
for (const unsafe of [
  null,
  { ...canonical, status: "rejected" },
  { ...canonical, reviewedSourceUpdate: undefined },
  { ...canonical, reviewedDuplicateOf: "third" },
  { ...canonical, reviewedSourceUpdate: { sourceEventId: "another" } },
]) {
  events.set("restaurant", unsafe);
  assert.equal(await getPublicApprovedEventHandler(ctx, bookmark), null);
}
events.set("hotel", { ...alias, status: "pending" });
events.set("restaurant", canonical);
assert.equal(await getPublicApprovedEventHandler(ctx, bookmark), null);

const { sourceOccurrenceRepresentativeMatchesExpected, immutableSourceOccurrenceBindingsMatch } =
  await import("../lib/events/source-occurrence-representation.ts");
const pairs = [
  ["Кретање", "Kretanje", "2026-11-24", "20:00", "919a8b6da7fc05bb828968136a4471c577c83ed12d115462421885969b45222d", "d1178ee8fa94f5acec409fc06d65cd2015ccbfba2f9043db19e3f766568656fd"],
  ["Приватна прослава", "Privatna proslava", "2026-11-29", "18:30", "abd88fc286dcb1f10e6d1dfebc70a4830eca9d66e57873579185265159d45f8d", "bfa678bce4451eb3411ce0ce29d55ff8ceb821288734f1a8d45dd196b1520f2a"],
];
for (const [title, weeklyTitle, date, time, source, weekly] of pairs) {
  const snapshot = { title, normalizedDate: date, time, normalizedVenue: "Bitef teatar", artists: [] };
  const sourceOccurrenceKey = "instagram-occurrence-v2:" + source;
  const event = { title, date, time, venue: snapshot.normalizedVenue, artists: [], status: "approved", sourceOccurrenceKey, normalizedFieldsJson: JSON.stringify(snapshot) };
  const expected = { title: weeklyTitle, date, time, venue: event.venue, artists: [], key: "instagram-occurrence-v2:" + weekly };
  assert.equal(sourceOccurrenceRepresentativeMatchesExpected(event, expected), true);
  for (const other of [{time: "21:00"}, {date: "2026-11-30"}, {key: sourceOccurrenceKey}, {title: "Privatna"}, {artists: ["Gost"]}, {venue: "Druga scena"}]) {
    assert.equal(sourceOccurrenceRepresentativeMatchesExpected(event, {...expected, ...other}), false);
  }
  for (const other of [{status: "pending"}, {sourceOccurrenceKey: expected.key}, {normalizedFieldsJson: undefined}]) {
    assert.equal(sourceOccurrenceRepresentativeMatchesExpected({...event, ...other}, expected), false);
  }
  assert.equal(immutableSourceOccurrenceBindingsMatch(event, {...event, normalizedFieldsJson: JSON.stringify({...snapshot, title: weeklyTitle})}), false);
}
