import "./qa-performer-registry-solo-billing.mjs";
import assert from "node:assert/strict";
import { projectPublicEvent, publicPerformerSearchFields } from "../convex/publicEventProjection.ts";
import { matchesPublicEventNameArtistOrVenue } from "../lib/events/public-event-search.ts";
import { buildPublicCalendarOverviewPage } from "../lib/events/public-calendar-overview-types.ts";
import * as accountResearch from "../convex/performerAccountResearch.ts";
import * as directory from "../convex/performerDirectory.ts";
import { validateAccountEvidence } from "../convex/performerAccountEvidence.ts";
import { getFunctionName } from "convex/server";
import { listDailyInputs } from "../convex/eventDiscovery.ts";
import {
  loadScopedPerformerHandles,
  scopedPerformerHandles,
} from "../convex/occurrencePerformerCredits.ts";
import { resolveEventGenresBatch } from "../lib/ai/resolve-event-genres.ts";
import {
  advanceBackfill,
  backfillInstagramHandles,
  findProfiles,
  getBackfillStatus,
  kickBackfill,
  listAppearances,
  lookupPerformerRegistryProgramme,
  lookupPerformerRegistrySearchHints,
  readProfile,
  syncPerformerRegistryForEvent,
  wakeAffectedAppearances,
} from "../convex/performerRegistry.ts";
import {
  evidenceForCredits,
  registryCredits,
} from "../convex/performerRegistryEvidence.ts";

function memory() {
  const tables = new Map(),
    jobs = [],
    writes = [],
    pages = [],
    indexReads = [];
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const find = (id) => [...tables.values()].find((t) => t.has(id));
  let seq = 0;
  const ctx = {
    scheduler: {
      async runAfter(delay, fn, args) {
        jobs.push({ delay, name: getFunctionName(fn), args });
      },
    },
    db: {
      async get(id) {
        return find(id)?.get(id) ?? null;
      },
      async insert(name, data) {
        const id = name + "-" + ++seq;
        table(name).set(id, { ...data, _id: id, _creationTime: seq });
        writes.push(["insert", id]);
        return id;
      },
      async patch(id, patch) {
        const row = find(id).get(id);
        for (const [k, v] of Object.entries(patch))
          if (v === undefined) delete row[k];
          else row[k] = v;
        writes.push(["patch", id]);
      },
      async replace(id, data) {
        const t = find(id);
        t.set(id, { ...data, _id: id, _creationTime: t.get(id)._creationTime });
        writes.push(["replace", id]);
      },
      async delete(id) {
        find(id).delete(id);
        writes.push(["delete", id]);
      },
      query(name) {
        let selectedIndex;
        let predicates = [],
          desc = false;
        const rows = () => {
          const out = [...table(name).values()].filter((r) =>
            predicates.every((f) => f(r)),
          );
          if (selectedIndex === "by_account_priority") out.sort((a,b)=>a.accountRank.tier-b.accountRank.tier || a.accountRank.order-b.accountRank.order);
          if (selectedIndex === "by_profile_date_event") out.sort((a,b)=>a.date.localeCompare(b.date) || a.eventId.localeCompare(b.eventId));
          return desc ? out.reverse() : out;
        };
        return {
          withIndex(index, cb) {
            selectedIndex = index;
            indexReads.push(index);
            const b = {};
            for (const [k, fn] of Object.entries({
              eq: (a, b) => a === b,
              gte: (a, b) => a >= b,
              gt: (a, b) => b === undefined ? a !== undefined : a > b,
              lte: (a, b) => a <= b,
              lt: (a, b) => a < b,
            }))
              b[k] = (field, v) => {
                predicates.push((r) => fn(field.split(".").reduce((value, part) => value?.[part], r), v));
                return b;
              };
            cb(b);
            return this;
          },
          order(dir) {
            desc = dir === "desc";
            return this;
          },
          async unique() {
            const r = rows();
            assert.ok(r.length < 2);
            return r[0] ?? null;
          },
          async take(n) {
            assert.ok(n <= 129);
            return rows().slice(0, n);
          },
          async paginate({ cursor, numItems }) {
            const r = rows(),
              i = Number(cursor ?? 0);
            pages.push({ table: name, numItems });
            return {
              page: r.slice(i, i + numItems),
              isDone: i + numItems >= r.length,
              continueCursor: String(Math.min(i + numItems, r.length)),
            };
          },
        };
      },
    },
  };
  const put = (name, value) =>
    table(name).set(value._id, structuredClone(value));
  return { ctx, table, jobs, writes, put, pages, indexReads };
}
const h = memory(),
  { ctx } = h;
