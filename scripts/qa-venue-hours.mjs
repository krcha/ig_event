import assert from "node:assert/strict";

import {
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
      now: NOW,
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
  const overpass = createOverpassFetch([]);
  const patch = await fetchVenueHoursPatch(
    { name: "\"Jedno Mesto\"" },
    {
      now: NOW,
      overpassFetch: overpass.overpassFetch,
    },
  );
  const query = new URLSearchParams(overpass.requests[0].init.body).get("data") ?? "";
  assert.equal(patch?.hoursSource, "none", "OSM no-match should still cache a none result.");
  assert.ok(query.includes("Jedno Mesto"), "Quoted venue names should be searchable.");
  assert.ok(!query.includes('~""'), "Quoted venue names should not break Overpass strings.");
}

{
  const overpassFetch = async () =>
    new Response("Rate limited", {
      status: 429,
    });

  await assert.rejects(
    fetchVenueHoursPatch(
      { name: "Rate Limited Venue" },
      {
        now: NOW,
        overpassFetch,
      },
    ),
    /osm_error:overpass_429/,
    "Transient OSM failures should not be cached as no-hours results.",
  );
}

{
  const overpass = createOverpassFetch([]);
  const patch = await fetchVenueHoursPatch(
    { name: "Drugstore" },
    {
      now: NOW,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch?.hoursSource, "none", "OSM miss should store a no-match result only.");
  assert.equal(patch?.googlePlaceId, "", "Automatic venue-hour storage must not persist Google data.");
  assert.equal(overpass.calls, 1, "OSM miss should call Overpass once.");
}

{
  const overpass = createOverpassFetch([]);
  const patch = await fetchVenueHoursPatch(
    { hoursExpiresAt: NOW + 1_000, name: "Fresh Venue" },
    {
      now: NOW,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch, null, "Fresh cache should skip provider calls.");
  assert.equal(overpass.calls, 0);
}

{
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
      now: NOW,
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
