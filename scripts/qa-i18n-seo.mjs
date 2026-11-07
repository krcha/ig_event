import assert from "node:assert/strict";
import { LOCALES, LOCALE_LANGUAGE_TAGS } from "../i18n/config.ts";
import { SITE_COPY, localizedAlternates, localizedMetadata, getHomeFaqItems } from "../lib/i18n/seo.ts";
import { getLocalizedEventDescription, getEventContentLocales } from "../lib/i18n/event-content.ts";
import { buildEventStructuredData, buildVenueStructuredData, buildHomePageStructuredData } from "../lib/seo/site.ts";
import { getDiscoverPageCopy } from "../lib/discover/page-copy.ts";
import { GET as manifest } from "../app/api/manifest/route.ts";

const event = {
  _id: "j5704hyc9wdzy7r10v0vbtj5e98hp1nt", title: "Karma Koma", venue: "Club", venueId: "k17cp35s3e07ebpthy4m4trf01896hwv",
  artists: ["DJ One", "DJ Two"], eventType: "nightlife", date: "2026-11-06", time: "23:00-06:00", timeStatus: "confirmed",
  description: "Nightlife event with DJ One, DJ Two at Club.",
  venueLocation: "Cetinjska 15, Beograd",
};
function withStructuredDataFacts(occurrence) {
  const { title, date, venueId, time } = occurrence;
  return { ...occurrence, structuredDataFacts: { title, date, venueId, time } };
}
const before = JSON.stringify(event);
const schemas = LOCALES.map(locale => buildEventStructuredData(withStructuredDataFacts(event), locale));
for (const [index, locale] of LOCALES.entries()) {
  const path = `/events/${event._id}`;
  const prefix = locale === "sr" ? "" : `/${locale}`;
  const alternatives = localizedAlternates(path, locale);
  assert.equal(alternatives.canonical, `https://eventzeka.com${prefix}${path}`);
  assert.equal(alternatives.languages["x-default"], `https://eventzeka.com${path}`);
  assert.deepEqual(Object.keys(alternatives.languages), ["sr-Latn", "en", "ru", "x-default"]);
  const metadata = localizedMetadata({ locale, path, title: event.title, description: SITE_COPY[locale].description });
  assert.equal(metadata.openGraph.locale, { sr: "sr_RS", en: "en_RS", ru: "ru_RS" }[locale]);
  assert.equal(metadata.robots.index, true);
  assert.equal(schemas[index]["@id"], schemas[0]["@id"], "A translation must not create another canonical event entity.");
  assert.equal(schemas[index].location["@id"], schemas[0].location["@id"]);
  assert.equal(schemas[index].startDate, "2026-11-06T23:00:00+01:00");
  assert.equal(schemas[index].endDate, "2026-11-07T06:00:00+01:00", "The continuous overnight occurrence must stay intact.");
  assert.equal("performer" in schemas[index], false, "Localized artist labels do not prove a structured performer claim.");
  assert.equal(schemas[index].name, event.title);
  assert.equal(schemas[index].url, alternatives.canonical);
  assert.equal("inLanguage" in schemas[index], false, "Interface locale is not the performance language.");
  const venue = buildVenueStructuredData({ _id: event.venueId, name: event.venue, instagramHandle: "club" }, locale);
  assert.equal(venue["@id"], `https://eventzeka.com/venues/${event.venueId}#place`);
  const home = buildHomePageStructuredData([], locale);
  assert.equal(home["@graph"][0]["@id"], "https://eventzeka.com/#website");
  assert.equal(home["@graph"][1].inLanguage, LOCALE_LANGUAGE_TAGS[locale]);
  assert.deepEqual(home["@graph"][2].mainEntity.map(item => item.name), getHomeFaqItems(locale).map(item => item.question));
  const display = getLocalizedEventDescription(event, locale);
  assert.equal(display.original, false);
  for (const name of [event.venue, ...event.artists]) assert.ok(display.text.includes(name));
  const response = manifest(new Request(`https://eventzeka.com/api/manifest?locale=${locale}`));
  const installed = await response.json();
  assert.equal(installed.id, "/");
  assert.equal(installed.scope, "/");
  assert.equal(installed.start_url, locale === "sr" ? "/" : `/${locale}`);
  assert.equal(installed.lang, LOCALE_LANGUAGE_TAGS[locale]);
  assert.match(response.headers.get("content-type"), /application\/manifest\+json/);
}
assert.equal(JSON.stringify(event), before, "Presentation must not mutate canonical facts or descriptions.");

const caption = "Doors open at 21:00; free before 22:00, then 500 RSD.";
const custom = { ...event, sourceCaption: caption };
assert.deepEqual(getEventContentLocales(custom), ["sr"], "Original announcement prose must not be advertised as translated main content.");
const original = getLocalizedEventDescription({ ...event, description: caption }, "ru");
assert.deepEqual(original, { text: caption, original: true }, "Source conditions and unstated details cannot be guessed during translation.");
assert.deepEqual(getEventContentLocales(event), LOCALES);
for (const locale of ["en", "ru"]) {
  const metadata = localizedMetadata({ locale, path: `/events/${event._id}`, title: event.title, readyLocales: getEventContentLocales(custom) });
  assert.equal(metadata.robots.index, false);
  assert.equal(metadata.alternates.languages, undefined);
  assert.ok(metadata.alternates.canonical.includes(`/${locale}/events/`), "A usable fallback page retains its own URL identity.");
  const selected = getDiscoverPageCopy("2026-10-11", "2026-10-12", locale);
  assert.doesNotMatch(selected.title, /tonight|сегодня/iu, "A selected past date must not be presented as tonight.");
}
assert.equal(manifest(new Request("https://eventzeka.com/api/manifest?locale=fr")).status, 400);

const one = buildEventStructuredData(withStructuredDataFacts({ ...event, title: "Stablo Masline", time: "18:30" }), "ru");
const two = buildEventStructuredData(withStructuredDataFacts({ ...event, title: "Pukotina u ledu", time: "20:30" }), "ru");
assert.notEqual(one.startDate, two.startDate);
assert.notEqual(one.name, two.name);
console.log("I18n SEO QA passed: reciprocal URLs, stable entities, overnight facts, original-prose readiness, source preservation, date copy and stable PWA identity.");
