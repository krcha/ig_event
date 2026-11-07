import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { publicText } from "../lib/i18n/public-messages.ts";
import { eventNoun, formatEventCount, formatPublicDate, publicDayHeading, publicDayLabel } from "../lib/i18n/display.ts";
import { getLocalizedEventDescription } from "../lib/i18n/event-content.ts";

for (const file of ["public-message-seed.json", "public-message-extra.json", "public-message-supplement.json"]) {
  const rows = JSON.parse(await readFile(new URL(`../lib/i18n/${file}`, import.meta.url), "utf8"));
  for (const [key, row] of Object.entries(rows)) {
    assert.deepEqual(Object.keys(row).sort(), ["en", "ru", "sr"], key);
    for (const locale of ["sr", "en", "ru"]) assert.ok(typeof row[locale] === "string" && row[locale].trim(), `${key}: ${locale}`);
  }
}

const counts = [0, 1, 2, 5, 11, 21, 22, 25, 101];
const russian = ["событий", "событие", "события", "событий", "событий", "событие", "события", "событий", "событие"];
const serbian = ["događaja", "događaj", "događaja", "događaja", "događaja", "događaj", "događaja", "događaja", "događaj"];
counts.forEach((count, index) => {
  assert.equal(eventNoun("ru", count), russian[index]);
  assert.equal(eventNoun("sr", count), serbian[index]);
  assert.equal(eventNoun("en", count), count === 1 ? "event" : "events");
  for (const locale of ["sr", "en", "ru"]) assert.ok(formatEventCount(locale, count).includes(eventNoun(locale, count)));
});
assert.equal(eventNoun("ru", 1.5), "события");

assert.equal(publicText("ru", "Događaj, mesto ili žanr"), "Событие, участник или место");
assert.equal(publicText("en", "Sve"), "All");
assert.equal(publicText("ru", "Save STABLO MASLINE"), "Сохранить: STABLO MASLINE");
assert.equal(publicText("en", "Radno vreme mesta: 23:00–06:00"), "Venue opening hours: 23:00–06:00");
assert.equal(publicText("ru", "23:00–06:00"), "23:00–06:00");
assert.equal(publicText("en", "未知の公演名"), "未知の公演名");
assert.equal(publicText("ru", "  Copy link  "), "  Скопировать ссылку  ");

for (const locale of ["sr", "en", "ru"]) {
  assert.match(formatPublicDate(locale, "2026-11-06", { year: "numeric", month: "numeric", day: "numeric" }), /2026/u);
  assert.notEqual(publicDayLabel(locale, "2026-11-06", "2026-11-06"), "");
  assert.notEqual(publicDayHeading(locale, "2026-11-07", "2026-11-06"), "");
}
assert.match(formatPublicDate("ru", "2026-11-06", { month: "long" }), /ноябр/u);
assert.match(formatPublicDate("en", "2026-11-06", { month: "long" }), /November/u);

const sourceBound = {
  _id: "canonical-event", title: "Karma Koma", date: "2026-11-06", time: "23:00–06:00",
  venue: "Karma Koma", venueId: "canonical-venue", artists: ["Artist"],
  description: "Original custom announcement: free until 23:00; 500 RSD after.",
  sourceCaption: "Original source", normalizedFieldsJson: '{"sourceOccurrenceKey":"exact"}',
};
const before = structuredClone(sourceBound);
for (const locale of ["sr", "en", "ru"]) {
  const result = getLocalizedEventDescription(sourceBound, locale);
  assert.equal(result.text, sourceBound.description);
  assert.equal(result.original, true);
}
assert.deepEqual(sourceBound, before, "Display translation must not modify facts or source evidence.");
console.log("Public localization QA passed: three-language coverage, plural forms, date-only formatting, safe UI templates and immutable original event/source facts.");
