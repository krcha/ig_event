import { buildInstagramSourceOccurrenceFingerprint } from "../../../lib/domain/occurrences/source-fingerprint";
import { sha256Hex } from "../../../lib/domain/reconciliation/evidence-digest";
import { exactJsonValue } from "../../../lib/events/exact-json-value";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../../lib/events/source-occurrence-representation";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

export const theatreProgramme = {
  review: "reviewed-bitef-november-programme-v1",
  identityUrl: "https://teatar.bitef.rs/Predstave/902/Privatna-proslava.shtml",
  identityProof: "Privatna proslava je romantična komedija",
  basis:
    "The theatre identifies its own production and director; the dated programmes give the individual performance times.",
};
export const programmeCases = ["bitef", "bristol27", "bristol28"] as const;
export type ProgrammeCase = (typeof programmeCases)[number];
const eventId = (id: string) => id as Id<"events">;
export const shows = {
  kre: eventId("j574210zew1av2wfwf9qt17d1d8h85yf"),
  early: eventId("j57e4cg8w0xdzmrk8a49zd0ra58h9hc3"),
  late: eventId("j57dnvghkdxre8qca08m56rq8s8jtz3q"),
  lateMonthly: eventId("j572yxvddb5bqr4fnz1f3zfcfs8h8zh6"),
  bristol27: [
    eventId("j5797ddfm7243fehw7h5kdzm3s8jwvks"),
    eventId("j571mmw9x3b30sfwk1m8gvepjd8hftnw"),
  ],
  bristol28: [
    eventId("j5761wp6vdkb04fngjsrgnnp3h8jwn7z"),
    eventId("j574ev9ynrrrd1kde39hbe35t18hfnn4"),
  ],
};
const postProof = {
  monthlyTheatre: [
    "DfEpAnJtj4U",
    "bitefteatar",
    "91902b701afba19ceab59fcbf779de03e7f8f845dddb3be615060cd715a326c2",
  ],
  weeklyTheatre: [
    "DgFVdJzqCQN",
    "bitefteatar",
    "24901bb28824f78043a0cbb70292b43ba7b991acfea47f7d44f793372c5b9a4d",
  ],
  monthlyBristol: [
    "DfPDgpVRmds",
    "elizabeth.belgrade",
    "bd4a199dbbecd791e807e458aa1862cfaa3834798d0b8f97a7f4a71eca521b40",
  ],
  weekendBristol: [
    "DgH1PEcx51z",
    "elizabeth.belgrade",
    "cf54d60c7a20776c41a145355ba7fe9589894b833503b41c629e3c8c790eb2e2",
  ],
} as const;
export function required(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error("Reviewed programme: " + message);
}
async function loadSource(
  ctx: QueryCtx,
  key: keyof typeof postProof,
  count: number,
) {
  const [code, account, analysisHash] = postProof[key];
  const identity = "instagram-source-identity-v1:" + code;
  const url = "https://www.instagram.com/p/" + code + "/";
  const receipt = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", identity))
    .unique();
  const occurrences = (
    await ctx.db
      .query("sourceOccurrences")
      .withIndex("by_source_occurrence", (q) =>
        q.eq("sourceIdentity", identity),
      )
      .take(count + 1)
  ).sort((a, b) => a.occurrenceOrdinal - b.occurrenceOrdinal);
  required(
    receipt &&
      receipt.expectedOccurrences?.length === count &&
      receipt.expectedKeys.length === count &&
      occurrences.length === count &&
      occurrences.every(
        (o, i) =>
          o.occurrenceOrdinal === i &&
          o.canonicalSourceUrl === url &&
          o.sourceDocumentId === occurrences[0].sourceDocumentId &&
          o.sourceFingerprint === receipt.sourceFingerprint &&
          o.sourceRevision === 1,
      ),
    "source or receipt changed",
  );
  const post = await ctx.db.get(occurrences[0].sourceDocumentId);
  required(
    post?.sourceRevision === 1 &&
      post.analysisRevision === 1 &&
      post.handle === account &&
      post.username === account &&
      post.processingStatus !== "processing" &&
      buildInstagramSourceOccurrenceFingerprint(post) ===
        receipt.sourceFingerprint &&
      sha256Hex(post.analysisResultJson ?? "") === analysisHash,
    "saved analysis or processing fence changed",
  );
  const links = await ctx.db
    .query("instagramEventSources")
    .withIndex("by_source_occurrence", (q) => q.eq("sourceIdentity", identity))
    .take(count + 1);
  required(
    links.length === receipt.satisfiedOccurrences.length &&
      receipt.satisfiedKeys.length === links.length &&
      receipt.deferredChildCount === 0 &&
      receipt.deferredChildKeys.length === 0,
    "inconsistent receipt topology",
  );
  for (const o of occurrences) {
    const ex = receipt.expectedOccurrences.find(
      (x) => x.key === o.sourceOccurrenceKey,
    );
    required(
      ex &&
        ex.factsJson === o.factsJson &&
        ex.canonicalEventJson === o.canonicalEventJson,
      "immutable receipt child changed",
    );
    const binding = receipt.satisfiedOccurrences.filter(
      (s) => s.key === o.sourceOccurrenceKey,
    );
    const boundLinks = links.filter(
      (l) =>
        l.sourceOccurrenceId === o._id &&
        l.sourceOccurrenceKey === o.sourceOccurrenceKey &&
        l.sourceFingerprint === o.sourceFingerprint &&
        l.canonicalSourceUrl === url &&
        l.eventId === o.canonicalEventId,
    );
    required(boundLinks.length === binding.length, "provenance link disagrees");
    required(
      binding.length === (o.state === "satisfied" ? 1 : 0) &&
        binding[0]?.eventId === o.canonicalEventId,
      "child binding disagrees",
    );
  }
  return { receipt, occurrences, url };
}
function binding(
  source: Awaited<ReturnType<typeof loadSource>>,
  n: number,
  e: Doc<"events">,
  expectedTitle: string,
  date: string,
  time: string,
  venue: string,
) {
  const o = source.occurrences[n],
    child = source.receipt.expectedOccurrences!.find(
      (r) => r.key === o.sourceOccurrenceKey,
    )!;
  required(
    e.title === expectedTitle &&
      e.date === date &&
      e.time === time &&
      e.venue === venue &&
      e.canonicalSourceUrl === source.url &&
      e.sourceOccurrenceKey === o.sourceOccurrenceKey &&
      o.canonicalEventId === e._id &&
      child.title === expectedTitle &&
      child.date === date &&
      child.time === time &&
      child.venue === venue &&
      exactJsonValue(e.artists, child.artists),
    "named representative no longer agrees with its receipt",
  );
}
export async function loadProgramme(ctx: QueryCtx, kind: ProgrammeCase) {
  const bitef = kind === "bitef";
  const datestr = kind === "bristol27" ? "2026-11-27" : "2026-11-28";
  const ids = bitef
    ? [shows.late, shows.lateMonthly, shows.early, shows.kre]
    : shows[kind];
  const events = await Promise.all(
    ids.map(async (id) => {
      const e = await ctx.db.get(id);
      required(e, "event missing");
      return e;
    }),
  );
  const [primary, duplicate, early, kre] = events;
  const [main, extra] = await Promise.all(
    bitef
      ? [
          loadSource(ctx, "weeklyTheatre", 3),
          loadSource(ctx, "monthlyTheatre", 19),
        ]
      : [
          loadSource(ctx, "weekendBristol", 2),
          loadSource(ctx, "monthlyBristol", 8),
        ],
  );
  const primaryFields = JSON.parse(primary.normalizedFieldsJson ?? "{}"),
    secondaryFields = JSON.parse(duplicate.normalizedFieldsJson ?? "{}");
  if (bitef) {
    binding(
      main,
      2,
      primary,
      "Privatna proslava",
      "2026-11-29",
      "21:00",
      "Bitef teatar",
    );
    binding(
      extra,
      18,
      duplicate,
      "Приватна прослава",
      "2026-11-29",
      "21:00",
      "Bitef teatar",
    );
    binding(
      extra,
      17,
      early,
      "Приватна прослава",
      "2026-11-29",
      "18:30",
      "Bitef teatar",
    );
    binding(extra, 15, kre, "Кретање", "2026-11-24", "20:00", "Bitef teatar");
    required(
      early.publicationState === "publishable" &&
        kre.publicationState === "publishable" &&
        primary.venueId === early.venueId &&
        primary.venueId === kre.venueId &&
        primary.venueId === duplicate.venueId &&
        duplicate.status === "pending" &&
        primaryFields.rowSourceText ===
          "29. novembar, nedelja | 18.30 i 21.00\n„Privatna proslava“" &&
        secondaryFields.rowSourceText ===
          "29.11. ПРИВАТНА ПРОСЛАВА (18:30ч и 21ч)" &&
        primaryFields.timeEvidence?.exact_text === "21.00",
      "dated theatre lines changed",
    );
    for (const [n, event, title] of [
      [0, kre, "Kretanje"],
      [1, early, "Privatna proslava"],
    ] as const) {
      const o = main.occurrences[n],
        ex = main.receipt.expectedOccurrences!.find(
          (e) => e.key === o.sourceOccurrenceKey,
        )!;
      required(
        ex.title === title &&
          sourceOccurrenceRepresentativeMatchesExpected(event, ex) &&
          ex.time === event.time &&
          ex.date === event.date &&
          ex.venue === event.venue &&
          o.venueId === event.venueId &&
          ((o.state === "expected" && !o.canonicalEventId) ||
            (o.state === "satisfied" && o.canonicalEventId === event._id)),
        "unbound weekly performance changed",
      );
    }
  } else {
    const n = kind === "bristol27" ? 0 : 1;
    binding(
      main,
      n,
      primary,
      "GEORGE TSILIPAKOS",
      datestr,
      "21:00",
      "Elizabeth Bristol",
    );
    binding(
      extra,
      n + 6,
      duplicate,
      "GEORGE TSILIPAKOS",
      datestr,
      "TBD",
      "The Bristol Belgrade",
    );
    required(
      primary.venueId === "k173ctnv746zcjrvxmx0zx022n8961sr" &&
        duplicate.venueId === "k173m3p7x6hv0rh5bsf0mcdgc58hwbxj" &&
        exactJsonValue(primary.artists, ["GEORGE TSILIPAKOS"]) &&
        exactJsonValue(duplicate.artists, primary.artists) &&
        primaryFields.rowSourceText ===
          "GEORGE TSILIPAKOS / FRIDAY & SATURDAY 27 & 28 NOV / 21.00h" &&
        secondaryFields.rowSourceText ===
          "GEORGE TSILIPAKOS — FRIDAY & SATURDAY 27 & 28 NOV" &&
        duplicate.status === "approved",
      "restaurant, hotel or dated billing changed",
    );
  }
  const note = bitef
    ? "Mesečni repertoar potvrđuje dve predstave, u 18:30 i 21:00."
    : "Mesečni program potvrđuje nastup Georgea Tsilipakosa u restoranu Elizabeth u hotelu Bristol.";
  const sourceUpdate = {
    sourceEventId: duplicate._id,
    sourceUrl: extra.url,
    text: note,
  };
  required(
    primary.status === "approved" &&
      (!primary.reviewedSourceUpdate ||
        exactJsonValue(primary.reviewedSourceUpdate, sourceUpdate)) &&
      !primary.reviewedDuplicateOf &&
      (!duplicate.reviewedDuplicateOf ||
        duplicate.reviewedDuplicateOf === primary._id),
    "different review already present",
  );
  const labels = bitef
    ? await Promise.all(
        [early, primary].map((e) =>
          ctx.db
            .query("eventDiscoveryLabels")
            .withIndex("by_eventId", (q) => q.eq("eventId", e._id))
            .unique(),
        ),
      )
    : [];
  for (const label of labels)
    required(
      !label?.taxonomy || label.taxonomy.primaryCategory === "culture",
      "another classification needs review",
    );
  const applied =
    duplicate.reviewedDuplicateOf === primary._id &&
    exactJsonValue(primary.reviewedSourceUpdate, sourceUpdate);
  const digest = sha256Hex(
    JSON.stringify([
      kind,
      events.map((e) => [
        e._id,
        e.updatedAt,
        e.publicationState,
        e.reviewedDuplicateOf,
      ]),
      labels.map(
        (l) => l && [l._id, l.eventUpdatedAt, l.taxonomy, l.auditJson],
      ),
      [main, extra].map((s) => [
        s.receipt.updatedAt,
        s.occurrences.map((o) => [
          o._id,
          o.updatedAt,
          o.state,
          o.canonicalEventId,
        ]),
      ]),
    ]),
  );
  required(
    !applied ||
      (primary.publicationState === "publishable" &&
        duplicate.publicationState === "hidden" &&
        (!bitef ||
          (primary.timeEvidenceText === "21.00" &&
            main.occurrences.every((o) => o.state === "satisfied") &&
            labels.every(
              (l, i) =>
                l?.eventUpdatedAt === [early, primary][i].updatedAt &&
                l.taxonomy?.formats.includes("theatre") &&
                JSON.parse(l.auditJson).reviewedProgramme?.identityUrl ===
                  theatreProgramme.identityUrl,
            )))),
    "incomplete earlier application",
  );
  return {
    primary,
    duplicate,
    early,
    kre,
    main,
    extra,
    sourceUpdate,
    digest,
    applied,
    labels,
  };
}
