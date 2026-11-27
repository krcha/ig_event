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

### Primary categories in the next 48 hours

Every ten minutes the existing discovery executor scans up to four indexed
pages of twelve listings before the ordinary upcoming sweep. The two scans
have independent cursors. Only approved, publishable occurrences at public
venues are eligible. The urgent window uses a rolling 48 elapsed hours in
Europe/Belgrade. A stated overnight interval remains eligible while it is in
progress. A listing with no confirmed start can qualify by date, including the
previous outing until 07:00. This does not assign a start time to it. The
first pass applies local rules across the entire window. It reserves model
slots only for confirmed future starts and confirmed intervals still running.
After reaching the end of that index range, another pass can reserve slots
for today's undated listings and subsequent fully covered dates. Undated
listings on the partially covered final date get a separate last pass. An
undated listing from yesterday's outing can receive a local classification
but cannot reserve a slot in either model sweep. Each phase keeps one bounded
index cursor; a new Belgrade day restarts at confirmed times. A new full
scan becomes eligible 30 minutes after completion.

For a missing, stale or unsupported generic label, the mutation first tries
occurrence-specific rules. A positive local decision writes the taxonomy,
source quotes, event revision and rule version in one transaction. It can
replace a previously empty result during its ordinary 14-day research
cooldown. Recognized explicit programme genres retain their evidence. A
confirmed primary category is skipped on future priority passes. Contradictory
announcements and inconclusive inputs do not acquire a fabricated category.

The local pass also runs after the shared daily limit of 96 event attempts
is exhausted. When the model can help identify the activity it receives only
the scoped announcement and does no performer search or estimation. At most
72 daily attempts can serve this purpose. Until 18:00 Belgrade time ordinary
enrichment can use up to 72, reserving 24 for later announcements. After 18:00
the ordinary sweep can consume unspent capacity. After three consecutive
priority batches with more than twelve total slots remaining and normal
capacity available, the normal cursor gets a turn. With twelve or fewer
remaining slots, the current priority scan can hold its share across ticks
while it searches later pages. That hold expires after 20 minutes without
progress. The 72-slot priority ceiling still applies. The shared lease expires after four minutes, and the executor stops
provider work at its 220-second deadline. Only a transient failure may retry
once after one hour for the same event revision and priority-rule version.

The authenticated executor response includes a `priority` count for the pages
it actually scanned. A listing may be visited again in a lower-priority pass.
`eligible` counts in-window public row visits, including already
`known` ones. `attempted` counts reserved model slots. `written` counts durable
primary classifications, including local decisions. `unresolved` counts the
eligible unclassified rows that did not receive a durable primary on this
invocation. Compare these per-invocation counts with the live catalogue's
latest label for the matching event revision. A row with `taxonomy: null` is
still unresolved.

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