const now = Date.now;
Date.now = () => Date.parse("2026-11-27T12:00:00+01:00");
try {
  const pub = (id, artists, overrides = {}) => ({
    _id: id,
    artists,
    title: artists[0].split(" (")[0],
    status: "approved",
    publicationPolicyVersion: 1,
    publicationReason: "canonical_source_grounding_verified",
    publicationState: "publishable",
    eventType: "nightlife",
    venueId: "venue-a",
    venue: "Venue A",
    date: "2026-11-28",
    updatedAt: 1,
    ...overrides,
  });
  h.put("venues", { _id: "venue-a", publicStatus: "published" });
  h.put("venues", { _id: "venue-b", publicStatus: "published" });
  const sourceEvent = pub("source", ["Ena Selka (@ena.selka)"], {
    date: "2026-10-21",
    instagramPostUrl: "https://www.instagram.com/p/independent",
  });
  const next = pub("next", ["Ena Selka (@ena.selka)"], { eventType: "event" }),
    recurring = pub("repeat", ["Ena Selka"]);
  for (const e of [sourceEvent, next, recurring]) h.put("events", e);
  const identity = {
    url: "https://ra.co/dj/enaselka",
    quote: "Ena Selka is a Belgrade DJ, @ena.selka.",
  };
  const corroboration = {
    url: "https://label.org/artists/ena-selka",
    quote: "Ena Selka is a DJ in Belgrade.",
  };
  const act = {
    billedName: "Ena Selka",
    status: "resolved",
    identityEvidence: identity,
    identityCorroboration: corroboration,
    programmeRole: { category: "party", evidence: identity },
    genreEvidence: [
      {
        genre: "house",
        url: identity.url,
        quote: "Ena Selka primarily plays house music.",
      },
      {
        genre: "techno",
        url: identity.url,
        quote: "Ena Selka also plays techno.",
      },
    ],
  };
  const research = (acts, id = "source") => ({
    _id: "r-" + id,
    eventId: id,
    eventUpdatedAt: 1,
    version: 1,
    model: "verified-web",
    matches: acts.flatMap((a) =>
      a.genreEvidence.map((g) => ({
        performer: a.billedName,
        genre: g.genre,
        url: g.url,
        identityUrl: a.identityEvidence.url,
      })),
    ),
    auditJson: JSON.stringify({ acts, exactListing: false }),
    researchedAt: 10,
  });
  h.put("eventPerformerGenreResearch", research([act]));
  await syncPerformerRegistryForEvent(ctx, "next");
  assert.equal(
    [...h.table("performerRegistryAppearances").values()][0].profileId,
    undefined,
  );
  await syncPerformerRegistryForEvent(ctx, "source");
  const profile = [...h.table("performerRegistryProfiles").values()][0];
  assert.equal(profile.primaryGenre, "house");
  assert.deepEqual(
    (await readProfile._handler(ctx, { profileId: profile._id })).genres,
    ["house", "techno"],
  );
  const before = [h.writes.length, h.jobs.length];
  await syncPerformerRegistryForEvent(ctx, "source");
  assert.deepEqual([h.writes.length, h.jobs.length], before);
  const result = await lookupPerformerRegistryProgramme(ctx, next);
  assert.equal(result.category, "party");
  assert.deepEqual(
    result.matches.map((m) => m.genre),
    ["house"],
  );
  assert.deepEqual(await lookupPerformerRegistryProgramme(ctx, sourceEvent), {
    matches: [],
  });
  assert.equal(
    (await lookupPerformerRegistryProgramme(ctx, recurring)).matches[0].url,
    identity.url,
  );
  assert.deepEqual(
    await lookupPerformerRegistryProgramme(ctx, {
      ...recurring,
      venueId: "venue-b",
    }),
    { matches: [] },
  );
  assert.deepEqual(
    await lookupPerformerRegistryProgramme(ctx, {
      ...recurring,
      date: "2026-10-15",
    }),
    { matches: [] },
  );
  assert.deepEqual(
    await lookupPerformerRegistryProgramme(ctx, {
      ...recurring,
      eventType: "event",
    }),
    { matches: [] },
  );
  assert.deepEqual(
    await lookupPerformerRegistrySearchHints(ctx, {
      ...recurring,
      venueId: "venue-b",
    }),
    [{ performer: "Ena Selka", profileUrl: identity.url }],
  );
  assert.equal(
    (
      await lookupPerformerRegistryProgramme(ctx, {
        ...recurring,
        venueId: "venue-b",
        description: "Artist profile: " + identity.url,
      })
    ).matches.length,
    1,
  );
  assert.deepEqual(
    await lookupPerformerRegistryProgramme(ctx, {
      ...next,
      title: "Rock quiz",
      eventType: "learning",
    }),
    { matches: [] },
  );
  assert.deepEqual(
    await lookupPerformerRegistryProgramme(ctx, {
      ...next,
      artists: [...next.artists, "Other Person"],
    }),
    { matches: [] },
  );
  assert.deepEqual(registryCredits(["A b2b B", "TBA", "A / B"]), []);
  const targetWake = h.jobs.find(
    (j) =>
      j.name === "performerRegistry:wakeAffectedAppearances" &&
      j.args.kind === "handle",
  );
  await wakeAffectedAppearances._handler(ctx, targetWake.args);
  assert.ok(
    h.jobs.some(
      (j) =>
        j.name === "eventDiscovery:processPublishedEvent" &&
        j.args.eventId === "next",
    ),
  );
  await syncPerformerRegistryForEvent(ctx, "next");
  const historical = await listAppearances._handler(ctx, {
    profileId: profile._id,
    cursor: null,
  });
  assert.deepEqual(
    new Set(historical.page.map((a) => a.eventId)),
    new Set(["source", "next"]),
  );
  assert.ok(historical.page.every((a) => a.status === "announced"));
  const sameName = pub("namesake", ["Ena Selka"], { date: "2026-10-12" });
  const home = {
    url: "https://label-other.org/artists/ena-selka",
    quote: "Ena Selka is a performing DJ.",
  };
  h.put("events", sameName);
  h.put(
    "eventPerformerGenreResearch",
    research(
      [
        {
          ...act,
          identityEvidence: home,
          identityCorroboration: null,
          programmeRole: { category: "party", evidence: home },
          genreEvidence: [
            { genre: "rock", url: home.url, quote: "Ena Selka plays rock." },
          ],
        },
      ],
      "namesake",
    ),
  );
  await syncPerformerRegistryForEvent(ctx, "namesake");
  assert.deepEqual(await lookupPerformerRegistryProgramme(ctx, recurring), {
    matches: [],
  });
  assert.equal(
    (await lookupPerformerRegistryProgramme(ctx, next)).matches.length,
    1,
    "A confirmed handle distinguishes homonyms",
  );
  assert.deepEqual(
    await lookupPerformerRegistrySearchHints(ctx, recurring),
    [],
  );

  const cached = {
    ...research([act], "next"),
    model: "performer-registry-v1",
    auditJson: JSON.stringify({ source: "performer-registry", acts: [act] }),
  };
  h.put("eventPerformerGenreResearch", cached);
  await syncPerformerRegistryForEvent(ctx, "next");
  const cachedAppearance = [
    ...h.table("performerRegistryAppearances").values(),
  ].find((a) => a.eventId === "next");
  assert.equal(cachedAppearance.independent, false);
  h.table("eventPerformerGenreResearch").delete("r-source");
  assert.deepEqual(
    await lookupPerformerRegistryProgramme(ctx, next),
    { matches: [] },
    "Removal invalidates reuse before backfill",
  );
  assert.deepEqual(
    (await readProfile._handler(ctx, { profileId: profile._id })).genres,
    [],
  );
  await syncPerformerRegistryForEvent(ctx, "source");
  assert.equal(
    h.table("performerRegistryProfiles").get(profile._id).primaryGenre,
    undefined,
  );
  assert.equal(
    h.table("performerRegistryProfiles").get(profile._id)
      .independentAppearances,
    0,
  );
  const count = h.jobs.length;
  await wakeAffectedAppearances._handler(ctx, targetWake.args);
  assert.ok(
    h.jobs
      .slice(count)
      .some(
        (j) =>
          j.name === "eventDiscovery:processPublishedEvent" &&
          j.args.eventId === "next",
      ),
  );
  await syncPerformerRegistryForEvent(ctx, "next");
  assert.equal(
    h.jobs
      .slice(count)
      .filter((j) => j.name === "performerRegistry:wakeAffectedAppearances")
      .length,
    0,
  );
  assert.equal(
    (
      await listAppearances._handler(ctx, {
        profileId: profile._id,
        cursor: null,
      })
    ).page.length,
    0,
  );
  h.table("events").delete("next");
  await syncPerformerRegistryForEvent(ctx, "next");
  assert.ok(
    ![...h.table("performerRegistryAppearances").values()].some(
      (a) => a.eventId === "next",
    ),
  );

  const lineup = pub("lineup", ["Ena Selka"], { title: "Friday lineup" });
  const exact = {
    ...research([act], "lineup"),
    auditJson: JSON.stringify({ acts: [act], exactListing: true }),
  };
  assert.equal(evidenceForCredits(lineup, exact, null)[0].proof, undefined);
  const listing = {
    url: "https://festival.org/events/friday",
    quote: "Ena Selka and friends. Friday night line-up.",
  };
  const atListing = {
    ...act,
    identityEvidence: listing,
    identityCorroboration: null,
    programmeRole: undefined,
    genreEvidence: [
      {
        genre: "techno",
        url: listing.url,
        quote: "Friday night techno lineup: Ena Selka and many guests.",
      },
    ],
  };
  assert.deepEqual(
    evidenceForCredits(lineup, research([atListing], "lineup"), null)[0].proof
      .genres,
    [],
  );
  const gift = pub("editorial", ["GIFT"], {
    instagramPostUrl: "https://www.instagram.com/p/test",
    eventType: "live music",
  });
  const reviewed = {
    review: "review-1",
    listingUrl: gift.instagramPostUrl,
    listingRow: "Friday GIFT",
    genreScope: "named-artist",
    identityUrl: "https://label.org/novi-sad/gift",
    identityProof: "novosadskog benda Gift",
    basis: "The operator confirmed this band.",
    genreEvidence: ["britpop, alternativni rock"],
  };
  const r = {
    ...research([], "editorial"),
    model: "review-1",
    matches: [
      {
        genre: "pop",
        performer: "GIFT",
        url: "https://magazine.org/story/gift",
        identityUrl: reviewed.identityUrl,
      },
    ],
    auditJson: JSON.stringify(reviewed),
  };
  assert.equal(
    evidenceForCredits(gift, r, null)[0].proof.role.category,
    "live",
  );
  assert.equal(
    evidenceForCredits(gift, r, null)[0].proof.genres[0].genre,
    "pop",
  );
  assert.equal(
    evidenceForCredits({ ...gift, updatedAt: 2 }, r, null)[0].proof,
    undefined,
  );
  assert.equal(
    evidenceForCredits(
      { ...gift, artists: ["An unrelated person", "GIFT"] },
      r,
      null,
    )[0].proof,
    undefined,
  );
  const credited = memory();
  credited.put("venues", { _id: "venue-a", publicStatus: "published" });
  const withCredit = (id, artists, date, row, caption, other = {}) =>
    pub(id, artists, {
      date,
      createdAt: 10,
      _creationTime: 10,
      instagramPostId: id,
      instagramPostUrl: "https://www.instagram.com/p/" + id + "/",
      sourceCaption: caption,
      normalizedFieldsJson: JSON.stringify({ rowSourceText: row, ...other }),
    });
  const teodora = withCredit(
    "teodora",
    ["Teodora Šćepanović"],
    "2026-11-27",
    "TEODORA ŠĆEPANOVIĆ; petak 27/11",
    "Omiljene pesme.\n@teodora.scepanovic ponovo je sa nama 27. novembra u Lavashu!\nRezervacije na broj.",
  );
  const riskExcerpt = "PETAK / @risk.jockey veče muzike 90ih";
  const risk = withCredit(
    "risk",
    ["RISK JOCKEY"],
    "2026-11-27",
    "PETAK, 27. NOVEMBAR 20.00H\nRISK JOCKEY 90’S NIGHT",
    riskExcerpt + "\nSUBOTA / @other.dj",
    {
      multiEventSplitDetected: true,
      carouselTextEvidence: [{ source: "caption", text: riskExcerpt }],
    },
  );
  const ponorExcerpt =
    "SUB 28.11. u 20h - Cloud Session 323 ponor: otnl & pallifaty @pallifaty";
  const duo = withCredit(
    "duo",
    ["otnl", "pallifaty"],
    "2026-11-28",
    ponorExcerpt,
    "PET 27.11. Petkov koncert @otnl\n" + ponorExcerpt,
    { multiEventSplitDetected: true },
  );
  const actualCredits = [
    [{ performer: "Teodora Šćepanović", handle: "teodora.scepanovic" }],
    [{ performer: "RISK JOCKEY", handle: "risk.jockey" }],
    [{ performer: "pallifaty", handle: "pallifaty" }],
  ];
  const fixtureEvents = [teodora, risk, duo];
  for (const [i, e] of fixtureEvents.entries()) {
    credited.put("events", e);
    const saved = structuredClone(e.artists);
    assert.deepEqual(
      await loadScopedPerformerHandles(credited.ctx, e),
      actualCredits[i],
    );
    await syncPerformerRegistryForEvent(credited.ctx, e._id);
    assert.deepEqual(
      e.artists,
      saved,
      "Source-bound artist fields remain byte-identical",
    );
  }
  const appearances = [
    ...credited.table("performerRegistryAppearances").values(),
  ];
  assert.deepEqual(
    appearances.map((a) => [a.name, a.handle]),
    [
      ["Teodora Šćepanović", "teodora.scepanovic"],
      ["RISK JOCKEY", "risk.jockey"],
      ["otnl", undefined],
      ["pallifaty", "pallifaty"],
    ],
  );
  assert.ok(
    appearances.every((a) => !a.independent && (!!a.profileId === !!a.handle)),
    "A confirmed billing creates a contact profile without supplying independent genre evidence",
  );
  assert.equal(credited.table("performerRegistryProfiles").size, 3);
  const [performer] = (await findProfiles._handler(credited.ctx, { name: "https://www.instagram.com/teodora.scepanovic/" })).profiles;
  const registryProfile = await readProfile._handler(credited.ctx, { profileId: performer.profileId });
  assert.deepEqual([registryProfile.name, registryProfile.instagramHandle, registryProfile.primaryGenre, registryProfile.genres],
    ["Teodora Šćepanović", "teodora.scepanovic", null, []]);
  assert.deepEqual((await listAppearances._handler(credited.ctx, { profileId: performer.profileId, cursor: null })).page.map(row => row.eventId), [teodora._id]);
  assert.deepEqual((await findProfiles._handler(credited.ctx, { name: "https://www.instagram.com/p/teodora/" })).profiles, []);
  assert.deepEqual(await lookupPerformerRegistryProgramme(credited.ctx, teodora), { matches: [] });
  const billingBackfill = await backfillInstagramHandles._handler(credited.ctx, { phase: "billing", cursor: null });
  assert.equal(billingBackfill.billingLinksWritten, 0);
  assert.equal(billingBackfill.handlesAdded, 0);
  const exactProfileId = performer.profileId;
  const storedBilling = credited.table("performerRegistryAppearances").get(appearances[0]._id);
  delete storedBilling.confirmedBilling;
  delete credited.table("performerRegistryProfiles").get(exactProfileId).instagramHandle;
  const restored = await backfillInstagramHandles._handler(credited.ctx, { phase: "billing", cursor: null });
  assert.deepEqual([restored.profilesCreated, restored.handlesAdded, restored.billingLinksWritten], [0, 1, 1]);
  credited.table("events").get(teodora._id).status = "rejected";
  assert.deepEqual((await findProfiles._handler(credited.ctx, { name: "@teodora.scepanovic" })).profiles, [], "Stale materialized billings cannot identify a withdrawn performer.");
  assert.equal((await syncPerformerRegistryForEvent(credited.ctx, teodora._id)).handlesCleared, 1);
  credited.put("events", teodora);
  await syncPerformerRegistryForEvent(credited.ctx, teodora._id);
  const mismatched = { ...act, identityEvidence: { url: "https://www.instagram.com/someone.else/", quote: "Ena Selka profile." } };
  assert.equal(evidenceForCredits(sourceEvent, research([mismatched], sourceEvent._id), null)[0].proof, undefined,
    "Contradictory external and billed Instagram identities do not authorize a genre.");
  {
    const seeded = memory();
    seeded.put("venues", { _id: "venue-a", publicStatus: "published" });
    const bill = pub("band-origin", ["@sela.band"], { venueInstagramHandle: "club", sourceCaption: "Svirku otvara @sela.band.",
      normalizedFieldsJson: JSON.stringify({ artists: ["@sela.band"], identityEvidenceVerified: true, sourceGroundingInstagramHandle: "club" }) });
    const artistPage = { url: "https://artist-directory.org/artist/sela-band", quote: "Sela Band is a rock band from Serbia." };
    const verified = { billedName: "@sela.band", status: "resolved", identityEvidence: artistPage,
      genreEvidence: [{ genre: "rock", ...artistPage }] };
    const report = { ...research([verified], bill._id), matches: [{ performer: "@sela.band", genre: "rock", identityUrl: artistPage.url, url: artistPage.url }] };
    seeded.put("events", bill); seeded.put("eventPerformerGenreResearch", report);
    seeded.put("performerRegistryProfiles", { _id: "stable-profile", identityKey: 'profile:["sela band","https://artist-directory.org/artist/sela-band"]',
      name: "@sela.band", nameKey: "sela band", support: [], independentAppearances: 0 });
    const delta = await syncPerformerRegistryForEvent(seeded.ctx, bill._id);
    assert.equal(delta.profilesCreated, 0);
    assert.equal(delta.handlesAdded, 1);
    assert.equal(seeded.table("performerRegistryProfiles").size, 1);
    const profile = await readProfile._handler(seeded.ctx, { profileId: "stable-profile" });
    assert.deepEqual([profile.name, profile.instagramHandle, profile.primaryGenre], ["Sela Band", "sela.band", "rock"]);
    const future = { ...bill, _id: "band-next", date: "2027-01-01" };
    assert.equal((await lookupPerformerRegistryProgramme(seeded.ctx, future)).matches[0].genre, "rock");
    assert.deepEqual((await lookupPerformerRegistryProgramme(seeded.ctx, { ...future, sourceCaption: "Photo: @sela.band" })).matches, []);
    const other = { ...future, artists: ["Another Performer (@sela.band)"] };
    assert.deepEqual((await lookupPerformerRegistryProgramme(seeded.ctx, other)).matches, []);
    const repeat = await backfillInstagramHandles._handler(seeded.ctx, { phase: "research", cursor: null });
    assert.deepEqual([repeat.profilesCreated, repeat.handlesAdded, repeat.billingLinksWritten], [0, 0, 0]);
  }

  const tagLine = "SAT / @vuk_vukosavljevic @itsrossv @milhousemusic",
    vukRow = "28 NOVEMBER / SATURDAY NIGHT";
  const vukFields = {
    multiEventSplitDetected: true,
    carouselTextEvidence: [{ source: "caption", text: tagLine }],
    carouselDisplaySlideIndex: 4,
    carouselSourceSlideIndexes: [4],
    carouselPosterEvidence: [
      { slide_index: 4, text: vukRow },
      { slide_index: 4, text: "VUK VUKOSAVLJEVIĆ × MILHØUSE × ROSSA" },
    ],
  };
  const vuk = withCredit(
    "vuk",
    ["VUK VUKOSAVLJEVIĆ", "MILHØUSE", "ROSSA", "@itsrossv", "@milhousemusic"],
    "2026-11-28",
    vukRow,
    "FRI / @friday\n" + tagLine,
    vukFields,
  );
  assert.deepEqual(await loadScopedPerformerHandles(credited.ctx, vuk), [
    { performer: "VUK VUKOSAVLJEVIĆ", handle: "vuk_vukosavljevic" },
  ]);
  const duleRow = "SUBOTA, 28. NOVEMBAR 20.00H\nDULE RADETIĆ\nBAŠ HITOVI",
    duleLine = "SUBOTA / @bash_hitovi @dule.radetic";
  const dule = withCredit(
    "dule",
    ["DULE RADETIĆ", "@bash_hitovi"],
    "2026-11-28",
    duleRow,
    "PETAK / @risk.jockey\n" + duleLine,
    {
      multiEventSplitDetected: true,
      carouselTextEvidence: [{ source: "caption", text: duleLine }],
    },
  );
  assert.deepEqual(await loadScopedPerformerHandles(credited.ctx, dule), [
    { performer: "DULE RADETIĆ", handle: "dule.radetic" },
  ]);
  for (const alternate of [
    { ...vukFields, carouselDisplaySlideIndex: 3 },
    {
      ...vukFields,
      carouselPosterEvidence: [
        { slide_index: 4, text: vukRow },
        { slide_index: 3, text: "VUK VUKOSAVLJEVIĆ × MILHØUSE × ROSSA" },
      ],
    },
    {
      ...vukFields,
      carouselPosterEvidence: [
        { slide_index: 4, text: "27 NOVEMBER / FRIDAY NIGHT" },
        { slide_index: 4, text: "VUK VUKOSAVLJEVIĆ × MILHØUSE × ROSSA" },
      ],
    },
    {
      ...vukFields,
      carouselPosterEvidence: [
        { slide_index: 4, text: vukRow },
        { slide_index: 4, text: "Foto: VUK VUKOSAVLJEVIĆ" },
      ],
    },
    {
      ...vukFields,
      carouselTextEvidence: [
        {
          source: "caption",
          text: "FRI / @vuk_vukosavljevic @itsrossv @milhousemusic",
        },
      ],
    },
  ]) {
    assert.deepEqual(
      scopedPerformerHandles(vuk, alternate, vukRow, tagLine),
      [],
    );
  }
  assert.deepEqual(
    scopedPerformerHandles(
      { ...vuk, artists: vuk.artists.filter((a) => a !== "@itsrossv") },
      vukFields,
      vukRow,
      tagLine,
    ),
    [],
  );
  assert.deepEqual(
    scopedPerformerHandles(
      { ...vuk, sourceCaption: "Sponzori:\n" + tagLine },
      vukFields,
      vukRow,
      tagLine,
    ),
    [],
  );
  assert.deepEqual(
    scopedPerformerHandles(
      { ...vuk, eventType: "learning" },
      vukFields,
      vukRow,
      tagLine,
    ),
    [],
  );
  const raw = "TEODORA ŠĆEPANOVIĆ; petak 27/11";
  for (const bad of [
    "Subota 28.11. @teodora.scepanovic ponovo je sa nama.",
    "November 28: @teodora.scepanovic ponovo je sa nama.",
    "Teodora Šćepanović @teodora.scepanovic – fotograf",
    "📸 Teodora Šćepanović @teodora.scepanovic",
    "Rezervacije: Teodora Šćepanović @teodora.scepanovic",
    "Sponzor: Teodora Šćepanović @teodora.scepanovic",
    "@teodora.scepanovic ne nastupa",
    "@teodora.scepanovic ponovo je sa nama.\nNastup je otkazan.",
    "@teodora.scepanovic",
    "PETAK: @teodora_scepanovic nastupa i @teodora.scepanovic nastupa.",
  ]) {
    assert.deepEqual(scopedPerformerHandles(teodora, {}, raw, bad), [], bad);
  }
  assert.deepEqual(
    scopedPerformerHandles(
      { ...teodora, venueInstagramHandle: "teodora.scepanovic" },
      {},
      raw,
      teodora.sourceCaption,
    ),
    [],
  );
  assert.deepEqual(
    scopedPerformerHandles(
      teodora,
      { sourceAccountName: "Teodora Šćepanović" },
      raw,
      teodora.sourceCaption,
    ),
    [],
  );
  assert.deepEqual(
    scopedPerformerHandles(
      teodora,
      { sourceOccurrencePlanUnverified: true },
      raw,
      teodora.sourceCaption,
    ),
    [],
  );
  assert.deepEqual(
    scopedPerformerHandles(
      { ...teodora, artists: ["Teo-dora Šćepanović"] },
      {},
      raw,
      teodora.sourceCaption,
    ),
    [],
  );
  const foreign = {
    ...risk,
    normalizedFieldsJson: JSON.stringify({
      multiEventSplitDetected: true,
      rowSourceText: "Petak RISK JOCKEY 27.11.",
    }),
  };
  assert.deepEqual(
    await loadScopedPerformerHandles(credited.ctx, foreign),
    [],
    "A neighbouring Instagram excerpt is unavailable to this appearance",
  );
  // The public-worker-compatible optional field must reach the ordinary resolver without changing billedName.
  const svc = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "fixture-handle-secret";
  try {
    const run = {
      _id: "run-credits",
      mode: "daily",
      status: "completed",
      dailyDayKey: "2026-11-27",
      createdAt: 1,
      finishedAt: 20,
    };
    credited.put("ingestionRuns", run);
    for (const e of fixtureEvents) {
      credited.put("scrapedPosts", {
        _id: "post-" + e._id,
        postId: e.instagramPostId,
        handle: e._id,
      });
      credited.put("ingestionRunHandleReceipts", {
        _id: "receipt-" + e._id,
        runId: run._id,
        handle: e._id,
        scrapedPostId: "post-" + e._id,
      });
    }
    const daily = await listDailyInputs._handler(credited.ctx, {
      runId: run._id,
      cursor: null,
      serviceSecret: process.env.CRON_SECRET,
    });
    assert.deepEqual(
      daily.events.map((e) => e.performerHandles),
      actualCredits,
    );
    assert.deepEqual(
      daily.events.map((e) => e.artists),
      fixtureEvents.map((e) => e.artists),
    );
    const seen = [];
    const classification = {
      primaryCategory: "party",
      categories: ["party"],
      formats: ["party"],
      genres: [],
    };
    const unresolved = await resolveEventGenresBatch(
      daily.events.map((e) => ({ ...e, currentTaxonomy: classification })),
      {
        classify: async (rows) => ({
          model: "mock",
          usage: {},
          results: rows.map(({ key }) => ({
            key,
            taxonomy: null,
            credits: [],
            evidence: [],
            discardedClaims: 0,
          })),
        }),
        research: async (rows) => {
          seen.push(...rows);
          return {
            model: "mock",
            usage: {},
            attempts: 1,
            searchCalls: 0,
            results: new Map(
              rows.map((r) => [
                r.key,
                {
                  status: "unverified",
                  billedName: r.billedName,
                  genres: [],
                  identityEvidence: null,
                  genreEvidence: [],
                },
              ]),
            ),
          };
        },
        estimate: async (rows) => ({
          model: "mock",
          usage: {},
          results: new Map(rows.map((r) => [r.key, []])),
        }),
      },
    );
    assert.deepEqual(
      seen.map((r) => [r.billedName, r.billedHandle]),
      appearances.map((a) => [a.name, a.handle]),
    );
    assert.ok(
      unresolved.results.every((r) => !r.webResearch),
      "A billing handle never turns an unverified provider response into evidence",
    );
  } finally {
    if (svc === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = svc;
  }
  // A verified external profile can be reused later even when the Instagram handles
  // were credited only in each occurrence's source, not persisted in events.artists.
  const oldBill = withCredit(
    "named-origin",
    ["Ena Selka"],
    "2026-11-20",
    "PETAK 20.11. Ena Selka",
    "PETAK 20.11. Ena Selka @ena.selka",
  );
  const newBill = {
    ...withCredit(
      "named-target",
      ["Ena Selka"],
      "2026-11-27",
      "PETAK 27.11. Ena Selka",
      "PETAK 27.11. Ena Selka @ena.selka",
    ),
    venueId: "venue-b",
    eventType: "event",
  };
  credited.put("venues", { _id: "venue-b", publicStatus: "published" });
  for (const e of [oldBill, newBill]) credited.put("events", e);
  credited.put("eventPerformerGenreResearch", research([act], oldBill._id));
  await syncPerformerRegistryForEvent(credited.ctx, oldBill._id);
  assert.ok(
    [...credited.table("performerRegistryProfiles").values()].some(
      (p) => p.identityKey === "handle:ena.selka",
    ),
  );
  const reused = await lookupPerformerRegistryProgramme(credited.ctx, newBill);
  assert.equal(reused.category, "party");
  assert.equal(reused.matches[0].url, identity.url);
  assert.deepEqual(
    await lookupPerformerRegistryProgramme(credited.ctx, {
      ...newBill,
      sourceCaption: "",
    }),
    { matches: [] },
  );
  const back = memory();
  back.put("venues", { _id: "venue-a", publicStatus: "published" });
  for (let i = 0; i < 9; i++)
    back.put(
      "events",
      pub("future-" + i, ["Known Artist"], {
        date: i % 2 ? "2026-11-27" : "2025-12-05",
      }),
    );
  const started = await kickBackfill._handler(back.ctx, {});
  assert.equal(started.phase, "priority");
  await kickBackfill._handler(back.ctx, {});
  assert.equal(back.jobs.length, 1);
  for (let i = 0; i < 100 && back.jobs.length; i++) {
    const job = back.jobs.shift();
    if (job.name !== "performerRegistry:advanceBackfill") continue;
    await advanceBackfill._handler(back.ctx, job.args);
    const size = back.writes.length;
    await advanceBackfill._handler(back.ctx, job.args);
    assert.equal(back.writes.length, size);
  }
  assert.equal((await getBackfillStatus._handler(back.ctx, {})).phase, "done");
  assert.equal(back.table("performerRegistryAppearances").size, 9);
  assert.ok(back.pages.every((p) => p.numItems <= 4));
  const oldWrites = back.writes.length;
  await kickBackfill._handler(back.ctx, {});
  assert.equal(back.writes.length, oldWrites);
  console.log(
    "Performer registry QA passed: external identity and source scope, dominant genres, multi-act abstention, retraction, bounded wake and resumable backfill.",
  );
  // Real account/role and explicit cross-directory identity controls.
  const vk = "vukashii", dj = "https://djs.rs/vukashi", self = "https://www.instagram.com/vukashii/";
  const source = {genre:"drum-and-bass",url:dj,quote:`"knowsAbout":["Dubstep","Bass House","Drum'n'bass"]`};
  const project = (genre, identityLink) => validateAccountEvidence({handle:vk, genres:[genre],identityLink},vk,"Vukashi").genres;
  assert.equal(project(source,{url:dj,quote:self}).length,1);
  assert.equal(project(source,{url:dj,quote:self+"guest/"}).length,0);
  assert.equal(project({...source,url:"https://djs.rs/another-dj"},{url:dj,quote:self}).length,0);
  const apple="https://music.apple.com/rs/artist/vukashi/1234";
  const mb="https://musicbrainz.org/artist/e25d9d2a-4a90-4471-ac92-3ef5e19b72ca/url";
  const structured={genre:"house",url:apple,quote:"Genre: House"};
  assert.equal(project(structured,{url:mb,quote:JSON.stringify([self,apple])}).length,1);
  const catalog = {genre:"folk",url:"https://itunes.apple.com/lookup?id=1234",quote:'"primaryGenreName":"Folk"'};
  assert.equal(project(catalog,{url:mb,quote:JSON.stringify([self,"https://music.apple.com/ca/artist/1234"])})[0].dominant,true);
  assert.equal(project(structured,{url:mb,quote:JSON.stringify([self,apple])})[0].dominant,undefined);
  assert.equal(project(catalog,{url:mb,quote:JSON.stringify([self,"https://itunes.apple.com/artist/id12345"])}).length,0);
  assert.equal(project(structured,{url:mb,quote:JSON.stringify([self,apple+"5"])}).length,0);
  for (const quote of ["I am not a techno DJ","Tonight: a guest techno DJ","Favourite techno playlist","My sister is a techno DJ"]) {
    assert.equal(project({genre:"techno",url:self,quote}).length,0,quote);
  }

  const selfIdentity={url:self,quote:"#musician #singer #northband"};
  const precise={handle:vk,displayName:{value:"Kaja Vala",url:self,quote:"Kaja Vala (@vukashii) • Instagram photos and videos"},identityLink:selfIdentity};
  const report={genre:"pop",url:"https://live-music.org/interviews/kaja",quote:'Kaja Vala, mlada pop pjevačica iz Zagreba, koja je sa svojim bendom "North bend" nastupala.'};
  assert.equal(validateAccountEvidence({...precise,genres:[report]},vk).genres.length,1);
  for (const fault of [{...report,quote:report.quote.replace("Kaja Vala","Maja Vala")},{...report,quote:report.quote.replace("North bend","South bend")},
    {...report,quote:report.quote.replace("pop pjevačica","pevačica").replace("North bend","North pop bend")}]) {
    assert.equal(validateAccountEvidence({...precise,genres:[fault]},vk).genres.length,0);
  }
  assert.equal(validateAccountEvidence({...precise,identityLink:{url:self,quote:"my friend's #northband #singer"},genres:[report]},vk).genres.length,0);

  const q=memory();
  q.put("venues",{_id:"venue-a",publicStatus:"published"});
  let time=Date.parse("2026-11-27T19:00:00+01:00");
  Date.now=()=>time;
  const owner="12345678-1234-4234-9234-123456789abc";
  const serviceSecret="qa-account-local-profiles";
  const envSecret=process.env.CRON_SECRET;
  process.env.CRON_SECRET=serviceSecret;
  try {
    async function booking(id,handle,date,at) {
      const artists=["@"+handle];
      const e=pub(id,artists,{date,title:"DJ "+artists[0],time:at,timeStatus:"confirmed",sourceCaption:"DJ "+artists[0],
        normalizedFieldsJson:JSON.stringify({identityEvidenceVerified:true,sourceGroundingArtistsVerified:true,artists})});
      q.put("events",e);
      await syncPerformerRegistryForEvent(q.ctx,id);
      return e;
    }
    await booking("previous-account","pastaccount","2026-11-01","18:00");
    for(let i=0;i<15;i++) await booking("later-account-"+i,"busyaccount","2026-12-08","18:00");
    await booking("beyond-48h","boundaryaccount","2026-11-29","19:00");
    const near=await booking("imminent-account","nearaccount","2026-11-29","18:59");
    async function drainRanks() {
      while (q.jobs.length) {
        const job=q.jobs.shift();
        if (job.name==="performerAccountResearch:advanceRank") await accountResearch.advanceRank._handler(q.ctx,job.args);
      }
    }
    const rpc={serviceSecret,owner};
    const claim=phase=>accountResearch.claim._handler(q.ctx,{...rpc,phase});
    assert.equal(await claim("instagram"),null,"Complete ranking across all pages before selection");
    await drainRanks();
    const nearProfile=[...q.table("performerRegistryProfiles").values()].find(p=>p.instagramHandle==="nearaccount");
    assert.equal(nearProfile.accountRank.tier,0);
    assert.equal([...q.table("performerRegistryProfiles").values()].find(p=>p.instagramHandle==="busyaccount").accountRank.order,-15);
    assert.equal([...q.table("performerRegistryProfiles").values()].find(p=>p.instagramHandle==="boundaryaccount").accountRank.tier,1);
    assert(q.pages.some(p=>p.table==="performerRegistryAppearances" && p.numItems===12));
    const historical=[...q.table("performerRegistryProfiles").values()].find(p=>p.instagramHandle==="pastaccount");
    const priorRank=historical.accountRank;
    historical.accountRank={...priorRank,ready:false};
    q.indexReads.length=0;
    const due=await claim("instagram");
    assert(!q.indexReads.includes("by_account_pending") && !q.indexReads.includes("by_account_refresh"),
      "A ready imminent claim must not conflict with unrelated bootstrap, pending or refresh index writes");
    historical.accountRank=priorRank;
    assert.equal(due.handle,"nearaccount");
    const args={...rpc,handle:due.handle,profileId:due.profileId};
    const proof={handle:due.handle,displayName:{value:"Near Account",url:"https://www.instagram.com/nearaccount/",quote:"Near Account (@nearaccount) • Instagram photos and videos"},genres:[]};
    await accountResearch.complete._handler(q.ctx,{...args,evidence:proof,outcome:"success"});
    assert.equal(q.table("eventDiscoveryEnrichmentState").size,0,"Free IG cannot charge the model");
    const paid=await claim("web");
    assert.equal(paid.handle,due.handle);
    assert.equal(await accountResearch.reserveSearch._handler(q.ctx,args),true);
    assert.equal(await accountResearch.reserveSearch._handler(q.ctx,args),false);
    const budget=[...q.table("eventDiscoveryEnrichmentState").values()][0];
    assert.equal(budget.attempted,1);
    const style={genre:"house",url:proof.displayName.url,quote:"I am primarily a house DJ.",dominant:true};
    const result=await accountResearch.complete._handler(q.ctx,{...args,outcome:"success",evidence:{...proof,genres:[style]}});
    assert.equal(result.status,"written");
    assert.equal((await accountResearch.complete._handler(q.ctx,{...args,outcome:"success",evidence:proof})).status,"stale");
    assert.equal((await accountResearch.recordReviewedEvidence._handler(q.ctx,{evidence:{...proof,genres:[style]},apply:true})).status,"unchanged");
    assert.equal((await readProfile._handler(q.ctx,{profileId:nearProfile._id})).primaryGenre,"house");
    assert.equal((await lookupPerformerRegistryProgramme(q.ctx,near)).matches[0].genre,"house");
    assert.equal((await lookupPerformerRegistryProgramme(q.ctx,near)).category,undefined);
    assert.equal((await lookupPerformerRegistryProgramme(q.ctx,{...near,title:"Special tribute set by @nearaccount"})).matches.length,0);
    const next=await claim("instagram");
    assert.equal(next.handle,"busyaccount","Future appearance count precedes later single bookings and historical-only handles");
    const busyArgs={...rpc,handle:next.handle,profileId:next.profileId};
    q.put("instagramSources",{_id:"following-observation",handle:next.handle,observedDisplayName:"Busy Artist",observedDisplayNameUpdatedAt:time});
    await accountResearch.complete._handler(q.ctx,{...busyArgs,outcome:"success"});
    assert.equal((await q.ctx.db.get(next.profileId)).accountEvidence.displayName.quote,"Busy Artist");
    budget.attempted=96;
    assert.equal(await claim("web"),null);
    assert.equal((await claim("instagram")).handle,"boundaryaccount","Exhausted paid budget permits free account reads");
    assert.equal(budget.attempted,96);
    budget.attempted=95;
    assert.equal((await claim("web")).handle,"busyaccount");
    assert.equal(await accountResearch.reserveSearch._handler(q.ctx,busyArgs),true);
    await accountResearch.complete._handler(q.ctx,{...busyArgs,outcome:"success"});
    assert.equal(budget.attempted,96);
    assert.equal(await claim("web"),null);
    assert.equal((await q.ctx.db.get(next.profileId)).accountWork.stage,"waiting");
    assert.equal((await q.ctx.db.get(next.profileId)).accountWork.retryAt,time+14*86400000);
    function billedAlias(id,name,handle) {
      const artists=[name+" (@"+handle+")"];
      return pub(id,artists,{title:"Live: "+name,sourceCaption:"Live: "+artists[0],
        normalizedFieldsJson:JSON.stringify({artists,identityEvidenceVerified:true,sourceGroundingArtistsVerified:true})});
    }
    const origin=billedAlias("alias-original","DOO","nearaccount");
    q.put("events",origin);
    q.put("performerRegistryAppearances",{_id:"alias-old",eventId:origin._id,eventUpdatedAt:origin.updatedAt,
      profileId:nearProfile._id,handle:"nearaccount",name:"DOO",nameKey:"doo",confirmedBilling:true,date:origin.date,
      independent:false,status:"announced",venue:origin.venue,venueId:origin.venueId});
    const same=billedAlias("alias-next","DOO","nearaccount");
    q.put("events",same);
    assert.equal((await lookupPerformerRegistryProgramme(q.ctx,same)).matches[0]?.genre,"house","Verified earlier alias survives the exact account's public display-name update");
    assert.equal((await lookupPerformerRegistryProgramme(q.ctx,billedAlias("same-first","Unrelated Guest","nearaccount"))).matches.length,0);
    assert.equal((await lookupPerformerRegistryProgramme(q.ctx,billedAlias("other-account","DOO","differentaccount"))).matches.length,0);
    const s=await q.ctx.db.get(origin._id);s.status="pending";
    assert.equal((await lookupPerformerRegistryProgramme(q.ctx,same)).matches.length,0,"A withdrawn billing cannot corroborate an alias");
    s.status="approved";
    await syncPerformerRegistryForEvent(q.ctx,same._id);
    assert.equal([...q.table("performerRegistryAppearances").values()].find(a=>a.eventId===same._id)?.profileId,nearProfile._id);
    assert.equal((await lookupPerformerRegistryProgramme(q.ctx,billedAlias("styled","N e a r A c c o u n t","nearaccount"))).matches[0]?.genre,"house");
    {
      const booking = {kind:"booking",eventId:origin._id,date:origin.date,venue:origin.venue,sourceVenue:"Venue A",
        creditedAs:"DJ DOO",localName:"DOO",url:"https://djs.rs/e/venue-a-lineup",coBill:["Guest"]};
      const card = {profileId:nearProfile._id,identityKey:nearProfile.identityKey,kind:"artist",url:"https://djs.rs/dj-doo",
        artistName:"DJ DOO",labels:["Drum'n'bass","Jungle","Dubstep"],proofs:[booking]};
      const record = (entry,apply=true) => directory.record._handler(q.ctx,{entry,apply});
      assert.equal(await record(card,false),"insert");
      assert.equal((await directory.forProfile._handler(q.ctx,{profileId:nearProfile._id})).length,0);
      assert.equal(await record({...card,proofs:[{...booking,date:"2026-11-01"}]}),"stale");
      assert.equal(await record(card),"insert");
      assert.equal(await record(card),"unchanged");
      assert.equal((await findProfiles._handler(q.ctx,{name:"DJ DOO"})).profiles[0]?.profileId,nearProfile._id);
      const aliasTarget = billedAlias("new-directory-alias","DJ DOO","nearaccount");
      assert.ok((await lookupPerformerRegistryProgramme(q.ctx,aliasTarget)).matches.length);
      assert.ok((await readProfile._handler(q.ctx,{profileId:nearProfile._id})).genres.includes("drum-and-bass"));
      const show = {...card,kind:"billing",url:booking.url,labels:[]};
      assert.equal(await record({...show,labels:["Techno"]}),"invalid");
      assert.equal(await record(show),"insert");
      q.put("performerRegistryProfiles",{...nearProfile,_id:"unrelated",identityKey:"handle:unrelated",instagramHandle:"unrelated"});
      const other = {...card,profileId:"unrelated",identityKey:"handle:unrelated"};
      assert.equal(await record(other),"stale");
      assert.equal(await record({...other,proofs:[{kind:"identity",url:"https://ra.co/dj/unrelated",
        localUrl:"https://www.instagram.com/unrelated/",quote:"Unrelated Artist"}]}),"conflict");
      origin.status="pending";
      q.put("events",origin);
      assert.ok(!(await readProfile._handler(q.ctx,{profileId:nearProfile._id})).genres.includes("drum-and-bass"));
      const bare = pub("recorded-show",["First Guest","Second Guest"],{title:"DJ set"});
      q.put("events",bare);
      await syncPerformerRegistryForEvent(q.ctx,bare._id);
      const invoice = name => ({ ...booking, eventId:bare._id,date:bare.date,localName:name,creditedAs:name });
      const first = {kind:"artist",identityKey:"directory:https://djs.rs/first-guest",url:"https://djs.rs/first-guest",
        artistName:"First Guest",labels:["House"],proofs:[invoice("First Guest")]};
      const second = {kind:"billing",identityKey:"booking:"+bare._id,url:booking.url,
        artistName:"Second Guest",labels:[],proofs:[invoice("Second Guest")]};
      const beforeCount=q.table("performerRegistryProfiles").size;
      assert.equal(await record(first,false),"insert");
      assert.equal(await record(first),"insert");
      assert.equal(await record(first),"unchanged");
      assert.equal(await record({...first,kind:"billing",url:booking.url,labels:[]}),"insert");
      assert.equal(await record(second),"insert");
      assert.equal(await record(second),"unchanged");
      assert.equal(q.table("performerRegistryProfiles").size,beforeCount+1);
      await syncPerformerRegistryForEvent(q.ctx,bare._id);
      const row=[...q.table("performerRegistryAppearances").values()].find(a=>a.eventId===bare._id && a.name==="First Guest");
      assert.ok(row?.profileId);
      assert.deepEqual((await findProfiles._handler(q.ctx,{name:"First Guest"})).profiles.map(p=>p.profileId),[row.profileId]);
      assert.equal((await findProfiles._handler(q.ctx,{name:"DJ DOO"})).profiles.length,0,"Withdrawn show cannot surface its alias");
      assert.deepEqual((await readProfile._handler(q.ctx,{profileId:row.profileId})).genres,["house"]);
      const varied = pub("alternate-spelling",["Linna","Guest A","Guest B"]);
      q.put("events",varied);
      const variant = { ...invoice("Linna"),eventId:varied._id,creditedAs:"Lina",url:"https://djs.rs/e/alternate-spelling",
        coBill:["Guest A","Guest B"],variantSource:{url:"https://ra.co/events/1000",quote:"Lina, Guest A, Guest B"} };
      const oneNight = { ...second,artistName:"Lina",url:variant.url,identityKey:"booking:"+varied._id,proofs:[variant] };
      assert.equal(await record({...oneNight,proofs:[{...variant,coBill:["Guest A","Guest A"]}]}),"stale");
      assert.equal(await record(oneNight),"insert");
      // A reviewed spelling belongs to this occurrence. The same compact fields
      // feed both the visible cards and the filtered calendar counts.
      const store = q.table("events");
      const calendarRow = row => ({...projectPublicEvent(row, true), ...publicPerformerSearchFields(row)});
      const search = (row, word) => matchesPublicEventNameArtistOrVenue(calendarRow(row), word);
      const searched = store.get(varied._id);
      const beforeReads = q.indexReads.length;
      assert.deepEqual(searched.artists, ["Linna","Guest A","Guest B"]);
      assert.ok(search(searched, "Lina"));
      assert.equal(search(searched, "Linna"), true);
      assert.equal(search(searched, "Linaa"), false);
      assert.equal(search({ ...searched, _id: "homonym" }, "Lina"), false);
      assert.equal(search({ ...searched, date: "2027-01-01" }, "Lina"), false);
      assert.equal(search({ ...searched, venue: "Elsewhere" }, "Lina"), false);
      assert.equal(search({ ...searched, artists: ["Guest A"] }, "Lina"), false);
      assert.equal(search({ ...searched, publicationState: "blocked" }, "Lina"), false);
      assert.equal(search({ ...searched, updatedAt: searched.updatedAt + 1 }, "Lina"), false);
      const counts = buildPublicCalendarOverviewPage([
        calendarRow(searched), calendarRow({...searched, _id:"homonym"}),
      ], {q:"Lina"});
      assert.equal(counts.page.reduce((sum,bucket)=>sum+bucket.count,0),1);
      assert.equal(q.indexReads.length,beforeReads,"List and counts use only the qualified event projection");
      assert.equal(Object.hasOwn(projectPublicEvent(searched, true), "directorySearchCredits"), false);

      // Data imported before this change has no materialization. Repeated pages
      // populate it idempotently, including a link with more events than one batch.
      const tour = [];
      for (let index=0; index<6; index++) {
        const sibling = pub("separate-booking-"+index,["Tour Guest"]);
        q.put("events",sibling);
        tour.push({...booking,eventId:sibling._id,date:sibling.date,venue:sibling.venue,
          creditedAs:"Tour Guest",localName:"Tour Guest",url:"https://djs.rs/e/tour-"+index});
      }
      const touringCard = {kind:"artist",identityKey:"directory:https://djs.rs/tour-guest",
        url:"https://djs.rs/tour-guest",artistName:"Tour Guest",labels:[],proofs:tour};
      assert.equal(await record(touringCard),"insert");
      const continuation = q.jobs.find(job=>job.name==="performerDirectory:continueSearchCredits");
      assert.ok(continuation);
      assert.equal(tour.filter(p=>store.get(p.eventId).directorySearchCredits).length,4);
      await directory.continueSearchCredits._handler(q.ctx,continuation.args);
      assert.equal(tour.filter(p=>store.get(p.eventId).directorySearchCredits).length,6);
      for (const proof of [variant,...tour]) await q.ctx.db.patch(proof.eventId,{directorySearchCredits:undefined});
      async function backfill() {
        let cursor=null, after, changed=0, steps=0;
        do {
          const page = await directory.backfillSearchCredits._handler(q.ctx,{cursor,after});
          changed += page.changed; steps++;
          if (page.done) return {changed,steps};
          cursor=page.cursor;after=page.after ?? undefined;
          assert.ok(steps<50);
        } while (true);
      }
      assert.ok((await backfill()).changed>=7);
      const again = await backfill();
      assert.equal(again.changed,0);assert.ok(again.steps>q.table("performerDirectoryLinks").size);
      assert.ok(search(store.get(variant.eventId),"Lina"));
      for (const proof of tour) assert.deepEqual(store.get(proof.eventId).directorySearchCredits.names,["Tour Guest"]);
      await q.ctx.db.patch(varied._id,{artists:["Guest A"],updatedAt:varied.updatedAt+1});
      await directory.syncDirectoryEventSearch(q.ctx,store.get(varied._id));
      assert.equal(search(store.get(varied._id),"Lina"),false);
      assert.deepEqual(store.get(varied._id).directorySearchCredits.names,[]);

      const later = pub("later",["First Guest"],{title:"First Guest",date:"2026-12-31"});
      assert.deepEqual(await lookupPerformerRegistrySearchHints(q.ctx,later),[{performer:"First Guest",profileUrl:first.url}]);
      assert.deepEqual((await lookupPerformerRegistryProgramme(q.ctx,later)).matches,[]);
      const sourceUrl = "https://es.ra.co/dj/local-selector";
      const owner = {_id:"ra-owner",identityKey:'profile:["local selector","'+sourceUrl+'"]',name:"Local Selector",
        nameKey:"local selector",support:[],independentAppearances:0};
      q.put("performerRegistryProfiles",owner);
      const publicLink = { ...first,profileId:owner._id,identityKey:owner.identityKey,url:"https://djs.rs/local-selector",
        artistName:owner.name,labels:[],proofs:[{kind:"identity",localUrl:sourceUrl,url:sourceUrl,
          quote:"https://www.instagram.com/nearaccount/"}]};
      assert.equal(await record(publicLink),"conflict");
      publicLink.proofs[0].quote="https://www.instagram.com/local_selector/";
      assert.equal(await record(publicLink,false),"insert");
      assert.equal((await q.ctx.db.get(owner._id)).instagramHandle,undefined);
      assert.equal(await record(publicLink),"insert");
      assert.equal(await record(publicLink),"unchanged");
      assert.equal((await readProfile._handler(q.ctx,{profileId:owner._id})).instagramHandle,"local_selector");
    }
  } finally {
    if (envSecret===undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET=envSecret;
  }

} finally {
  Date.now = now;
}
