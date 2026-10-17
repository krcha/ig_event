# Separate Instaloader collector

This is the explicitly requested migration path from Apify post scraping to a
separate Instaloader container. It does not migrate Convex, Clerk, OpenAI,
existing events, or historical Apify recovery. The production selector defaults
to `apify` until required live-post and feed-coverage comparisons are accepted
and the backend that understands the optional compatibility marker is deployed.

On 2026-10-14 the user requested that Instaloader remain paused after Instagram
redirected the signed-in browser to a verification/sign-in page. Keep the
collector stopped with its session and durable state intact. Production
continues on Apify; do not resume live checks or cut over until the user resumes
the migration and authentication and coverage checks pass.

## Accounts and rules

The app remains the only account-list and scheduler authority. The daily loader
continues merging active Instagram sources and scrape-active venue handles,
deduplicating them and freezing the same daily snapshot. Do not configure a
second account list or a second ingestion cron in the collector.

The existing controller keeps six fetch lanes, its six-result daily/catch-up
window, four-result canary, one-day daily/canary horizon, recent-pin policy,
checkpoint/cooldown behavior, provider-attempt receipts and saved-post resume.
The collector serializes actual Instagram requests through a persistent worker;
six app requests can wait within their existing bounded deadlines.

Both transports use the same final normalization, original-owner selection,
date filtering, duplicate selection and source identity. Instagram decimal post
IDs must match their shortcodes exactly. Image/video carousel children retain
their original ordered positions and complete counts. An incomplete carousel,
ambiguous pin, incomplete pagination, login challenge or timeout is a provider
failure, never a successful empty result. Transport failures do not trigger
automatic paid fallback.

The Instaloader adapter preserves incoming accessibility text unchanged. A
separate pure compatibility check can identify a complete generated wrapper
around the same `Photo by <author> on <date>.` attribution. It accepts only a
well-formed handle list and the observed generic image-description tail;
custom text, OCR, event facts, date/author mismatches and unknown formats fail
closed. It also rejects old alts over 1,024 UTF-16 code units, incoming alts
over 4,096 code units, author labels over 256 code units and handles longer
than 30 characters. The cache-preservation path also requires complete,
ordered manifests of matching static photo-CDN paths, matching `ig_cache_key`
values, and matching declared slide counts. Slide indexes alone do not prove
asset identity. These checks are evidence for preserving an existing completed
quality analysis; they do not rewrite incoming provider data or establish
equivalence for video, partial carousels, or unrecognized CDN URL formats.
Multiple alternate URLs for one slide qualify only when every URL resolves to
the same certified path and cache key. Current path recognition is limited to
the verified `t51.82787-15` Instagram photo family; other families fail closed.

The existing-source upsert evaluates this proof atomically, and only for an
existing source with a completed current-quality analysis. It also requires all
other source fields to match before retaining the prior canonical alt and
analysis cache. A transient optional provider marker is scoped through the
Instaloader scraper and upsert arguments; it is not stored as schema or source
data. Unproven differences follow normal source-revision and reanalysis
behavior. The change does not alter source fingerprints or moderation rules.

The collector applies upstream date/pin filters before filling the result window
and inspects at most 40 feed rows. If the requested window cannot be filled and
feed exhaustion is unconfirmed, it holds the incomplete result instead of
advancing a checkpoint. Raw feed ordering and filtered-window coverage must
still be compared on real profiles before switching. Offline contract checks
alone do not certify equivalent collection coverage.

A quiet profile with fewer eligible posts than the requested limit can hit the
40-row bound even when every inspected row is old. This returns
`incomplete_window`, not an empty success. Resolving this limitation requires
evidence of a complete date-eligible window; stopping at the first old row is
unsafe when pinned or out-of-order rows are present.

## Container setup

`docker-compose.instaloader.yml` is an independent Compose project. It has no
published ports or public Traefik route. Its API is reachable only on the Docker
network, requires a separate token, runs as UID/GID 10001, has a read-only root
filesystem, and is limited to 384 MiB, half a CPU and 64 processes.

Create a protected collector env file outside Git, for example
`/etc/ig_event/instaloader.env` (mode 0600), containing:

```env
INSTALOADER_API_TOKEN=<separate randomly generated token of at least 32 characters>
INSTALOADER_SESSION_DIR=/etc/ig_event/instaloader-session
INSTALOADER_SESSION_USERNAME=<Instagram login username>
INSTALOADER_NETWORK=n8n-compose_default
INSTALOADER_IMAGE_TAG=<verified release commit>
```

