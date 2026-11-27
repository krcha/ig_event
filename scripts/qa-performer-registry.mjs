import assert from "node:assert/strict";
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
    pages = [];
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
        let predicates = [],
          desc = false;
        const rows = () => {
          const out = [...table(name).values()].filter((r) =>
            predicates.every((f) => f(r)),
          );
          return desc ? out.reverse() : out;
        };
        return {
          withIndex(index, cb) {
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
  return { ctx, table, jobs, writes, put, pages };
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
} finally {
  Date.now = now;
}
