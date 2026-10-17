import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getVenueCoordinates } from "../lib/venues/coordinates.ts";
import { parseVenueHoursJson } from "../lib/venues/venue-hours-cache.ts";

const DEFAULT_CONVEX_URL = "https://convex-events.ineedtofeedmyrabbit.com";
const SITE_URL = "https://eventzeka.com";
const PUBLIC_DIRECTORY_LIMIT = 2_000;
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ["Nedelja", "Ponedeljak", "Utorak", "Sreda", "Cetvrtak", "Petak", "Subota"];

export const EXPORT_COLUMNS = [
  ["name", "Naziv"],
  ["instagramUrl", "Instagram"],
  ["venueUrl", "Eventzeka profil"],
  ["address", "Adresa"],
  ["category", "Kategorija"],
  ["mapStatus", "Lokacija na mapi"],
  ["hoursStatus", "Radno vreme"],
  ["knownDays", "Poznati dani"],
  ["missingDays", "Nepoznati dani"],
  ["weeklyHours", "Nedeljni raspored"],
  ["hoursSource", "Izvor satnice"],
  ["hoursSourceUrls", "Linkovi izvora satnice"],
  ["googleMapsUrl", "Google Maps"],
  ["hoursTimezone", "Vremenska zona"],
  ["timezoneStatus", "Provera vremenske zone"],
  ["hoursFetchedAt", "Satnica preuzeta (UTC)"],
  ["hoursExpiresAt", "Rok osvezavanja (UTC)"],
  ["hoursCacheStatus", "Status roka osvezavanja"],
  ["hoursError", "Napomena izvora"],
  ["latitude", "Geografska sirina"],
  ["longitude", "Geografska duzina"],
  ["id", "Stabilni ID"],
];

function isoTimestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function validHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href : "";
  } catch {
    return "";
  }
}

function sourceUrls(hours, venue) {
  const raw = hours?.raw ?? {};
  const urls = [
    ...(Array.isArray(raw.sourceUrls) ? raw.sourceUrls : []),
    raw.sourceUrl,
    raw.url,
  ].map(validHttpUrl).filter(Boolean);
  if (hours?.source === "osm" && venue.osmElementId && venue.osmElementType) {
    if (["node", "way", "relation"].includes(venue.osmElementType) && /^\d+$/.test(venue.osmElementId)) {
      urls.push(`https://www.openstreetmap.org/${venue.osmElementType}/${venue.osmElementId}`);
    }
  }
  return [...new Set(urls)].join("\n");
}

function timezoneStatus(timezone, metadataTimezone) {
  if (!timezone) return "Nepoznata";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    if (metadataTimezone && metadataTimezone !== timezone) return "Razlicita zona u metapodacima";
    return "Ispravna";
  } catch {
    return "Neispravna";
  }
}

