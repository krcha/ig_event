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
  fetchVenueHoursPatch,
  normalizeOsmOpeningHours,
} from "../lib/venues/venue-hours-fetcher.ts";

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
  const overpassFetch = async () => {
    calls += 1;
    return jsonResponse({ elements });
  };
  return {
    get calls() {
      return calls;
    },
    overpassFetch,
  };
}

function createGoogleFetch() {
  const urls = [];
  const googleFetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes("places:searchText")) {
      return jsonResponse({
        places: [
          {
            displayName: { text: "Drugstore" },
            formattedAddress: "Bulevar despota Stefana, Belgrade",
            id: "google-drugstore",
            name: "places/google-drugstore",
          },
        ],
      });
    }

    return jsonResponse({
      regularOpeningHours: {
        periods: [
          {
            close: { day: 4, hour: 2, minute: 0 },
            open: { day: 3, hour: 18, minute: 0 },
          },
        ],
      },
      timeZone: { id: BELGRADE_TIMEZONE },
    });
  };

  return {
    get calls() {
      return urls.length;
    },
    googleFetch,
    urls,
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
  const google = createGoogleFetch();
  const patch = await fetchVenueHoursPatch(
    { name: "Drugstore" },
    {
      googleApiKey: "test-key",
      googleFetch: google.googleFetch,
      now: NOW,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch?.hoursSource, "osm", "OSM hit should be used first.");
  assert.equal(overpass.calls, 1, "OSM hit should call Overpass once.");
  assert.equal(google.calls, 0, "OSM hit should not call Google.");
}

{
  const overpass = createOverpassFetch([]);
  const google = createGoogleFetch();
  const patch = await fetchVenueHoursPatch(
    { name: "Drugstore" },
    {
      googleApiKey: "test-key",
      googleFetch: google.googleFetch,
      now: NOW,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch?.hoursSource, "google", "OSM miss should fall back to Google.");
  assert.equal(overpass.calls, 1, "OSM miss should still call Overpass once.");
  assert.equal(google.calls, 2, "Google fallback should call Text Search and Place Details.");
  assert.ok(
    google.urls[0].includes("places:searchText") && google.urls[1].includes("google-drugstore"),
    "Google fallback should fetch Place ID, then Place Details for that ID.",
  );
}

{
  const overpass = createOverpassFetch([]);
  const google = createGoogleFetch();
  const patch = await fetchVenueHoursPatch(
    { hoursExpiresAt: NOW + 1_000, name: "Fresh Venue" },
    {
      googleApiKey: "test-key",
      googleFetch: google.googleFetch,
      now: NOW,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch, null, "Fresh cache should skip provider calls.");
  assert.equal(overpass.calls, 0);
  assert.equal(google.calls, 0);
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
      googleApiKey: "test-key",
      now: NOW,
      overpassFetch: overpass.overpassFetch,
    },
  );
  assert.equal(patch?.hoursSource, "osm", "Expired cache should refresh from providers.");
  assert.equal(patch?.hoursFetchedAt, NOW, "Refresh patch should carry the fetch timestamp.");
  assert.equal(patch?.osmElementId, "202");
}

console.log("QA passed: venue hours fallback, cache, and provider behavior.");
