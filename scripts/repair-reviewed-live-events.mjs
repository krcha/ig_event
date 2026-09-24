import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";

// Run with the production NEXT_PUBLIC_CONVEX_URL and CRON_SECRET in the
// environment. Preview: node scripts/repair-reviewed-live-events.mjs
// Apply one step: node scripts/repair-reviewed-live-events.mjs --apply
//   --expect-plan-sha256 <hash from the immediately preceding preview>
// Repeat preview/apply until nextStep is null. Each step is independently
// version-fenced; a failed step should be re-previewed before retrying.

// One reviewed production incident. Every identifier is pinned; revisions are
// always read again from Convex and included in the preview hash.
const CONVEX_URL = "https://convex-events.ineedtofeedmyrabbit.com";
const SPELL_VENUE_ID = "k177w270ac6n1ee7q1bac1mxbh8964p9";
const UMAMI_VENUE_ID = "k178nb6yx5e9mca56zkc05mp5n897t6j";
const CLUB_2044_VENUE_ID = "k17cp35s3e07ebpthy4m4trf01896hwv";
const SHOOTIRANJE_OLD_VENUE_ID = "k177zjf82svqjp0vm25f55zeqx897mgt";
const DOMESTIK_OLD_VENUE_ID = "k17940v35arayfrp5bm0hdyhch8979e6";
const FROM_OLD_VENUE_ID = "k17615xgs948jebyzzktwmq47d897hzf";
const SPELL_RECEIPT_ID = "mh71s8nvb2gy1znf6krnj2y15s8eza46";

