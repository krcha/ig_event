import assert from "node:assert/strict";
import { lookupPerformerRegistryProgramme } from "../convex/performerRegistry.ts";
import { normalizeTaxonomyText } from "../lib/taxonomy/venue-types.ts";

async function soloProgramme(title, handle, display, genres, overrides = {}) {
  const url = "https://www.instagram.com/" + handle + "/";
  const profile = { _id: "account", identityKey: "handle:" + handle, instagramHandle: handle,
    name: display, nameKey: normalizeTaxonomyText(display), independentAppearances: 0,
    accountEvidence: { handle, displayName: { value: display, url, quote: display + " (@" + handle + ")" }, genres } };
  const ctx = { db: {
    async get(id) { return id === "venue" ? { publicStatus: "published" } : null; },
    query(table) {
      let rows = table === "performerRegistryProfiles" ? [profile] : [];
      const bounds = {
        eq(field, value) { rows = rows.filter(row => row[field] === value); return bounds; },
        gt(field, value) { rows = rows.filter(row => row[field] > value); return bounds; },
      };
      return { withIndex(_index, predicate) { predicate(bounds); return this; }, order() { return this; },
        async unique() { return rows[0] ?? null; }, async take(limit) { return rows.slice(0, limit); } };
    },
  } };
  const artists = [title, "@" + handle];
  const event = { _id: "appearance", date: "2026-11-28", artists, title, updatedAt: 1,
    status: "approved", publicationState: "publishable", publicationPolicyVersion: 1,
    publicationReason: "canonical_source_grounding_verified", eventType: "live music", venueId: "venue", venue: "Venue",
    sourceCaption: "Tonight @" + handle, normalizedFieldsJson: JSON.stringify({ identityEvidenceVerified: true, artists }), ...overrides };
  return (await lookupPerformerRegistryProgramme(ctx, event, [])).matches;
}

const pop = [{ genre: "pop", quote: "We play pop music.", url: "https://artist.example/bio" }];
for (const [title, handle, name] of [
  ["MAKAO", "makaobend", "MAKAO"], ["RUSH Bend", "rush__band", "RUSH BAND"], ["Dea Dia", "dea.dia.band", "Dea Dia"],
]) {
  assert.deepEqual((await soloProgramme(title, handle, name, pop)).map(m => [m.performer, m.genre]), [[title, "pop"]]);
}
const folk = { genre: "folk", quote: "Popularni folk pevač Peđa Medenica", url: "https://artist.example/profile",
  binding: { quote: "Pedja Medenica (@medenica_pedja)", url: "https://artist.example/profile" } };
assert.equal((await soloProgramme("PEDA Medenica", "medenica_pedja", "Pedja Medenica", [folk]))[0]?.genre, "folk");
for (const options of [
  ["PEDA Medenica", "medenica_pedja", "Pedja Medenica", [{ ...folk, quote: "Pedja Medenica sings folk" }]],
  ["PEDA Medenica", "medenica_pedja", "Pedja Medenica", [{ ...folk, binding: undefined }]],
  ["Different Name", "rush__band", "RUSH BAND", pop],
  ["Dea Dia", "dea.dia.band", "Dea Dia", pop, { title: "Tribute to Dea Dia" }],
  ["Dea Dia", "dea.dia.band", "Dea Dia", pop, { sourceCaption: "Photo: @dea.dia.band" }],
  ["Dea Dia", "dea.dia.band", "Dea Dia", pop, { artists: ["Dea Dia", "@dea.dia.band", "Another act"] }],
  ["Dea Dia", "dea.dia.band", "Dea Dia", pop, { sourceConflictFields: ["artists"] }],
  ["Dea Dia", "dea.dia.band", "Dea Dia", pop, { status: "pending" }],
]) assert.deepEqual(await soloProgramme(...options), []);
