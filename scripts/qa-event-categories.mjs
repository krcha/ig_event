import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EVENT_PRIMARY_CATEGORIES,
  getEventPrimaryCategory,
  getEventTags,
  getHiddenCategoriesAfterCategoryToggle,
  normalizeEventCategoryKey,
  normalizeHiddenEventCategories,
} from "../lib/taxonomy/event-categories.ts";
import { buildCalendarFilterUrl } from "../lib/events/calendar-filter-url.ts";

assert.deepEqual(
  EVENT_PRIMARY_CATEGORIES,
  [
    { key: "club", label: "Zurke" },
    { key: "live", label: "Live music" },
    { key: "culture", label: "Kultura" },
    { key: "social", label: "Barovi" },
    { key: "event", label: "Ostalo" },
  ],
  "Public browsing should have five primary categories with workshops grouped under Ostalo.",
);

const categoryKeys = new Set(EVENT_PRIMARY_CATEGORIES.map(({ key }) => key));
const orderedCategoryKeys = [...categoryKeys];

assert.equal(normalizeEventCategoryKey("experience"), "event",
  "Historical workshop category keys should resolve to Ostalo.");
assert.equal(normalizeEventCategoryKey("unknown"), undefined);
assert.deepEqual(normalizeHiddenEventCategories([" experience ", "event", "club", "unknown"]), ["club", "event"],
  "Historical workshop filters should use the combined category without duplicates.");
assert.deepEqual(normalizeHiddenEventCategories(["club", "live", "culture", "social", "experience"]),
  ["club", "live", "culture", "social"],
  "An old Ostalo-only link should retain the combined Ostalo selection.");
assert.deepEqual(normalizeHiddenEventCategories(["club", "live", "culture", "social", "event"]),
  ["club", "live", "culture", "social"],
  "An old Radionice-only link should retain the combined Ostalo selection.");

for (const selected of orderedCategoryKeys) {
  const hidden = getHiddenCategoriesAfterCategoryToggle([], selected);
  assert.deepEqual(hidden, orderedCategoryKeys.filter((key) => key !== selected),
    `Choosing ${selected} from All should show only that category.`);
  assert.deepEqual(getHiddenCategoriesAfterCategoryToggle(hidden, selected), [],
    "Clicking the only selected category should reset All.");
  const added = orderedCategoryKeys.find((key) => key !== selected);
  const next = getHiddenCategoriesAfterCategoryToggle(hidden, added);
  assert.deepEqual(next, orderedCategoryKeys.filter((key) => key !== selected && key !== added),
    "An inactive category should join the current selection.");
  assert.deepEqual(getHiddenCategoriesAfterCategoryToggle(next, added), hidden,
    "An active category in a multiple selection should be removable.");
}

const preservedFilterUrl = new URL(buildCalendarFilterUrl(
  "/",
  [["q", " jazz "], ["venue", ""], ["sort", "time"]],
  "https://eventzeka.com/?hide=club,culture&open=now&upcomingOpenNow=1&month=2026-10&day=2026-10-17&venue=Dim&category=live",
), "https://eventzeka.com");
assert.equal(preservedFilterUrl.searchParams.get("upcomingOpenNow"), "1",
  "Applying another filter should preserve Open now.");
assert.equal(preservedFilterUrl.searchParams.get("open"), "now",
  "Applying another filter should preserve the public Open now query.");
assert.equal(preservedFilterUrl.searchParams.get("hide"), "club,culture",
  "Applying another filter should preserve the category selection.");
assert.equal(preservedFilterUrl.searchParams.get("day"), "2026-10-17");
assert.equal(preservedFilterUrl.searchParams.get("month"), "2026-10");
assert.equal(preservedFilterUrl.searchParams.get("q"), "jazz");
assert.equal(preservedFilterUrl.searchParams.get("sort"), "time");
assert.equal(preservedFilterUrl.searchParams.has("venue"), false,
  "An explicitly cleared form field should remove its old query value.");
assert.equal(preservedFilterUrl.searchParams.has("category"), false,
  "The obsolete include-only category query should not override hide filters.");
assert.equal(buildCalendarFilterUrl("/", [["q", ""]]), "/");

function makeEvent(overrides = {}) {
  return { eventType: "event", title: "Program", artists: [], ...overrides };
}

