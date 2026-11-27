# Music and venue recommendations

The public `/next` compass uses the selected venue's current programme, a
specific programme selected by the user, or the venue type. The comparison
link on an approved event's detail page opens `/next/event/[eventId]`. It
uses the saved taxonomy for that exact occurrence and shows upcoming matches
in a fourteen-day window starting on the reference date or the current
Belgrade outing date, whichever is later. That view works without location
permission. The compass uses distance and opening hours for an immediate visit.

## Matching

The ordered scale runs from strong contrast (0) to the same music or activity
(100). Similar results score at least 70 and different results at most 30.
The reason attached to each result describes the matching evidence. Scores
are product rules; distance resolves ties on the compass. Sharing a format or
venue type supports a different score from sharing explicit genres.

`lib/taxonomy/music-genre-relations.ts` defines one-hop relationships.
House and techno are related; electronic dance music and regional folk can
be strong contrast. A mixed programme with a clear musical overlap cannot
become a strong contrast. Estimates can help find similar results and have
less weight than sourced evidence. Verified venue contrast remains available
when the programme has insufficient evidence, and is presented as a venue
suggestion. A known, open cocktail bar can match another cocktail bar even
without a listing.

`lib/travel/venue-profile.ts` contains the reviewed Belgrade profiles and
their sources. It binds existing records to their venue identity and checks
the address for venues without a reviewed record ID. Opening hours and
coordinates continue to come from the public directory. A venue profile
describes the venue even when its current programme changes.

## Background enrichment

The existing event-discovery agent runs after daily ingestion. The Convex
upcoming discovery sweep also picks up public events from other ingestion and
approval paths, revised occurrences, and candidates with only a prior estimate.
The sweep uses an indexed date cursor, daily budget, short lease, stale-write
checks and retry intervals. It calls the same authenticated Node route on the
configured web origin. The executor reads `EVENT_DISCOVERY_EXECUTOR_ORIGIN` or
falls back to `AUTONOMOUS_MODERATION_EXECUTOR_ORIGIN` in Convex, with
`CRON_SECRET` matching the web process.

Explicit occurrence text is preferred. When more evidence is needed, the
worker searches for the specific dated programme or matching performer and
keeps cited research ahead of model estimates. Ambiguous identity or partially
researched lineups can stay unresolved; published occurrences remain available.
The saved genres represent claims about the event. Similarity is calculated
from the current taxonomy when ranking and never produces extra genre claims.

## Programme and public reads

The compass loads a bounded current calendar window and retains a small
per-venue programme list. It resolves the source programme at the current
time and the destination programme at estimated arrival, including the
next civil date around midnight. Unknown start times are labeled separately.

The existing optional source venue lookup reuses the bounded public music
profile read with an explicit field allowlist. History can describe the
usual source programme when appropriately labeled. It requires three
distinct music dates within the preceding thirty days and a supported
direction on at least two-thirds of the twelve most recent dates. Dated
programme evidence wins. History does not establish current music at a
destination.

Older occurrences without a saved taxonomy use the same explicit programme
evidence as the calendar. For example, a description announcing an evening
of soul, jazz and blues can support a jazz match. A performer's name alone
does not establish a genre.

All click-time reads use stored data. Clicking a comparison never starts
paid enrichment. The public comparison reference uses the approved event
detail's public visibility checks and only requests taxonomy for that read.

## Release checks

`npm run qa:travel` covers compass ranking, programme and arrival handling,
route safeguards, and event-only ranking. Genre relation and bounded public
projection checks are also part of `npm run qa:release`. The Convex changes
must be live before promoting the web release that calls the updated queries.