const SPELL_EVENTS = Object.freeze([
  ["j574wqfg7fsgrw0ajayyhj8ghd8ey27w", "kx74jayppswhwz3cfc460dg52d8ezq1q", "Pap kviz"],
  ["j575qajkqfgqhtmb3t8myn2j998ezvf4", "kx74xtfcj75116fvfpnr3j83kh8eyqrm", "Thursday Night at Something is stirring."],
  ["j5700f27hqw0zpnr8mwsxfk9c58eytx7", "kx75gdt2aestsztykt4hernh298eyvx0", "Dj Vladimir Tsvetkov"],
  ["j574j523n31d69pg9arsrh28rh8ezp31", "kx78rxdvd230drg79zm3q4hpp18ezbws", "Saturday Night at Something is stirring."],
  ["j57653sgrryy2zhd17xmb3pkks8ey5pn", "kx734g891prwvcevdgncb6jq6h8eyfyq", "FAD"],
]);
const EVENT = Object.freeze({
  spell: "j575qajkqfgqhtmb3t8myn2j998ezvf4",
  umami: "j5718sa6xgnhdcg1f8nvbg27s98exsth",
  club2044: "j571thabz8hgrg23bnd7sp6qr18ey6dk",
  shootiranje: "j575jy39g71ej9x95h0g57hsz18ex4br",
});
const SOURCE_LINK_IDS = Object.freeze({
  [EVENT.umami]: ["kx76dmaftvk62vnn5633z82t958ew8h4", "kx7506zx70pyxjz7fm7g9sfjc58eyray"],
  [EVENT.club2044]: ["kx7f28zgxbve1bces1jq3v2f4x8eyaz8"],
  [EVENT.shootiranje]: ["kx7fx5bcvhy79v2v8tqnwgvc898ex0e2"],
});
const RECEIPT_IDS = Object.freeze({
  [EVENT.umami]: ["mh76gch4yyt23etyc5j12dmyqn8ewemk", "mh79qj61dxc1tfkyabmhe52k6d8ezres"],
  [EVENT.club2044]: ["mh7bf5gjj1djeq3ttwpxhw26yd8eyza2"],
  [EVENT.shootiranje]: ["mh7ckhca7hcds2826z5wmk146x8exdn9"],
});
const SOURCE_IDENTITIES = Object.freeze({
  [EVENT.umami]: ["instagram-source-identity-v1:DdjtKktRu2v", "instagram-source-identity-v1:DdlX2dzRbJo"],
  [EVENT.club2044]: ["instagram-source-identity-v1:DdmsxPUCLh7"],
  [EVENT.shootiranje]: ["instagram-source-identity-v1:DdjxsJOuNar"],
});
const ROLES = Object.freeze([
  { handle: "from_sound", sourceId: "mn70670yxt7mvbcka9tfnbvaax8bgwje", oldVenueId: FROM_OLD_VENUE_ID },
  { handle: "domestik.bg", sourceId: "mn7f41fg56xfx2penkm2b3zen18bhy8n", oldVenueId: DOMESTIK_OLD_VENUE_ID },
]);
const SHOOTIRANJE_NS = Object.freeze({
  name: "Shootiranje NS",
  instagramHandle: "shootiranje_ns",
  category: "venue",
  location: "Ilije Ognjanovića 9, Novi Sad",
  publicStatus: "published",
  scrapeActive: false,
});
const REVIEW_NOTE = "Reviewed production venue correction requested for four linked Event Zeka events.";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function sameSet(actual, expected) {
  return actual.length === expected.length &&
    new Set(actual).size === expected.length &&
    expected.every((value) => actual.includes(value));
}
function exactVenue(venues, id, name, handle) {
  const venue = venues.find((item) => item._id === id);
  assert(venue && venue.name === name && venue.instagramHandle === handle && venue.publicStatus === "published",
    `Reviewed venue ${id} changed or is not published.`);
  return venue;
}
function checkedSource(context, linkId, receiptId, sourceIdentity) {
  const item = context.sources.find((source) => source.sourceLink._id === linkId);
  assert(item && item.receipt._id === receiptId && item.sourceLink.sourceIdentity === sourceIdentity,
    `Reviewed source topology changed for event ${context.event._id}.`);
  const { sourceLink, receipt, occurrence } = item;
  const expected = receipt.expectedOccurrences?.filter((row) => row.key === sourceLink.sourceOccurrenceKey) ?? [];
  const satisfied = receipt.satisfiedOccurrences?.filter((row) => row.key === sourceLink.sourceOccurrenceKey) ?? [];
  assert(
    expected.length === 1 && satisfied.length === 1 && satisfied[0].eventId === context.event._id &&
    occurrence.canonicalEventId === context.event._id && occurrence.state === "satisfied" &&
    occurrence.sourceOccurrenceKey === sourceLink.sourceOccurrenceKey &&
    occurrence.venueId === context.event.venueId && expected[0].venue === context.event.venue,
    `Reviewed receipt or first-class occurrence changed for event ${context.event._id}.`,
  );
  return item;
}
function nextOperation(name, functionName, args) {
  return { name, functionName, args };
}
function operationHash(operation) {
  return crypto.createHash("sha256").update(JSON.stringify({ version: 1, operation })).digest("hex");
}

