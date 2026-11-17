# Music genre recommendations

The existing event-discovery agent remains the source of saved genre labels. Its
three stages (event classification, known-performer estimates and cited research)
share the canonical guide in `lib/taxonomy/music-genre-relations.ts`. Related and
contrasting genres are recommendation metadata, never extra claims inserted into
the event's actual `genres` array. Existing identity, source-quote, version,
publication and stale-write checks remain in force.

## Matching

The shared relation model returns same, close, contrast, mixed or unknown. Close
and contrast edges are explicit application recommendations, not universal claims
that musical genres have objective opposites. They are symmetric and never use
transitive closure or contrast-by-negation. For example, House/Techno are close;
House/Rock contrast. A mixed House/Rock programme cannot be called completely
different from House. Missing evidence stays unknown.

The same flow uses same/close matches. The different flow requires a supported
contrast. Known non-musical activity categories remain separate from music-genre
comparison. Distance sorting runs after eligibility and does not reorder results
by an invented model confidence score.

## Programme and source context

Choose one relevant occurrence per venue, favoring the most recent announced
start that has not ended. A later programme does not donate its genres to an
earlier one. Unknown start times retain their uncertainty; a future bill cannot
establish the current source venue's music. Genre provenance distinguishes an
announcement, cited performer research and an AI estimate.

When current music is not known, the confirmed source venue may use a clearly
labeled recent-programme context. It requires at least three distinct music
dates within thirty days and a supported direction on at least two thirds of
the twelve most recent dates. Unknown nights count against coverage. Current
programme evidence wins; an announced non-music activity cannot inherit old
music. History alone never establishes a destination's current programme.

## Bounded reads

The initial page reads only the current outing's events. After a venue is
confirmed, the first-party music-profile endpoint reads stored labels for that
venue through the additive `venues:getPublicVenueMusicEvents` query. It reuses
the existing public-grounding path, restricts canonical venue IDs, returns an
explicit public-field allowlist and reads at most twenty-four historical and
twelve upcoming cards. No schema change, migration or AI request is involved.

The Node caller supplies explicit Belgrade outing and next-civil-date arguments,
so the query cache cannot hold yesterday's window merely because no document
changed. The API caches/deduplicates results in bounded memory for sixty seconds,
limits concurrent lookups and times out. The browser cancels stale venue reads
and distinguishes actual missing data from a failed lookup. GPS is not included
in the profile request.

Paid enrichment runs through the existing background agent or a separately
invoked, scope-limited operator. A click on the compass never launches research.

## Release checks

The release gate includes genre relation/prompt checks, actual Convex query
grounding and output tests, and programme/history/arrival tests. Browser checks
cover compact phone layouts, source lookup success/empty/error/cancellation,
long factual text and a route map replacing the compass. Production deployment
requires the additive query to be verified before web promotion. The existing
schema, ingestion, moderation and source event records are preserved.