const categoryFixtures = [
  ["legacy club type", { eventType: "nightlife" }, "club"],
  ["legacy live type", { eventType: "live music" }, "live"],
  ["legacy culture type", { eventType: "arts & culture" }, "culture"],
  ["legacy learning type", { eventType: "learning" }, "event"],
  ["legacy Club alias", { eventType: "Club" }, "club"],
  ["legacy Culture alias", { eventType: "Culture" }, "culture"],
  ["legacy Live alias", { eventType: "Live" }, "live"],
  ["legacy Music alias", { eventType: "Music" }, "live"],
  ["social primary alias", { eventType: "social" }, "social"],
  ["experience primary alias", { eventType: "experience" }, "event"],
  ["short party label", { eventType: "Zurke" }, "club"],
  ["short culture label", { eventType: "Kultura" }, "culture"],
  ["legacy party label", { eventType: "Clubbing & DJ" }, "club"],
  ["legacy culture label", { eventType: "Kultura & umetnost" }, "culture"],
  ["short bar label", { eventType: "Barovi" }, "social"],
  ["short workshop label", { eventType: "Radionice" }, "event"],
  ["short other label", { eventType: "Ostalo" }, "event"],
  ["legacy bar label", { eventType: "Barovi & social" }, "social"],
  ["legacy workshop label", { eventType: "Radionice & iskustva" }, "event"],
  ["legacy other label", { eventType: "Ostalo & specijalni doga\u0111aji" }, "event"],
  ["unclassified event", {}, "event"],
  ["concert in a club", { title: "Rock koncert", eventType: "nightlife", venueCategory: "club" }, "live"],
  ["jazz ensemble with explicit live type", { title: "Vladimir \u010cetkar Ensemble", eventType: "live music", venueCategory: "club" }, "live"],
  ["tribute concert", { title: "David Bowie Tribute koncert", eventType: "nightlife", venueCategory: "club" }, "live"],
  ["techno DJ set", { title: "Techno DJ set", venueCategory: "culture" }, "club"],
  ["retro party", { title: "Retro Mania \u017eurka" }, "club"],
  ["rock DJ party", { title: "Rock DJ party", eventType: "live music" }, "club"],
  ["DJ tribute night", { title: "David Bowie Tribute DJ set", eventType: "live music" }, "club"],
  ["electronic live performance", { title: "Techno live performance" }, "club"],
  ["band live performance", { title: "Band live performance" }, "live"],
  ["stand-up festival", { title: "StandUpFest", eventType: "nightlife" }, "culture"],
  ["stand-up in a bar", { title: "Stand-up comedy", venueCategory: "bar" }, "culture"],
  ["theatre", { title: "Pozori\u0161na predstava", eventType: "nightlife" }, "culture"],
  ["film screening", { title: "Film screening" }, "culture"],
  ["exhibition", { title: "Izlo\u017eba fotografija" }, "culture"],
  ["public discussion", { title: "Razgovor sa autorom", eventType: "learning" }, "culture"],
  ["pub social night", { title: "Pub social night", venueCategory: "bar" }, "social"],
  ["after-work gathering", { title: "After-work cocktails" }, "social"],
  ["creative workshop at culture venue", { title: "Kreativna radionica", eventType: "arts & culture", venueCategory: "culture" }, "event"],
  ["DJ workshop", { title: "DJ workshop", eventType: "nightlife" }, "event"],
  ["pub quiz in a club", { title: "Pub kviz", eventType: "nightlife", venueCategory: "club" }, "event"],
  ["wine tasting", { title: "Degustacija vina", eventType: "food & market", venueCategory: "bar" }, "event"],
  ["sports screening", { title: "Sportski prenos: utakmica Srbija - Gr\u010dka", eventType: "arts & culture" }, "event"],
  ["live sports screening", { title: "Live sports screening", eventType: "live music" }, "event"],
  ["club opening", { title: "Otvaranje kluba", eventType: "nightlife", venueCategory: "club" }, "event"],
  ["generic festival", { title: "City Festival", eventType: "nightlife" }, "event"],
  ["Serbian Cyrillic workshop", { title: "\u041a\u0440\u0435\u0430\u0442\u0438\u0432\u043d\u0430 \u0440\u0430\u0434\u0438\u043e\u043d\u0438\u0446\u0430", venueCategory: "culture" }, "event"],
  ["concert description refines nightlife", { title: "Petak u gradu", eventType: "nightlife", description: "Rock koncert domaceg benda." }, "live"],
  ["workshop description refines culture", { title: "Kreativni petak", eventType: "arts & culture", description: "Radionica keramike za pocetnike." }, "event"],
  ["quiz description refines nightlife", { title: "Cetvrtak kod nas", eventType: "nightlife", description: "Pub kviz uz prijavu ekipa." }, "event"],
  ["tasting description refines culture", { title: "Susret u gradu", eventType: "arts & culture", description: "Degustacija vina iz Srbije." }, "event"],
];