export function buildReviewedLiveRepairPlan(snapshot) {
  const { venues, sources, contexts } = snapshot;
  const status = [];
  let next = null;
  const consider = (name, done, operation) => {
    status.push({ name, status: done ? "done" : "pending" });
    if (!done && !next) next = operation;
  };

  exactVenue(venues, UMAMI_VENUE_ID, "Umami", "umami.bg");
  exactVenue(venues, CLUB_2044_VENUE_ID, "20/44", "20_44.nightclub");
  const spellVenue = venues.find((item) => item._id === SPELL_VENUE_ID);
  assert(spellVenue && spellVenue.instagramHandle === "spellbeograd" &&
    spellVenue.publicStatus === "published" &&
    ["Something is stirring.", "Spell Bar"].includes(spellVenue.name),
  "The reviewed Spell venue changed unexpectedly.");

  for (const role of ROLES) {
    const source = sources[role.handle];
    assert(source && source._id === role.sourceId && source.handle === role.handle && source.active === true,
      `Reviewed source ${role.handle} changed unexpectedly.`);
    const done = source.role === "promoter" && !source.venueId;
    assert(done || (source.role === "venue" && source.venueId === role.oldVenueId),
      `Reviewed source ${role.handle} role or venue changed unexpectedly.`);
    consider(`source-role:${role.handle}`, done, nextOperation(
      `source-role:${role.handle}`, "instagramSources:setRole",
      { handle: role.handle, role: "promoter", expectedUpdatedAt: source.updatedAt },
    ));
  }

  const newVenueMatches = venues.filter((venue) =>
    venue.instagramHandle === SHOOTIRANJE_NS.instagramHandle || venue.name === SHOOTIRANJE_NS.name);
  assert(newVenueMatches.length <= 1, "Shootiranje NS venue identity is ambiguous.");
  const shootiranjeVenue = newVenueMatches[0] ?? null;
  if (shootiranjeVenue) {
    for (const [field, expected] of Object.entries(SHOOTIRANJE_NS)) {
      assert(shootiranjeVenue[field] === expected, `Shootiranje NS ${field} changed unexpectedly.`);
    }
  }
  consider("create-venue:shootiranje-ns", Boolean(shootiranjeVenue), nextOperation(
    "create-venue:shootiranje-ns", "venues:createVenue",
    { ...SHOOTIRANJE_NS, auditNote: REVIEW_NOTE },
  ));

  const spellExpectedEvents = SPELL_EVENTS.map(([id, sourceLinkId, oldTitle]) => {
    const context = contexts[id];
    assert(context?.event._id === id && context.event.venueId === SPELL_VENUE_ID &&
      context.sources.length === 1, `Reviewed Spell event ${id} changed topology.`);
    assert(
      context.event.title === oldTitle ||
      (id === EVENT.spell && context.event.title === "Koktel Vece"),
      `Reviewed Spell event ${id} title changed unexpectedly.`,
    );
    const item = checkedSource(context, sourceLinkId, SPELL_RECEIPT_ID,
      "instagram-source-identity-v1:Ddlhyixt5_-");
    const { sourceLink, receipt } = item;
    return {
      id,
      updatedAt: context.event.updatedAt,
      normalizedFieldsJson: context.event.normalizedFieldsJson,
      sourceLinkId,
      sourceLinkUpdatedAt: sourceLink.updatedAt,
      receiptId: receipt._id,
      receiptUpdatedAt: receipt.updatedAt,
    };
  });
  const spellReceipt = contexts[EVENT.spell].sources[0].receipt;
  assert(sameSet(spellReceipt.satisfiedOccurrences.map((row) => row.eventId), SPELL_EVENTS.map(([id]) => id)) &&
    sameSet(spellReceipt.expectedOccurrences.map((row) => row.key),
      SPELL_EVENTS.map(([id]) => contexts[id].sources[0].sourceLink.sourceOccurrenceKey)),
  "Spell shared receipt no longer contains exactly the five reviewed events.");
  const spellRenamed = spellVenue.name === "Spell Bar" &&
    SPELL_EVENTS.every(([id]) => contexts[id].event.venue === "Spell Bar");
  assert(spellRenamed || (spellVenue.name === "Something is stirring." &&
    SPELL_EVENTS.every(([id]) => contexts[id].event.venue === "Something is stirring.")),
  "Spell venue rename is partially applied or an event changed independently.");
  consider("rename-venue:spell-bar", spellRenamed, nextOperation(
    "rename-venue:spell-bar", "venues:renameReferencedVenueWithReviewedEvents", {
      id: SPELL_VENUE_ID,
      expectedUpdatedAt: spellVenue.updatedAt,
      expectedName: "Something is stirring.",
      nextName: "Spell Bar",
      expectedEvents: spellExpectedEvents,
      venueEvidence: "The source account @spellbeograd identifies the venue as Spell Bar.",
      auditNote: REVIEW_NOTE,
    },
  ));

  const spellContext = contexts[EVENT.spell];
  const spellEvent = spellContext.event;
  const spellTitleDone = spellEvent.title === "Koktel Vece";
  if (spellTitleDone) {
    const expected = spellReceipt.expectedOccurrences.filter((row) =>
      row.key === spellContext.sources[0].sourceLink.sourceOccurrenceKey);
    assert(expected.length === 1 && expected[0].title === "Koktel Vece", "Spell title receipt is not corrected.");
  } else {
    assert(spellEvent.title === "Thursday Night at Something is stirring.",
      "Spell title changed unexpectedly.");
  }
  const spellFields = JSON.parse(spellEvent.normalizedFieldsJson);
  const spellRaw = JSON.parse(spellEvent.rawExtractionJson);
  assert(spellFields.splitEventIndex === 3 &&
    spellFields.rowSourceText === "Četvrtak Koktel veče" &&
    spellRaw.schedule_entries?.[2]?.date === spellEvent.date &&
    spellRaw.schedule_entries[2].source_text === "Četvrtak Koktel veče",
  "Spell exact schedule-row title evidence changed.");
  consider("correct-title:spell-koktel-vece", spellTitleDone, nextOperation(
    "correct-title:spell-koktel-vece", "events:repairReviewedStructuredEventTitle", {
      id: EVENT.spell,
      expectedUpdatedAt: spellEvent.updatedAt,
      expectedNormalizedFieldsJson: spellEvent.normalizedFieldsJson,
      expectedSourceLinkId: spellContext.sources[0].sourceLink._id,
      expectedSourceLinkUpdatedAt: spellContext.sources[0].sourceLink.updatedAt,
      expectedReceiptId: spellReceipt._id,
      expectedReceiptUpdatedAt: spellReceipt.updatedAt,
      nextTitle: "Koktel Vece",
      titleEvidence: "Četvrtak Koktel veče",
      moderationNote: "Reviewed Spell Bar program row says Četvrtak Koktel veče.",
    },
  ));

  const venueCorrections = [
    {
      name: "correct-venue:umami", id: EVENT.umami,
      oldVenue: "ДOMESTIK", oldVenueId: DOMESTIK_OLD_VENUE_ID,
      targetId: UMAMI_VENUE_ID, targetName: "Umami", targetHandle: "umami.bg",
      title: "DJ MIKSER", evidence: "Reviewed poster row 25.09. UMAMI 21H DJ MIKSER and source #umami identify the physical venue.",
    },
    {
      name: "correct-venue:20-44", id: EVENT.club2044,
      oldVenue: "frǾm", oldVenueId: FROM_OLD_VENUE_ID,
      targetId: CLUB_2044_VENUE_ID, targetName: "20/44", targetHandle: "20_44.nightclub",
      title: "FRØM EVERY THURSDAY (Vinyl Only Edition)",
      evidence: "Source caption states Location: Garden of Club 20/44 @20_44.nightclub, 44 Karađorđeva Street, Belgrade.",
    },
    {
      name: "correct-venue:shootiranje-ns", id: EVENT.shootiranje,
      oldVenue: "Shootiranje", oldVenueId: SHOOTIRANJE_OLD_VENUE_ID,
      targetId: shootiranjeVenue?._id, targetName: "Shootiranje NS", targetHandle: "shootiranje_ns",
      title: "SAMO U SNU", evidence: "Source caption explicitly states SHOOTIRANJE NS/ Ilije ognjenovica 9 in Novi Sad.",
    },
  ];
  for (const correction of venueCorrections) {
    const context = contexts[correction.id];
    const event = context?.event;
    assert(event && event._id === correction.id && event.title === correction.title,
      `${correction.name} event identity or title changed.`);
    const expectedLinks = SOURCE_LINK_IDS[correction.id];
    const expectedReceipts = RECEIPT_IDS[correction.id];
    const expectedIdentities = SOURCE_IDENTITIES[correction.id];
    assert(context.sources.length === expectedLinks.length &&
      sameSet(context.sources.map((source) => source.sourceLink._id), expectedLinks),
    `${correction.name} source-link set changed.`);
    const checked = expectedLinks.map((linkId, index) =>
      checkedSource(context, linkId, expectedReceipts[index], expectedIdentities[index]));
    const done = Boolean(correction.targetId) &&
      event.venueId === correction.targetId && event.venue === correction.targetName;
    assert(done || (event.venueId === correction.oldVenueId && event.venue === correction.oldVenue),
      `${correction.name} current venue changed unexpectedly.`);
    if (done) {
      assert(checked.every((item) => item.occurrence.venueId === correction.targetId),
        `${correction.name} source occurrences are not fully rebound.`);
    }
    const target = correction.targetId
      ? exactVenue(venues, correction.targetId, correction.targetName, correction.targetHandle)
      : null;
    consider(correction.name, done, nextOperation(
      correction.name, "events:repairReviewedMultiSourceEventVenue", {
        id: correction.id,
        expectedUpdatedAt: event.updatedAt,
        expectedNormalizedFieldsJson: event.normalizedFieldsJson,
        expectedSources: checked.map(({ sourceLink, receipt }) => ({
          sourceLinkId: sourceLink._id,
          sourceLinkUpdatedAt: sourceLink.updatedAt,
          receiptId: receipt._id,
          receiptUpdatedAt: receipt.updatedAt,
        })),
        nextVenue: correction.targetName,
        targetVenueId: target?._id,
        expectedTargetVenueUpdatedAt: target?.updatedAt,
        expectedTargetVenueHandle: target?.instagramHandle,
        venueEvidence: correction.evidence,
        moderationNote: REVIEW_NOTE,
      },
    ));
  }
  return { status, next, planSha256: next ? operationHash(next) : null };
}

