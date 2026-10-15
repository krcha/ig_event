# Architecture Overview

Event Zeka is a Next.js application backed by Convex. Convex can stay hosted in
Convex Cloud or run as a self-hosted backend in the same Docker Compose project
as the app. The product turns Instagram venue posts into reviewed public event
listings.

## Runtime Components

```text
Browser
  -> Next.js App Router pages and API routes
  -> Convex queries/mutations for persistent data
     (Convex Cloud or self-hosted convex-backend container)
  -> Clerk for auth
  -> Apify for Instagram scraping
  -> OpenAI Responses API for extraction/review
```

## Data Model

The source of truth is `convex/schema.ts`.

- `events`: extracted event records with `pending`, `approved`, or `rejected`
  status.
- `venues`: configured venue names and Instagram handles.
- `users`: Clerk-linked users.
- `userSavedEvents`: saved-event references.
- `scrapedPosts`: normalized raw Instagram post data.
- `ingestionJobs`: resumable job state for admin and cron ingestion.

## Public Surfaces

- `/` product entry point.
- `/events` approved upcoming events.
- `/events/[eventId]` event detail.
- `/calendar` monthly browsing.
- `/map` date-selectable map of approved events and their known venue locations.
  Mobile opens directly to a viewport-filling Belgrade map at zoom 14, with
  compact date controls and event-title/venue-link popups. Desktop retains its
  selected-day event list.
- `/venues/directory` public venue directory.
- `/venues` compatibility redirect to `/map?view=calendar`, preserving the
  original query parameters. The marker bypasses older cached permanent
  redirects in the opposite direction; new navigation links use clean `/map` URLs.
- `/api/health` container health check.

## Admin Surfaces

- `/admin` moderation dashboard.
- `/admin/scraper` ingestion controls and job status.
- `/admin/venues` venue management.
- `/api/admin/*` admin API routes protected by Clerk and
  `ADMIN_CLERK_USER_IDS` when Clerk is configured.

## Ingestion Flow

1. Load active venues from Convex.
2. Scrape recent posts with Apify through `lib/scraper/instagram-scraper.ts`.
3. Normalize posts to the `InstagramScrapedPost` contract.
4. Extract structured event data through OpenAI in `lib/ai/extract-event-data.ts`.
5. Normalize venue/date/title/confidence in `lib/pipeline/run-instagram-ingestion.ts`.
6. Insert approved or pending events in Convex.
7. Merge safe approved duplicates through `lib/events/approved-event-automerge.ts`.

Venue resolution treats an explicitly classified promoter's own account,
legacy venue name, aliases and location claims as organizer identity. Those
claims cannot supply the physical event venue, including when its old venue
record is hidden. Independently named physical venues still resolve normally.
The locality phrase "Beton Hala" does not by itself identify the club "Beton".
For current structured extraction, a venue logo incorrectly included among
artists can be removed only when the event stays at that venue and an exact
caption row bills another act without billing the venue name as a performer.
Other days' caption rows cannot supply that proof.

The resolver also excludes accounts explicitly classified as promoters across
the complete bounded directory, including paused sources. Their legacy venue
names cannot survive as unresolved physical venue proposals. A shorter place
claim cannot expand into an unrelated branded business inside that place: for
example, "Sava Centar" does not identify "Dolly Bell Sava Centar". Exact names,
reviewed aliases and ordinary club/bar qualifiers remain supported.

Caption identity evidence is scoped to the selected calendar day when a quote
contains a multi-day schedule. An act billed on Friday cannot verify Saturday
merely because both rows occur in the same caption. Explicit common acts and
separate sessions on the same day remain valid; independently supported poster
lineups remain available.

Artist identity checks retain the source's role headings. Author, director and
choreographer credits do not establish an appearance, and symphonic/tribute
repertoire does not bill the original artists. Separately billed performers
remain valid. Unsupported identities require review rather than silently
rewriting the extracted lineup.

Reviewed poster corrections can preserve existing timing explicitly. This mode
requires the exact current time and an empty replacement time quote, retaining
all time provenance and receipt timing, including unknown starts. It does not
turn an unstated start into a confirmed poster time.
Removing a misread creator or repertoire list requires an explicit service
review with the exact previous artist list and a substantive evidence note.
The ordinary repair path still rejects accidental clearing.

A reviewed physical venue change supersedes an old account fallback only after
the exact canonical venue changes. Its original inference remains in review
metadata and the audit; same-venue lineup corrections retain the fallback guard.
Pending performer corrections use a separate service-only transaction fenced
by the event, source link, receipt, source revision, occurrence and retained
poster checksum. They update the normalized lineup while preserving raw facts,
source materialization inputs, incomplete siblings and pending status. Explicit
review stamps keep automatic approval from undoing a reviewed hold.

Reviewed venue renames require every linked event and source occurrence to be
accounted for. An unbound expected, deferred or superseded occurrence can be
acknowledged by its exact stored snapshot and revision; its historical facts,
state and source identity remain unchanged during the rename.

## Moderation And Deduplication

Admins approve, reject, remove, or bulk-moderate events from `/admin`. Approved
duplicate cleanup merges likely duplicates into the strongest primary record and
reassigns saved-event references before deleting duplicate records.

## Deployment Shape

The low-complexity VPS path runs only the Next.js app in Docker and keeps
Convex Cloud managed. The self-hosted Convex path adds `convex-backend` and
`convex-dashboard` services through `docker-compose.self-hosted-convex.yml` on
the same Compose project/network. Clerk, OpenAI, and Apify remain managed in both
paths. See `docs/vps-self-hosting.md`, `docs/self-hosted-convex.md`, and
`docs/operations-runbook.md`.

## Extension Points

- Scraper replacement: must preserve `InstagramScrapedPost[]` before entering
  ingestion. Keep Apify fallback until reliability is proven.
- Convex hosting: can be Convex Cloud or the self-hosted Compose overlay without
  changing the app data API.
- Database replacement: replacing Convex itself with Postgres/SQLite is still a
  large data-layer rewrite. Plan it separately from self-hosting Convex.
- Build/deploy hardening: keep `next build` in the release gate and verify
  Docker image builds with production public env values.