export function classifyPublicVenue(venue, now = Date.now()) {
  const coordinates = getVenueCoordinates(venue.latitude, venue.longitude);
  const hours = parseVenueHoursJson(venue.hoursJson);
  const trustedHours = hours && hours.source !== "none" ? hours : null;
  // Use the same first matching weekday as the public hours display. A known
  // closed day is information, while an empty non-closed day is unknown.
  const days = WEEKDAYS.map((weekday) => ({
    weekday,
    value: trustedHours?.weekly.find((day) => day.day === weekday),
  }));
  const knownDays = days.filter(({ value }) => value && (value.closed || value.windows.length > 0));
  const missingDays = days.filter(({ weekday }) => !knownDays.some((day) => day.weekday === weekday));
  const missingOpeningHours = knownDays.length === 0;
  const partialOpeningHours = knownDays.length > 0 && knownDays.length < 7;
  const closedOnlyHours = knownDays.length > 0 && knownDays.every(({ value }) => value.closed);
  const hoursStatus = missingOpeningHours ? "Nedostaje" : partialOpeningHours ? "Nepotpuno" : "Poznato";
  const timezone = hours?.timezone ?? venue.hoursTimezone ?? "";
  const fetchedAt = isoTimestamp(venue.hoursFetchedAt);
  const expiresAt = isoTimestamp(venue.hoursExpiresAt);
  const handle = typeof venue.instagramHandle === "string" ? venue.instagramHandle.replace(/^@+/, "") : "";
  const googleMapsUrl = venue.googlePlaceId
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue.name)}&query_place_id=${encodeURIComponent(venue.googlePlaceId)}`
    : "";
  const weeklyHours = days.map(({ weekday, value }) => {
    const label = value?.closed ? "Zatvoreno" : value?.windows.length ? value.windows.map((window) =>
      `${window.start}-${window.end}${window.spansNextDay || window.end <= window.start ? " (+1 dan)" : ""}`,
    ).join(", ") : "Nepoznato";
    return `${DAY_NAMES[weekday]}: ${label}`;
  }).join("\n");

  return {
    id: venue._id,
    name: venue.name,
    instagramUrl: validHttpUrl(venue.instagramProfileUrl) || (handle ? `https://www.instagram.com/${encodeURIComponent(handle)}/` : ""),
    venueUrl: `${SITE_URL}/venues/${encodeURIComponent(venue._id)}`,
    address: venue.location ?? "",
    category: venue.category ?? "",
    mapStatus: coordinates ? "Poznata" : "Nedostaje",
    hoursStatus,
    knownDays: knownDays.map(({ weekday }) => DAY_NAMES[weekday]).join(", "),
    missingDays: missingDays.map(({ weekday }) => DAY_NAMES[weekday]).join(", "),
    weeklyHours,
    hoursSource: hours?.source ?? venue.hoursSource ?? "none",
    hoursSourceUrls: sourceUrls(hours, venue),
    googleMapsUrl,
    hoursTimezone: timezone,
    timezoneStatus: timezoneStatus(timezone, venue.hoursTimezone),
    hoursFetchedAt: fetchedAt,
    hoursExpiresAt: expiresAt,
    hoursCacheStatus: !expiresAt ? "Nema roka" : venue.hoursSource === "manual" ? "Rucno odrzavano" : venue.hoursExpiresAt < now ? "Za osvezavanje" : "U roku",
    hoursError: venue.hoursError ?? "",
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    missingMapLocation: coordinates === null,
    missingOpeningHours,
    partialOpeningHours,
    closedOnlyHours,
    expiredCache: Boolean(expiresAt && venue.hoursExpiresAt < now),
  };
}

