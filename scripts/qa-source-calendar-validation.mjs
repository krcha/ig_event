import assert from "node:assert/strict";
// Use the supported entrypoint's import order (date parsing has existing cycles).
import "../convex/events.ts";
import { parseExtractedEventData } from "../lib/ai/extract-event-data.ts";
import { prepareEventsForInsert } from "../lib/pipeline/run-instagram-ingestion.ts";
import { sourceCalendarSupportsDate } from "../lib/pipeline/ingestion/source-calendar-validation.ts";
import { isVerifiedDateEvidence, isVerifiedTimeEvidence } from "../lib/pipeline/ingestion/structured-fact-verification.ts";

const postedAt = "2026-09-30T12:00:00.000Z";
const cases = [
  ["OCTOBER26\nSunday - 10.11.2026.", "2026-10-11", true],
  ["OCTOBER26\nSunday - 10.11.2026.", "2026-11-10", false],
  ["Sunday - 10.11.2026.", "2026-11-10", false],
  ["Sunday - 10.11.2026.", "2026-10-11", false], // weekday alone does not establish MM.DD
  ["10.18.2026", "2026-10-18", true],
  ["OCTOBER26\nSunday - 10.18.2026.", "2026-10-18", true],
  ["October 2026\nSunday - 10.04.2026.", "2026-10-04", true],
  ["SUBOTA 18.10.", "2026-10-18", false],
  ["18.10. SUBOTA", "2026-10-18", false],
  ["18.10.2026. Saturday", "2026-10-18", false],
  ["18.10. (Saturday)", "2026-10-18", false],
  ["18.10.2026. Sunday", "2026-10-18", true],
  ["UTORAK 29.10.", "2026-10-29", false],
  ["NEDELJA 18.10.", "2026-10-18", true],
  ["\u0421\u0423\u0411\u041e\u0422\u0410 18.10.", "2026-10-18", false],
  ["Saturday 17 October 2026", "2026-10-17", true],
  ["Sunday 17 October 2026", "2026-10-17", false],
  ["2026-10-17", "2026-10-17", true],
  ["Saturday 2026-10-17", "2026-10-17", true],
  ["Sunday 2026-10-17", "2026-10-17", false],
  ["16/10/2026", "2026-10-16", true],
  ["10-11 October 2026", "2026-10-10", true],
  ["10-11 October 2026", "2026-10-11", true],
  ["Friday 10-11 October 2026", "2026-10-10", false],
  ["Saturday 10-11 October 2026", "2026-10-11", true],
  ["tomorrow", "2026-10-01", true],
  ["11.10.", "2026-10-11", true],
  ["10.11.", "2026-11-10", true], // established day-first order without contrary calendar context
];
for (const [exactText, resolvedDate, expected] of cases) {
  assert.equal(sourceCalendarSupportsDate({ exactText, resolvedDate, postedAt }), expected, `${exactText} -> ${resolvedDate}`);
}
assert.equal(sourceCalendarSupportsDate({ exactText: "10.11.2026", context: "OCTOBER26\nSunday - 10.11.2026", resolvedDate: "2026-10-11", postedAt }), true);
assert.equal(sourceCalendarSupportsDate({ exactText: "18.10.", context: "SUBOTA 18.10. 22h", resolvedDate: "2026-10-18", postedAt }), false);
assert.equal(sourceCalendarSupportsDate({ exactText: "18.10.", context: "18.10. DJ Sunday\nFriday 16.10. another event", resolvedDate: "2026-10-18", postedAt }), true);
assert.equal(sourceCalendarSupportsDate({ exactText: "18.10.", context: "Tuesday 13.10. one event\nSunday 18.10. second event", resolvedDate: "2026-10-18", postedAt }), true);

const post = { caption: "SUBOTA 18.10.", altText: null, postedAt, username: "prorock", postId: "real-prorock", instagramPostUrl: "https://instagram.com/p/real-prorock/", imageUrl: "https://example.com/poster.jpg", imageUrls: [], postType: "image", locationName: null };
const evidence = { exact_text: post.caption, source: "caption", resolved_date: "2026-10-18", is_relative: false };
assert.equal(isVerifiedDateEvidence({ evidence, post, resolvedDate: evidence.resolved_date, hasPoster: true }), true, "Cached v2 interpretation must stay unchanged");
assert.equal(isVerifiedDateEvidence({ evidence, post, resolvedDate: evidence.resolved_date, hasPoster: true, enforceCalendarConsistency: true }), false, "New analyses must hold contradictory source weekdays");
assert.equal(isVerifiedDateEvidence({ evidence: { ...evidence, exact_text: "NEDELJA 18.10." }, post, resolvedDate: evidence.resolved_date, hasPoster: true, enforceCalendarConsistency: true }), false, "Correct calendar wording cannot bypass exact caption binding");
const sessionPost = { ...post, caption: "10. oktobar 2026. u 13 i 15 sati. Dina Pavić." };
const sessionOptions = {
  evidence: { status: "start_time_stated", exact_text: sessionPost.caption, source: "caption" },
  post: sessionPost,
  hasPoster: false,
  allowSessionClockList: true,
};
for (const [resolvedStartTime, expected] of [["13:00", true], ["15:00", true], ["14:00", false], ["13:00-15:00", false]]) {
  assert.equal(isVerifiedTimeEvidence({ ...sessionOptions, resolvedStartTime }), expected, `Session clock list: ${resolvedStartTime}`);
}
assert.equal(isVerifiedTimeEvidence({ ...sessionOptions, resolvedStartTime: "13:00", allowSessionClockList: false }), false, "Legacy multi-clock evidence remains ambiguous");
assert.equal(isVerifiedTimeEvidence({ ...sessionOptions, resolvedStartTime: "15:00", evidence: { ...sessionOptions.evidence, exact_text: "u 13 i 16 sati" } }), false, "Invented clock list cannot bypass source binding");
const doorText = "doors at 13 and 15 hours";
assert.equal(isVerifiedTimeEvidence({ ...sessionOptions, resolvedStartTime: "15:00", post: { ...sessionPost, caption: doorText }, evidence: { ...sessionOptions.evidence, exact_text: doorText } }), false, "Door clocks cannot become performance clocks");
const entranceText = "Ulaz u 13 i 15 sati";
assert.equal(isVerifiedTimeEvidence({ ...sessionOptions, resolvedStartTime: "15:00", post: { ...sessionPost, caption: entranceText }, evidence: { ...sessionOptions.evidence, exact_text: entranceText } }), false, "Entrance clocks cannot become performance sessions");
const freeAdmissionText = "Ulaz besplatan. Stručna vođenja u 13 i 15 sati.";
assert.equal(isVerifiedTimeEvidence({ ...sessionOptions, resolvedStartTime: "15:00", post: { ...sessionPost, caption: freeAdmissionText }, evidence: { ...sessionOptions.evidence, exact_text: freeAdmissionText } }), true, "Admission terms must not hide an explicitly separate performance clock list");