async function loadSnapshot(client, serviceSecret) {
  const eventIds = [...new Set([...SPELL_EVENTS.map(([id]) => id),
    EVENT.umami, EVENT.club2044, EVENT.shootiranje])];
  const [venues, fromSource, domestikSource, ...eventContexts] = await Promise.all([
    client.query("venues:listVenues", { serviceSecret }),
    client.query("instagramSources:getByHandle", { handle: "from_sound", serviceSecret }),
    client.query("instagramSources:getByHandle", { handle: "domestik.bg", serviceSecret }),
    ...eventIds.map((id) => client.query("events:getReviewedVenueRepairContext", { id, serviceSecret })),
  ]);
  return {
    venues,
    sources: { from_sound: fromSource, "domestik.bg": domestikSource },
    contexts: Object.fromEntries(eventIds.map((id, index) => [id, eventContexts[index]])),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const hashFlag = argv.indexOf("--expect-plan-sha256");
  const expectedHash = hashFlag < 0 ? null : argv[hashFlag + 1];
  if (
    argv.some((arg, index) => arg !== "--apply" && arg !== "--expect-plan-sha256" &&
      !(index > 0 && argv[index - 1] === "--expect-plan-sha256")) ||
    (apply && !/^[0-9a-f]{64}$/u.test(expectedHash ?? "")) ||
    (!apply && expectedHash !== null)
  ) {
    throw new Error("Preview first; apply one step with --apply --expect-plan-sha256 <preview hash>.");
  }
  const serviceSecret = process.env.CRON_SECRET?.trim();
  const configuredUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim().replace(/\/$/u, "");
  if (!serviceSecret || configuredUrl !== CONVEX_URL) {
    throw new Error("The production Convex URL or CRON_SECRET is missing or differs from the reviewed target.");
  }
  const client = new ConvexHttpClient(CONVEX_URL);
  const before = buildReviewedLiveRepairPlan(await loadSnapshot(client, serviceSecret));
  if (!apply) {
    console.log(JSON.stringify({
      mode: "preview",
      nextStep: before.next?.name ?? null,
      planSha256: before.planSha256,
      steps: before.status,
    }, null, 2));
  } else {
    assert(before.next && before.planSha256 === expectedHash,
      "The live repair plan changed after preview, or all steps are complete.");
    const applied = before.next;
    await client.mutation(applied.functionName, { ...applied.args, serviceSecret });
    const after = buildReviewedLiveRepairPlan(await loadSnapshot(client, serviceSecret));
    assert(after.status.find((step) => step.name === applied.name)?.status === "done",
      "Mutation returned but postwrite verification did not mark its step complete. Re-preview before retrying.");
    console.log(JSON.stringify({
      mode: "applied-one-step",
      appliedStep: applied.name,
      nextStep: after.next?.name ?? null,
      steps: after.status,
    }, null, 2));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    const secret = process.env.CRON_SECRET?.trim();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Reviewed repair stopped: ${secret ? message.replaceAll(secret, "[redacted]") : message}`);
    process.exitCode = 1;
  }
}