export function buildVenueGapSnapshot(venues, options) {
  assert.ok(Array.isArray(venues), "Public venue response must be an array.");
  assert.ok(venues.length < PUBLIC_DIRECTORY_LIMIT, "Public directory reached the API limit; completeness cannot be established.");
  assert.ok(venues.length > 0, "Public directory is empty; refusing an unverified empty export.");
  for (const venue of venues) {
    assert.equal(typeof venue._id, "string", "Every public venue must have a stable ID.");
    assert.ok(venue._id.trim(), "Every public venue must have a nonempty stable ID.");
    assert.equal(typeof venue.name, "string", "Every public venue must have a name.");
  }
  assert.equal(new Set(venues.map((venue) => venue._id)).size, venues.length, "Duplicate public venue IDs.");
  const rows = venues.map((venue) => classifyPublicVenue(venue, options.now)).sort((a, b) =>
    a.name.localeCompare(b.name, "sr-Latn", { sensitivity: "base" }) || a.id.localeCompare(b.id),
  );
  const missingMapLocation = rows.filter((venue) => venue.missingMapLocation);
  const missingOpeningHours = rows.filter((venue) => venue.missingOpeningHours);
  const partialOpeningHours = rows.filter((venue) => venue.partialOpeningHours);
  assert.equal(missingOpeningHours.some((venue) => venue.partialOpeningHours), false);
  assert.equal(missingMapLocation.some((venue) => getVenueCoordinates(venue.latitude, venue.longitude)), false);
  return {
    formatVersion: 1,
    generatedAt: new Date(options.now).toISOString(),
    generatedAtBelgrade: new Intl.DateTimeFormat("sr-Latn-RS", { timeZone: "Europe/Belgrade", dateStyle: "long", timeStyle: "long" }).format(options.now),
    source: { url: `${options.convexUrl}/api/query`, query: "venues:listPublicVenueFields", args: { limit: PUBLIC_DIRECTORY_LIMIT }, siteUrl: SITE_URL },
    scope: "Svi objavljeni profili u Eventzeka imeniku. Imenik ukljucuje i organizatore, festivale i izvodjace, kojima stalna adresa ili nedeljno radno vreme ne moraju biti primenljivi. Uloge se ne pretpostavljaju iz naziva.",
    criteria: {
      missingMapLocation: "Nema ispravnog numerickog para geografskih koordinata po istom pravilu kao aplikacija. Sama tekstualna adresa nije lokacija na mapi.",
      missingOpeningHours: "Nema nijednog poznatog dana iz parsiranog rasporeda sa izvorom razlicitim od none. Potvrdjen zatvoren dan jeste poznat podatak.",
      partialOpeningHours: "Raspored postoji za 1 do 6 dana. Nepoznati dani nisu tretirani kao zatvoreni.",
      expiry: "Istek roka za osvezavanje vodi se odvojeno i ne znaci da satnica ne postoji. Rucni rasporedi se odrzavaju rucno.",
    },
    counts: {
      publicProfiles: rows.length,
      missingMapLocation: missingMapLocation.length,
      missingOpeningHours: missingOpeningHours.length,
      partialOpeningHours: partialOpeningHours.length,
      closedOnlyHours: rows.filter((venue) => venue.closedOnlyHours).length,
      expiredCaches: rows.filter((venue) => venue.expiredCache).length,
      invalidTimezones: rows.filter((venue) => venue.timezoneStatus === "Neispravna").length,
      timezoneMismatches: rows.filter((venue) => venue.timezoneStatus === "Razlicita zona u metapodacima").length,
    },
    columns: EXPORT_COLUMNS.map(([key, label]) => ({ key, label })),
    lists: { missingMapLocation, missingOpeningHours, partialOpeningHours },
    publicProfiles: rows,
  };
}

export function serializeCsv(rows) {
  function cell(value) {
    let text = value === null || value === undefined ? "" : String(value);
    // Public names and addresses are untrusted text. Keep Excel from treating
    // them as formulas when the CSV is opened directly.
    if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }
  return `\uFEFF${[
    EXPORT_COLUMNS.map(([, label]) => cell(label)).join(";"),
    ...rows.map((row) => EXPORT_COLUMNS.map(([key]) => cell(row[key])).join(";")),
  ].join("\r\n")}\r\n`;
}

