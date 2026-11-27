import assert from "node:assert/strict";
import { getFunctionName } from "convex/server";
import {
  advanceBackfill,
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
              gt: (a, b) => a > b,
              lte: (a, b) => a <= b,
              lt: (a, b) => a < b,
            }))
              b[k] = (field, v) => {
                predicates.push((r) => fn(r[field], v));
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