Create the session directory with mode 0700 and owner 10001:10001. The service
mounts it read-only; its `session` file must be readable by UID 10001 and mode
0600. Session files are credentials and must stay out of Git and release logs.

```bash
docker compose --env-file /etc/ig_event/instaloader.env \
  -p eventzeka-instaloader -f docker-compose.instaloader.yml up -d --build
```

Use one interactive CLI login to create the session, entering password and 2FA
privately. Supply only the username in the command. This command has no scrape
targets and does not import an account list:

```bash
docker compose --env-file /etc/ig_event/instaloader.env \
  -p eventzeka-instaloader -f docker-compose.instaloader.yml \
  run --rm -it --no-deps --entrypoint instaloader \
  -v /etc/ig_event/instaloader-session:/login \
  instaloader --login <username> --sessionfile /login/session
```

Restart only the collector after installing or refreshing the session. `/health`
is process liveness. `/ready` checks protected-session configuration and reports
`instagramVerified: false`; it does not authenticate with Instagram. A live
read must pass before switching the app. Production anonymous collection stays
disabled.

## Protocol and durability

The app sends authenticated `POST /v1/scrape` requests with a stable acquisition
ID, target, bounded post count, ISO date boundary, pin policy and timeout. The
collector returns schema version 1, complete raw `items` and truthful
`rawItemCount`; `inspectedItemCount` separately records scanned feed rows. The
Node adapter applies the existing final eligibility rules.
Unexpected upstream errors return a sanitized `diagnosticCause`, and readiness
reports the remaining safety pause as `retryAfterSeconds`. Neither response
exposes raw exception text.
Legacy checkpoint boundaries remain effective locally.

The persistent state volume keeps acquisition outcomes and Instagram request
admission history. Replaying an acquisition ID with identical rules returns its
cached result. Changed rules conflict. A crash with an uncertain outcome cannot
launch another Instagram request under the same ID. Normal provider/rate/timeout
failures pause collection to prevent repeated challenges across the account list.
Do not delete the state volume or replay attempted controller receipts to recover
a partial run. Inspect exact cached acquisition outcomes instead.

Existing controller `chargedMicros` reservations remain compatibility admission
limits; they do not become measured Instaloader or proxy charges. Following-list
discovery and historical dataset recovery still use their existing Apify paths.

## Verification and cutover

1. Run the Python offline tests, `npm run qa:instaloader`, the required
   `npm run qa:release` including build, and `git diff --check`.
2. Verify container auth, missing-session rejection, persistence and bounded
   parallel requests. Confirm the service has no public port/route. Unexpected
   upstream errors expose only a sanitized diagnostic cause; readiness includes
   the remaining pause interval.
3. A protected session was verified on the Mac and installed securely on the
   VPS. Authenticated requests returned KISSA's two-image and Lozionica's
   four-image carousels with matching identities, captions, dates, venues and
   ordered child IDs/types. Do not retry an Instagram password login. Three
   other selected live posts and feed-window behavior are still unverified.
   KISSA's enrichment passes the narrow compatibility proof; Lozionica's
   alternate generated alt format fails that proof and retains normal revision
   invalidation. These comparisons did not write sources or events. The
   historical Frida request failed, and its public post
   URL was also unavailable in Brave while signed in as the collector account.
   The collector's original generic error does not establish the upstream cause
   or justify changing existing events. Keep the provider selector on Apify
   until those post and feed checks are accepted.
4. Deploy the backend optional-argument support before deploying any web client
   that can send the transient compatibility marker. Then configure the private
   `INSTALOADER_API_URL`, matching `INSTALOADER_API_TOKEN`, and bounded
   `INSTALOADER_TIMEOUT_SECONDS` in a verified web candidate. Keep
   `INSTAGRAM_SCRAPER_PROVIDER=apify` until all live post/feed checks pass.
5. Only after accepting the comparisons, set
   `INSTAGRAM_SCRAPER_PROVIDER=instaloader`. Confirm public/readiness health and
   unchanged existing-event records before routing new acquisitions. Preserve
   the previous web release for rollback.

Rollback selects `INSTAGRAM_SCRAPER_PROVIDER=apify` for new acquisitions and
restores the previous web release. It never rescrapes uncertain attempted
receipts or changes already stored events.