function runSelfTests() {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const schedule = (weekly, source = "manual", timezone = "Europe/Belgrade") => JSON.stringify({ version: 1, generatedAt: new Date(now).toISOString(), source, timezone, weekly });
  const openDay = { day: 6, closed: false, windows: [{ day: 6, start: "20:00", end: "02:00", spansNextDay: true }] };
  const venue = { _id: "stable-id", name: "Test", instagramHandle: "test", latitude: 44.8, longitude: 20.4 };
  assert.equal(classifyPublicVenue(venue, now).missingOpeningHours, true);
  for (const [latitude, longitude] of [[0, 0], [91, 20], [44, -181], [null, 20], ["44", 20]]) {
    assert.equal(classifyPublicVenue({ ...venue, latitude, longitude }, now).missingMapLocation, true);
  }
  assert.equal(classifyPublicVenue(venue, now).missingMapLocation, false);
  const partial = classifyPublicVenue({ ...venue, hoursJson: schedule([openDay]), hoursExpiresAt: now - 1 }, now);
  assert.equal(partial.partialOpeningHours, true);
  assert.equal(partial.missingOpeningHours, false);
  assert.equal(partial.expiredCache, true);
  assert.equal(partial.knownDays, "Subota");
  assert.equal(partial.missingDays.includes("Subota"), false);
  assert.equal(classifyPublicVenue({ ...venue, hoursJson: schedule([{ day: 0, closed: true, windows: [] }]) }, now).missingOpeningHours, false);
  assert.equal(classifyPublicVenue({ ...venue, hoursJson: schedule([openDay], "none") }, now).missingOpeningHours, true);
  assert.equal(classifyPublicVenue({ ...venue, hoursJson: "invalid" }, now).missingOpeningHours, true);
  assert.equal(classifyPublicVenue({ ...venue, hoursJson: schedule([openDay], "manual", "invalid/zone") }, now).timezoneStatus, "Neispravna");
  assert.throws(() => buildVenueGapSnapshot([venue, venue], { now, convexUrl: DEFAULT_CONVEX_URL }), /Duplicate/);
  const snapshot = buildVenueGapSnapshot([venue], { now, convexUrl: DEFAULT_CONVEX_URL });
  assert.equal(snapshot.counts.publicProfiles, 1);
  assert.equal(snapshot.counts.missingMapLocation, 0);
  assert.equal(snapshot.counts.missingOpeningHours, 1);
  const csv = serializeCsv([{ name: '=HYPERLINK("bad")', address: "a;b\nc" }]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"a;b\nc"'));
  console.log("Public venue export checks passed (coordinates, missing/partial/closed hours, expiry, timezones, IDs, CSV escaping).");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") return runSelfTests();
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node --experimental-strip-types scripts/export-public-venue-data-gaps.mjs --output-dir NEW_DIRECTORY [--convex-url URL]\n       node --experimental-strip-types scripts/export-public-venue-data-gaps.mjs --self-test\n\nRead-only public API export. Creates three UTF-8 BOM semicolon CSV files and a JSON snapshot in a new directory. No credentials or mutations.");
    return;
  }
  let outputDir;
  let convexUrl = DEFAULT_CONVEX_URL;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
    if (arg === "--output-dir") outputDir = path.resolve(value);
    else if (arg === "--convex-url") convexUrl = validHttpUrl(value).replace(/\/$/, "");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!outputDir) throw new Error("--output-dir must name a new directory.");
  if (!convexUrl) throw new Error("--convex-url must be a public HTTP(S) URL without credentials.");
  const response = await fetch(`${convexUrl}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "venues:listPublicVenueFields", args: { limit: PUBLIC_DIRECTORY_LIMIT }, format: "json" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Public venue query returned HTTP ${response.status}.`);
  const result = await response.json();
  if (result.status !== "success") throw new Error("Public venue query was not successful.");
  const snapshot = buildVenueGapSnapshot(result.value, { now: Date.now(), convexUrl });
  await mkdir(outputDir, { recursive: false });
  const files = [
    ["mesta-bez-lokacije-na-mapi.csv", serializeCsv(snapshot.lists.missingMapLocation)],
    ["mesta-bez-radnog-vremena.csv", serializeCsv(snapshot.lists.missingOpeningHours)],
    ["mesta-sa-nepotpunim-radnim-vremenom.csv", serializeCsv(snapshot.lists.partialOpeningHours)],
    ["venue-data-gaps.json", `${JSON.stringify(snapshot, null, 2)}\n`],
  ];
  const manifest = { generatedAt: snapshot.generatedAt, source: snapshot.source, counts: snapshot.counts, files: [] };
  for (const [name, content] of files) {
    await writeFile(path.join(outputDir, name), content, { flag: "wx" });
    manifest.files.push({ name, sha256: createHash("sha256").update(content).digest("hex") });
  }
  await writeFile(path.join(outputDir, "export-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ outputDir, generatedAt: snapshot.generatedAt, counts: snapshot.counts }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
