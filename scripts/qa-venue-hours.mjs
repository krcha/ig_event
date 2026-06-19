import assert from "node:assert/strict";

import {
  TBD_EVENT_TIME,
  getDayPeriodForStartTime,
  resolveEventTimeDisplay,
} from "../lib/events/event-time.ts";
import {
  BELGRADE_TIMEZONE,
  serializeVenueHoursJson,
} from "../lib/venues/venue-hours-cache.ts";
import {
  createManualVenueHoursPatch,
  fetchVenueHoursPatch,
  normalizeOsmOpeningHours,
} from "../lib/venues/venue-hours-fetcher.ts";
import {
  selectVenuesForHoursRefresh,
} from "../lib/venues/venue-hours-refresh.ts";

const WEDNESDAY = "2026-06-17";
const NOW = Date.parse("2026-06-17T12:00:00.000Z");

function createHoursJson(day) {
  return serializeVenueHoursJson({
    generatedAt: "2026-06-17T12:00:00.000Z",
    source: "manual",
    timezone: BELGRADE_TIMEZONE,
    version: 1,
    weekly: [day],
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function createOverpassFetch(elements) {
  let calls = 0;
  const requests = [];
  const overpassFetch = async (url, init) => {
    calls += 1;
    requests.push({ init, url });
    return jsonResponse({ elements });
  };
  return {
    get calls() {
      return calls;
    },
    overpassFetch,
    requests,
  };
}

function createNominatimFetch(places) {
  let calls = 0;
  const requests = [];
  const nominatimFetch = async (url, init) => {
    calls += 1;
    requests.push({ init, url });
    return jsonResponse(places);
  };
  return {
    get calls() {
      return calls;
    },
    nominatimFetch,
    requests,
  };
}

assert.equal(getDayPeriodForStartTime("07:59"), "night", "07:59 should be night.");
assert.equal(getDayPeriodForStartTime("08:00"), "day", "08:00 should be day.");
assert.equal(getDayPeriodForStartTime("17:59"), "day", "17:59 should be day.");
assert.equal(getDayPeriodForStartTime("18:00"), "night", "18:00 should be night.");

assert.deepEqual(
  resolveEventTimeDisplay({
    date: WEDNESDAY,
    time: "21:00-02:00",
    venueHours: {
      hoursJson: createHoursJson({
        closed: false,
        day: 3,
        windows: [{ day: 3, end: "23:00", start: "12:00" }],
      }),
    },
  }),
  {
    dayPeriod: "night",
    endLabel: "02:00",
    label: "21:00–02:00",
    source: "event",
    startLabel: "21:00",
  },
  "Event time should win over venue hours and preserve after-midnight end.",
);

assert.deepEqual(
  resolveEventTimeDisplay({
    date: WEDNESDAY,
    time: "21:00",
    venueHours: {
      hoursJson: createHoursJson({
        closed: false,
        day: 3,
        windows: [{ day: 3, end: "02:00", spansNextDay: true, start: "18:00" }],
      }),
    },
  }),
  {
    dayPeriod: "night",
    endLabel: "02:00",
    label: "21:00–02:00",
    source: "event_with_venue_hours",
    startLabel: "21:00",
  },
  "Venue closing time should fill a missing event end time.",
);

assert.deepEqual(
  resolveEventTimeDisplay({
    date: WEDNESDAY,
    time: "21:00",
    venueHours: {
      hoursJson: createHoursJson({
        closed: false,
        day: 3,
        windows: [
          { day: 3, end: "18:00", start: "10:00" },
          { day: 3, end: "02:00", spansNextDay: true, start: "20:00" },
        ],
      }),
    },
  }).label,
  "21:00–02:00",
  "Venue fallback should choose the opening window containing the event start.",
);

assert.deepEqual(
  resolveEventTimeDisplay({
    date: WEDNESDAY,
    time: TBD_EVENT_TIME,
    venueHours: {
      hoursJson: createHoursJson({
        closed: false,
        day: 3,
        windows: [{ day: 3, end: "02:00", spansNextDay: true, start: "18:00" }],
      }),
    },
  }),
  {
    dayPeriod: "unknown",
    label: TBD_EVENT_TIME,
    source: "unknown",
  },
  "Explicit TBD event time should not be replaced by venue hours.",
);

assert.deepEqual(
  resolveEventTimeDisplay({
    date: WEDNESDAY,
    venueHours: {
      hoursJson: createHoursJson({
        closed: false,
        day: 3,
        windows: [{ day: 3, end: "02:00", spansNextDay: true, start: "18:00" }],
      }),
    },
  }),
  {
    dayPeriod: "night",
    endLabel: "02:00",
    label: "Open 18:00–02:00",
    source: "venue_hours",
    startLabel: "18:00",
  },
  "Missing event time should fall back to the venue opening window.",
);

assert.equal(
  resolveEventTimeDisplay({
    date: WEDNESDAY,
    venueHours: {
      hoursJson: createHoursJson({ closed: true, day: 3, windows: [] }),
    },
  }).label,
  "Closed today — tap to check",
  "Closed venue hours should render a closed fallback.",
);

assert.equal(
  resolveEventTimeDisplay({ date: WEDNESDAY }).label,
  "Hours unknown — tap to check",
  "Missing event time and missing venue hours should render the unknown fallback.",
);

const osmHours = normalizeOsmOpeningHours("Mo-Su 20:00-02:00", {
  generatedAt: "2026-06-17T12:00:00.000Z",
  referenceDate: new Date("2026-06-14T12:00:00"),
});
assert.equal(osmHours.weekly[3].windows[0].start, "20:00");
assert.equal(osmHours.weekly[3].windows[0].end, "02:00");
assert.equal(osmHours.weekly[3].windows[0].spansNextDay, true);

{
  const nominatim = createNominatimFetch([
    {
      display_name: "Академија 28, Немањина, Београд, Србија",
      extratags: {
        opening_hours: "Mo-Fr 08:00-24:00; Sa 09:00-24:00; Su 10:00-24:00",
      },
      name: "Академија 28",
      osm_id: 6060747670,
      osm_type: "node",
    },
  ]);
  const overpass = createOverpassFetch([]);
  const patch = await fetchVenueHoursPatch(
    { instagramHandle: "akademija28", name: "Akademija 28" },
    {
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFallback: true,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch?.hoursSource, "osm", "Nominatim opening_hours should be used first.");
  assert.equal(patch?.osmElementId, "6060747670");
  assert.equal(nominatim.calls, 1, "Nominatim should be queried once.");
  assert.ok(
    new URL(nominatim.requests[0].url).searchParams.get("q")?.startsWith("Akademija 28,"),
    "Display names should outrank derived handle guesses.",
  );
  assert.equal(overpass.calls, 0, "Nominatim hit should skip Overpass.");
}

{
  const nominatim = createNominatimFetch([
    {
      display_name: "Silosi, Dunavski kej, Београд, Србија",
      extratags: {
        opening_hours: "Mo-Su 12:00-23:00",
      },
      name: "Silosi",
      osm_id: 601,
      osm_type: "node",
    },
  ]);
  const patch = await fetchVenueHoursPatch(
    {
      instagramHandle: "silosibeograd",
      name: "Silosi Beograd ••••IIII Dom kulture",
    },
    {
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFetch: createOverpassFetch([]).overpassFetch,
    },
  );
  const query = new URL(nominatim.requests[0].url).searchParams.get("q") ?? "";
  assert.equal(patch?.hoursSource, "osm", "Handle aliases should repair noisy venue names.");
  assert.ok(query.startsWith("Silosi,"), "Handle alias should be the first Nominatim term.");
}

{
  const nominatim = createNominatimFetch([
    {
      display_name: "Boutique Trojka, Београд, Србија",
      extratags: {
        opening_hours: "Mo-Su 09:00-22:00",
      },
      name: "Boutique Trojka",
      osm_id: 602,
      osm_type: "node",
    },
  ]);
  const patch = await fetchVenueHoursPatch(
    { name: "Boutique Trojka Official" },
    {
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFetch: createOverpassFetch([]).overpassFetch,
    },
  );
  const query = new URL(nominatim.requests[0].url).searchParams.get("q") ?? "";
  assert.equal(patch?.hoursSource, "osm", "Generic name suffixes should not block OSM matches.");
  assert.ok(
    query.startsWith("Boutique Trojka,"),
    "Descriptor-stripped venue name should be queried before the noisy full name.",
  );
}

{
  const nominatim = createNominatimFetch([
    {
      display_name: "ZAPPA BAR, Београд, Србија",
      extratags: {
        opening_hours: "Mo-Su 08:00-24:00",
      },
      name: "ZAPPA BAR",
      osm_id: 604,
      osm_type: "node",
    },
  ]);
  const patch = await fetchVenueHoursPatch(
    { name: "ZAPPA BAR" },
    {
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFetch: createOverpassFetch([]).overpassFetch,
    },
  );
  const query = new URL(nominatim.requests[0].url).searchParams.get("q") ?? "";
  assert.equal(patch?.hoursSource, "osm", "Category words can be part of the real OSM name.");
  assert.ok(
    query.startsWith("ZAPPA BAR,"),
    "Full venue names with Bar/Club should be tried before category-stripped fallbacks.",
  );
}

{
  const nominatim = createNominatimFetch([
    {
      display_name: "Closed Venue, Београд, Србија",
      extratags: {
        opening_hours: "off",
      },
      name: "Closed Venue",
      osm_id: 603,
      osm_type: "node",
    },
  ]);
  const patch = await fetchVenueHoursPatch(
    { name: "Closed Venue" },
    {
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFetch: createOverpassFetch([]).overpassFetch,
    },
  );
  assert.equal(
    patch?.hoursSource,
    "none",
    "OSM schedules without usable weekly windows should not be stored as hours.",
  );
}

{
  const nominatim = createNominatimFetch([
    {
      display_name: "20/44, Карађорђева, Београд, Србија",
      extratags: {},
      name: "20/44",
      osm_id: 13111157561,
      osm_type: "node",
    },
  ]);
  const overpass = createOverpassFetch([
    {
      id: 13111157561,
      tags: { name: "20/44", opening_hours: "Mo-Su 22:00-04:00" },
      type: "node",
    },
  ]);
  const patch = await fetchVenueHoursPatch(
    { name: "20/44" },
    {
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFallback: true,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch?.hoursSource, "none", "Known OSM place without hours should cache none.");
  assert.equal(overpass.calls, 0, "Known no-hours OSM place should skip Overpass fallback.");
}

{
  const nominatim = createNominatimFetch([]);
  const overpass = createOverpassFetch([
    {
      id: 303,
      tags: { name: "Overpass Only", opening_hours: "Mo-Su 10:00-22:00" },
      type: "node",
    },
  ]);
  const patch = await fetchVenueHoursPatch(
    { name: "Overpass Only" },
    {
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFallback: false,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch?.hoursSource, "none", "Disabled Overpass fallback should cache no-match.");
  assert.equal(overpass.calls, 0, "Disabled Overpass fallback should not call Overpass.");
}

{
  const nominatim = createNominatimFetch([]);
  const overpass = createOverpassFetch([
    {
      id: 101,
      tags: { name: "Drugstore", opening_hours: "Mo-Su 18:00-02:00" },
      type: "node",
    },
  ]);
  const patch = await fetchVenueHoursPatch(
    { name: "Drugstore" },
    {
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFallback: true,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch?.hoursSource, "osm", "OSM hit should be used first.");
  assert.equal(overpass.calls, 1, "OSM hit should call Overpass once.");
  assert.equal(
    overpass.requests[0].init.headers["user-agent"],
    "ig-event venue-hours refresh",
    "Overpass requests should include an explicit User-Agent.",
  );
}

{
  const nominatim = createNominatimFetch([]);
  const overpass = createOverpassFetch([]);
  const patch = await fetchVenueHoursPatch(
    { name: "\"Jedno Mesto\"" },
    {
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFallback: true,
      overpassFetch: overpass.overpassFetch,
    },
  );
  const query = new URLSearchParams(overpass.requests[0].init.body).get("data") ?? "";
  assert.equal(patch?.hoursSource, "none", "OSM no-match should still cache a none result.");
  assert.ok(query.includes("Jedno Mesto"), "Quoted venue names should be searchable.");
  assert.ok(!query.includes('~""'), "Quoted venue names should not break Overpass strings.");
}

{
  const nominatimFetch = async () => jsonResponse([]);
  const overpassFetch = async () =>
    new Response("Rate limited", {
      status: 429,
    });

  await assert.rejects(
    fetchVenueHoursPatch(
      { name: "Rate Limited Venue" },
      {
        nominatimFetch,
        now: NOW,
        overpassFallback: true,
        overpassFetch,
      },
    ),
    /osm_error:overpass_429/,
    "Transient OSM failures should not be cached as no-hours results.",
  );
}

{
  const nominatim = createNominatimFetch([]);
  const overpass = createOverpassFetch([]);
  const patch = await fetchVenueHoursPatch(
    { name: "Drugstore" },
    {
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFallback: true,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch?.hoursSource, "none", "OSM miss should store a no-match result only.");
  assert.equal(patch?.googlePlaceId, "", "Automatic venue-hour storage must not persist Google data.");
  assert.equal(overpass.calls, 1, "OSM miss should call Overpass once.");
}

{
  const nominatim = createNominatimFetch([]);
  const overpass = createOverpassFetch([]);
  const patch = await fetchVenueHoursPatch(
    {
      hoursJson: serializeVenueHoursJson(
        normalizeOsmOpeningHours("Mo-Su 18:00-02:00", {
          generatedAt: "2026-06-16T12:00:00.000Z",
        }),
      ),
      hoursSource: "osm",
      name: "Existing OSM Venue",
    },
    {
      force: true,
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(
    patch,
    null,
    "Forced refresh should not overwrite existing usable OSM hours with no-match.",
  );
}

{
  const nominatim = createNominatimFetch([]);
  const overpass = createOverpassFetch([]);
  const patch = await fetchVenueHoursPatch(
    { hoursExpiresAt: NOW + 1_000, name: "Fresh Venue" },
    {
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFallback: true,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch, null, "Fresh cache should skip provider calls.");
  assert.equal(overpass.calls, 0);
}

{
  const nominatim = createNominatimFetch([]);
  const overpass = createOverpassFetch([
    {
      id: 202,
      tags: { name: "Expired Venue", opening_hours: "Mo-Su 10:00-22:00" },
      type: "way",
    },
  ]);
  const patch = await fetchVenueHoursPatch(
    { hoursExpiresAt: NOW - 1, name: "Expired Venue" },
    {
      nominatimFetch: nominatim.nominatimFetch,
      now: NOW,
      overpassFallback: true,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch?.hoursSource, "osm", "Expired cache should refresh from providers.");
  assert.equal(patch?.hoursFetchedAt, NOW, "Refresh patch should carry the fetch timestamp.");
  assert.equal(patch?.osmElementId, "202");
}

{
  const patch = createManualVenueHoursPatch("Mo-Su 18:00-02:00", NOW);
  const hoursJson = JSON.parse(patch.hoursJson);
  assert.equal(patch.hoursSource, "manual", "Manual hours should be stored with manual source.");
  assert.equal(hoursJson.source, "manual", "Manual hours JSON should keep manual provenance.");
  assert.equal(hoursJson.weekly[3].windows[0].start, "18:00");
  assert.equal(hoursJson.weekly[3].windows[0].end, "02:00");
  assert.equal(patch.googlePlaceId, "", "Manual hours must not persist Google place IDs.");
}

{
  const selected = selectVenuesForHoursRefresh(
    [
      {
        _id: "fresh",
        hoursExpiresAt: NOW + 1_000,
        hoursFetchedAt: NOW - 1_000,
        hoursJson: createHoursJson({ closed: false, day: 3, windows: [] }),
        hoursSource: "osm",
        isActive: true,
        name: "Fresh Venue",
      },
      {
        _id: "missing",
        isActive: true,
        name: "Missing Venue",
      },
      {
        _id: "expired-none",
        hoursExpiresAt: NOW - 1,
        hoursFetchedAt: NOW - 10_000,
        hoursJson: createHoursJson({ closed: true, day: 3, windows: [] }),
        hoursSource: "none",
        isActive: true,
        name: "Expired None Venue",
      },
      {
        _id: "inactive",
        isActive: false,
        name: "Inactive Venue",
      },
    ],
    2,
    NOW,
  );

  assert.deepEqual(
    selected.map((venue) => venue._id),
    ["missing", "expired-none"],
    "Refresh selection should prioritize missing/stale hours before fresh venues.",
  );
}

console.log("QA passed: venue hours fallback, cache, and provider behavior.");