for (const [label, input, expected] of categoryFixtures) {
  const event = makeEvent(input);
  const before = structuredClone(event);
  const category = getEventPrimaryCategory(event);
  assert.equal(category, expected, `${label} should be classified by the event format.`);
  assert.ok(categoryKeys.has(category), `${label} should have one recognized primary category.`);
  assert.deepEqual(event, before, `${label} should not mutate the source event.`);
}

for (const genre of ["Rock", "Jazz", "Blues", "Pop"]) {
  assert.notEqual(
    getEventPrimaryCategory(makeEvent({ title: `${genre} ve\u010de` })),
    "live",
    `${genre} alone should not claim a live performance.`,
  );
}

assert.equal(
  getEventPrimaryCategory(makeEvent({ venueCategory: "club" })),
  "event",
  "A club location alone should not turn an unspecified event into a DJ party.",
);
assert.equal(
  getEventPrimaryCategory(makeEvent({ venueCategory: "culture" })),
  "event",
  "A culture venue alone should not assign the event's primary category.",
);

const rockConcert = makeEvent({
  title: "Rock koncert",
  eventType: "nightlife",
  venueCategory: "club",
  ticketPrice: "Besplatan ulaz",
});
assert.equal(getEventPrimaryCategory(rockConcert), "live");
assert.ok(getEventTags(rockConcert).includes("Rock"), "A concert may carry a supported genre tag.");
assert.ok(
  getEventTags(rockConcert).includes("Besplatan ulaz"),
  "A free concert should carry the admission tag independently of its primary category.",
);

for (const [input, expectedTag] of [
  [{ title: "Techno DJ set" }, "Techno"],
  [{ title: "Techno DJ set" }, "DJ set"],
  [{ title: "Stand-up comedy" }, "Stand-up"],
  [{ title: "Pub kviz" }, "Kviz"],
  [{ title: "Degustacija vina" }, "Degustacija"],
  [{ eventType: "event", title: "Rock DJ party" }, "Rock"],
  [{ title: "Koncert", description: "Jazz koncert uz besplatan ulaz." }, "Jazz"],
]) {
  assert.ok(
    getEventTags(makeEvent(input)).includes(expectedTag),
    `Tags should preserve the supported ${expectedTag} detail independently of primary category.`,
  );
}

assert.deepEqual(
  getEventTags(makeEvent({ title: "Vladimir \u010cetkar Ensemble", eventType: "live music" })),
  [],
  "Artist identity should not invent an unstated music genre or admission price.",
);
assert.equal(
  getEventTags(makeEvent({ title: "Rock koncert", ticketPrice: "1200 RSD" })).includes("Besplatan ulaz"),
  false,
  "A paid ticket should not gain a free-admission tag.",
);
assert.equal(
  getEventTags(makeEvent({ title: "Freestyle housewarming" })).includes("Besplatan ulaz"),
  false,
  "A title fragment should not be mistaken for free admission.",
);
assert.equal(
  getEventTags(makeEvent({ title: "Free jazz concert", ticketPrice: "1200 RSD" })).includes("Besplatan ulaz"),
  false,
  "The free-jazz music style should not be mistaken for free admission.",
);
assert.equal(
  getEventTags(makeEvent({ title: "DJ workshop" })).includes("DJ set"),
  false,
  "A workshop teaching DJ skills should not claim an announced DJ set.",
);
assert.equal(
  getEventTags(makeEvent({ ticketPrice: "Free before 22:00, 1200 RSD after" })).includes("Besplatan ulaz"),
  false,
  "Conditional free entry should retain its price condition instead of becoming an unconditional free-admission tag.",
);
const repeatedTags = getEventTags(makeEvent({
  title: "Rock koncert",
  description: "Rock muzika; rock koncert.",
  ticketPrice: "Free",
}));
assert.equal(new Set(repeatedTags).size, repeatedTags.length, "Repeated evidence should not duplicate tags.");

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
assert.ok(packageJson.scripts["qa:event-categories"]?.includes("qa-event-categories.mjs"));
assert.match(readFileSync("scripts/release-check.mjs", "utf8"), /script: "qa:event-categories"/);

console.log(`QA passed: five primary categories, legacy filter aliases, ${categoryFixtures.length} format fixtures, and source-supported overlapping tags.`);
