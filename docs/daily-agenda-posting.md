# Daily three-day Instagram agenda

Regular publication skips 2026-10-25 only. The
[one-off workflow](special-publication-2026-10-25.md) publishes the supplied
image as a single feed photo at 10:00 that day. The existing 16:30 carousel
schedule resumes on 2026-10-26 with its normal upcoming-date window.

The [14 October location update](daily-agenda-location-2026-10-14.md) records
the Belgrade tag's Meta validation and n8n deployment.

## Editorial and image contract

The daily post is a rolling agenda for tomorrow, the following day, and the day
after that, calculated in `Europe/Belgrade`. The scheduled n8n workflow runs at
16:30 in that timezone. Every regular carousel has the Instagram location tag
"Belgrade, Serbia", using location Page ID `109920975697736`. A post contains one portrait page per populated day,
with up to three approved public events on each page, followed by one branded
closing card. Each event's title,
venue, absolute date and available confirmed time come from public Convex data.
Ingestion, approval and venue visibility rules are unchanged.

Selection first uses events not shown in recent posts or Reels for the exact
event date. If fewer than three unseen events remain, it fills only the missing
slots with the least-used, older selections. Venue variety and announced times
are preferences within each usage tier; another unseen event at the same venue
still outranks any repeat. The publication date and format seed a deterministic
choice, so reordered data does not reroll a run. Overlapping dates rotate away
from actual published selections.
Missing or invalid Instagram handles do not exclude an otherwise public event.

A sparse day shows its actual one or two events. An empty day is omitted, and
an entirely empty window returns no post. There are no invented events, padded
recommendations or cover slides. Every populated window produces a carousel
with its one to three day pages, then one closing card. The closing card does
not count as an event and carries no venue tags.
The page number identifies the day within the three-day window.

Serbian captions state event names and practical facts, grouped by absolute
weekday and date. Optional artist information and prices are included only when
they fit without splitting a name or price condition. Missing prices are not
treated as free admission. Recommended contributions retain their conditions.
Explicitly inferred or unknown event times are omitted; a missing poster time
uses a dash. Poster titles and venue identities remain complete.

The approved visual direction is a club programme: 1080 by 1350 JPEG pages,
bold condensed event names, a separate time rail, thin horizontal rules, and a
small rabbit/wordmark footer. Seven approved palettes rotate by event date,
window position and format. Every event has a distinct colored band and vector
pattern, from a catalog of 21 colors and 21 patterns. Time frames are always
168 by 108 with radius 20, using centered 34-pixel type for both starts and
two-line ranges. Story and Reel interface areas remain clear.
Rows adapt to the measured title and venue text. Optional detail is removed
before title size is reduced. If complete identities still cannot fit, rendering
fails instead of publishing clipped text. Valid venue account tags use the
actual measured venue row positions.

The final card uses the same fonts and the first planned agenda day's palette. Its headline is "Zeka zna." Its single action is "Jos dogadjaja na
eventzeka.com", rendered with Serbian diacritics. The website address stays large and uses the closing band's contrasting text color. Oversized stacked type and the shared rabbit/wordmark
footer make this a distinct sign-off while retaining the poster identity.

## Implementation

- `lib/social/daily-carousel.ts`: date window, history-aware selection, factual Serbian
  captions, exact event image versions and tag metadata.
- `lib/social/agenda-layout.ts`: font measurement, text wrapping, row layout and
  shared venue tag positions.
- `lib/social/agenda-images.ts`: SVG outlines and Sharp JPEG output.
- `lib/social/poster-directions.ts`: thirteen art directions and the ordered
  39-combination cycle. `poster-renderer.ts` and `poster-layout.ts` own original
  artwork, measured Serbian typography and fixed time frames. See
  [the design system](social-poster-directions-2026-10-19.md).
- `lib/social/publication-history.ts`: exact-date caption matching and shared
  unseen-first selection for all three formats.
- `ops/n8n/social-publication-history.mjs`: bounded 30-day Meta media reads
  and success-only event-ID memory, embedded in each existing Code node.
- `lib/social/carousel-cta.ts`: closing copy and its cache/version key.
- `public/fonts/social/`: bundled Barlow Condensed, Instrument Sans, IBM Plex
  Mono and Noto Sans fallback fonts, their OFL notices, and pinned source URLs
  and SHA-256 checksums in `manifest.json`.
- `ops/n8n/publish-daily-carousel.mjs`: publisher source embedded into the n8n
  Code node by `scripts/build-n8n-daily-carousel.mjs`.

Font outlines are computed locally with fontkit. Production rendering requires
the bundled font files in `public/fonts/social`; it has no font download,
browser or system font installation requirement. The existing Docker build
copies the public directory.

## API contract

`GET /api/social/daily-carousel` requires the existing cron bearer secret. Its
optional `date=YYYY-MM-DD` parameter sets the publish date for previews; the
default is the current Belgrade date. The response contains `publishDate`,
`eventDates`, `selectionKey`, source and selected event counts, a caption, and
up to three agenda slides and a final `cta` slide. Each agenda slide specifies its date, selected event IDs,
window position, versioned image URL and optional account tags. The payload
response is not cached. Public data loading is bounded and fails on an
incomplete or failed query rather than silently publishing a partial scan.

Live publishers use `POST` on the same protected generator URL with bounded
`publishedCaptions`, `previouslyPublishedEventIds` and `excludedEventIds`. The
response declares `selectionPolicy=prefer_unposted` and lists
`previouslyPublishedEventIds` and actual `repeatedEventIds`. All three workflows
read the account's last 30 days of feed/Reel captions, at most ten pages of 50.
Unreadable or incomplete history stops live publication. IDs saved after
success preserve each workflow's own choices across metadata edits. The Story
date is today; the other formats always cover future dates, so expired Stories
do not need to be queried to avoid cross-format overlap.