// Para Klub printed its October Sundays as MM.DD. The legacy row's date used
// 10.11 while its immutable evidence correctly resolved October 11. Exercise
// normalization too: independently interpreting that number as November 10
// must never turn it into an approved future event.
const paraImage = "https://example.com/qa-para-calendar.jpg";
const paraPost = {
  ...post, caption: "Cekali smo oktobar.", username: "para_klub",
  postId: "qa-para-calendar", instagramPostUrl: "https://www.instagram.com/p/qa-para-calendar/",
  imageUrl: paraImage, imageUrls: [paraImage],
};
const paraRow = (date, printedDate, title, resolvedDate = date, heading = "") => ({
  date, time: "06:00-22:00", venue: "Para klub Beograd", title, artists: [], description: "",
  source_text: `${heading}${printedDate} 06:00-22:00 ${title}`,
  date_evidence: { exact_text: printedDate, source: "poster", is_relative: false, resolved_date: resolvedDate },
  time_evidence: { status: "start_time_stated", exact_text: "06:00-22:00", source: "poster" },
});
function prepareParaSchedule(rows) {
  const extracted = parseExtractedEventData({
    extraction_contract_version: "event_evidence_v2", _extractionPolicyVersion: "event_quality_v1",
    is_event: true, non_event_reason: "", title: "", date: "", time: "", venue: "Para klub Beograd",
    city: "", country: "", price: "", currency: "", artists: [], category: "nightlife", description: "",
    confidence: 0.95, reasoning_notes: "Para Klub October Sundays schedule.",
    source_caption: paraPost.caption, source_url: paraPost.instagramPostUrl,
    date_evidence: { exact_text: "", source: "unknown", is_relative: false, resolved_date: "" },
    time_evidence: { status: "not_stated", exact_text: "", source: "unknown" }, source_conflicts: [],
    shared_schedule_context: {
      venue: { applies_to_all: true, value: "Para klub Beograd", evidence: "Para klub Beograd", source: "poster" },
      time: { applies_to_all: false, value: "", evidence: "", source: "unknown" },
    },
    schedule_entries: rows,
    field_confirmation: Object.fromEntries(
      ["title", "location", "location_name", "price", "start_time", "short_description", "artists"].map(
        (field) => [field, { confidence: 0, found_in: [], evidence: "", evidence_snippets: [], notes: "" }],
      ),
    ),
  });
  const venues = { para_klub: "Para klub Beograd" };
  return prepareEventsForInsert(paraPost, extracted, paraImage, venues, {}, venues, {
    eventDateFilterNow: new Date("2026-10-01T12:00:00.000Z"), sourceRolesByHandle: { para_klub: "venue" },
  });
}
const [falseFuturePara] = prepareParaSchedule([
  paraRow("10.11.2026", "Sunday - 10.11.2026.", "MRAK AFTERPARTY", "2026-10-11"),
]);
assert.equal(falseFuturePara.kind, "ok");
assert.equal(falseFuturePara.event.date, "2026-11-10");
assert.equal(falseFuturePara.event.status, "pending", "An inconsistent source weekday must hold a false future occurrence.");
assert.equal(falseFuturePara.normalizedFields.dateEvidenceVerified, false);
assert.ok(falseFuturePara.normalizedFields.moderationPendingReasons.includes("invalid_date_evidence"));
assert.equal(JSON.parse(falseFuturePara.event.rawExtractionJson).schedule_entries[0].date_evidence.resolved_date, "2026-10-11",
  "Holding a contradictory normalized occurrence must preserve its immutable original date evidence.");
const supportedParaDays = prepareParaSchedule([
  paraRow("2026-10-11", "Sunday - 10.11.2026.", "MRAK AFTERPARTY", "2026-10-11", "OCTOBER26\n"),
  paraRow("2026-10-18", "Sunday - 10.18.2026.", "ALTEREGO", "2026-10-18", "OCTOBER26\n"),
]);
assert.deepEqual(supportedParaDays.map((result) => [result.kind, result.event?.date, result.event?.status]), [
  ["ok", "2026-10-11", "approved"], ["ok", "2026-10-18", "approved"],
], "A source-bound month heading with consistent Sunday rows must preserve both genuine dates.");

console.log(`Source calendar validation passed (${cases.length + 23} date, session, scope, binding and cached-compatibility checks).`);