The image URL is:

```text
/api/social/carousel/days/YYYY-MM-DD?events=id1,id2,id3&position=0&v=renderVersion
```

This endpoint is public so Instagram can fetch it. It requires a real date, one
to three unique bounded event IDs, window position 0 through 2, and a render
version. It performs at most three exact approved public event reads; it never
selects replacement events. A withdrawn event or changed event date returns
404. Changed displayed facts return 409 and require a fresh payload. Invalid
parameters return 400; identities that cannot fit safely return 422; missing
configuration or backend/render failures return 503. Errors are not cached.
Successful JPEGs use a 60-second cache lifetime with mandatory revalidation.
Source text is cleaned and escaped or converted to glyph outlines, so it cannot
inject SVG markup or remote resources.

The final image is `/api/social/carousel/cta?date=publishDate&v=renderVersion`.
Its version includes the date, closing copy and design revision, with the same JPEG size and
60-second revalidation as the day pages. A stale or repeated version returns
409. An unversioned URL remains supported for existing links. The publisher
requires exactly one closing card in the final position before creating media.

## Build, dry run and activation

Regenerate the workflow export after changing publisher code:

```bash
npm run build:n8n-carousel
npm run qa:social-carousel
npm run qa:n8n-agenda
npm run qa:release
git diff --check
```

The release gate includes both social checks and `npm run build`. A failed
build or another failed required check blocks deployment.

The generated `ops/n8n/event-zeka-daily-instagram-carousel.json` is deliberately
inactive with `staticData: null`. Before updating the existing live workflow,
read its current definition, active state and complete static data into memory
or a private temporary export. Merge into the same workflow identity and
preserve the live static data; do not replace successful publish receipts with
the export's null value. Keep one active daily publisher, not an additional
scheduled clone. Preserve the current environment and credentials outside the
repository. Remove temporary exports, raw verification logs and preview files
after the verified update; retained deployment backups are not required.

Required n8n environment values are `EVENTZEKA_API_ORIGIN` and
`EVENTZEKA_CRON_SECRET`. Live Instagram publication also uses
`EVENTZEKA_IG_USER_ID` and `EVENTZEKA_IG_ACCESS_TOKEN`, plus the existing optional
`EVENTZEKA_IG_GRAPH_BASE_URL` and `EVENTZEKA_IG_GRAPH_VERSION` settings.
The publisher defaults `EVENTZEKA_IG_LOCATION_ID` to the verified Belgrade,
Serbia Page ID `109920975697736`. It sets `location_id` on the parent carousel
container, not its children, and records `lastLocationId` on successful
publication. Dry runs include the intended location without contacting Meta.

Set `EVENTZEKA_SOCIAL_DRY_RUN=true` while verifying an inactive or staged
workflow. Dry runs fetch the payload and preflight its exact versioned JPEGs,
then return the caption and preview URLs. They do not create Instagram media,
publish, read or change workflow static data, and do not require Meta
credentials. The UI manual trigger also always previews. An ephemeral
`EVENTZEKA_SOCIAL_PREVIEW_HISTORY=true` additionally permits read-only Meta
history checks during a dry run, without publication or state access.
An empty window returns `skipped_no_events`. Remove the dry-run
setting or set it to false only when the production workflow is ready to run.

## Publication state and recovery

Before creating media, n8n checks every image URL with HEAD. A stale selection,
withdrawn event or image failure stops the run. The publisher waits for created
Instagram containers to finish before attempting publication. Account tag
rejection can retry container creation without those tags; the result records
which tags fell back.

Successful publication records `lastPublishDate`, `lastSelectionKey`,
`lastPostId` and `lastPublishedAt`, plus `lastEventIds` and a bounded 31-entry
`publicationSelections` history. A matching publish date or selection key is
skipped, including when later facts change the same day's selection. Deploying
new formatting must not reset that receipt or produce another same-day post.

Immediately before the publish request, the workflow records a pending
selection, media container and attempt time. The publish request is attempted
once. A transport failure or missing published media ID leaves a pending state
and returns `blocked_reconciliation_required`; later dates and changed
selections remain blocked as well. Reconcile that exact attempt against
Instagram before clearing pending state. Preserve confirmed success receipts
and never clear an uncertain attempt merely to force a retry. Missing Meta
credentials return `blocked_meta_authorization_required` with preview details.

## Production deployment and repair

Production can route `/api/social` to its own container while the newer main
application continues serving the calendar, admin UI and ingestion routes.
Deploy the social API, fonts and dependencies into that existing social-only
split; do not replace the main application with an older full-repository build.
Keep existing social image route compatibility when packaging the release.

Before switching traffic, verify the staged payload and all returned JPEG URLs,
including exact IDs, dates, dimensions, caption and venue tags. Read the current
social routing configuration and latest n8n workflow state, keeping any temporary
export private. Activate the new social route and workflow only after those
checks and the release gate pass. Preserve an already published receipt for
today and remove temporary files after verification.

Production retains the current main and social releases with their required
sources, Compose files, fonts and dependencies. The user's production-only
cleanup removed the previous v7 and superseded web containers, artifact backups
and undeployed previews. There is no retained fallback container to restore by
stopping the current social service.

If a candidate fails its checks, keep the current production release active.
Repair a deployed issue from the retained sources and verify the matching
social API and publisher before reactivation. Carry forward the latest live
successful and pending publication state so an update cannot replay a post.
Keep the actual receipt in the operational n8n database, and leave the main
application, Convex data and ingestion schedule in place. Record the current
release paths, container names, workflow activation and smoke results in a
deployment receipt rather than assuming this document proves live activation.
