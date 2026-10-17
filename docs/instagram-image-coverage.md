# Instagram carousel extraction and image coverage

New posts with an explicit multi-slide manifest send up to 20 independently
retained slide images to one `gpt-6-luna` Responses request. The joint request
groups repeated flyers and complementary lineup slides into occurrences, while
each returned row carries its own date, time, venue, category, price, conflicts,
poster slide indexes and exact text fragments. Separate dates, sessions, rooms
and physical branches retain separate occurrence identities.

Paid Apify profile acquisition always starts with `basicData`, an absolute
cutoff at most 24 hours old, and `skipPinnedPosts=true`. A newer persisted
watermark narrows that cutoff further. Older `daysBack`, `noAgeCutoff`,
`detailedData`, or pinned-post env settings cannot widen this paid boundary.
Local owner/date checks discard old, undated and foreign-owner rows before
considering additional details. Arbitrary paid direct-post requests are blocked
because their age cannot be verified before payment. Existing dataset imports
remain age-unrestricted, but skip incomplete basic rows before deduplication so
an older complete carousel can supply all its slides. The optional Instaloader
collector retains its prior behavior.

Basic rows with the caption field, post type, primary image and complete
explicit carousel children need no detailed request. An ordered basic `images`
array also suffices when an independent declared count matches every image.
Missing source fields or an incomplete carousel trigger one detailed request
limited to the verified
fresh post URLs. A detail result must match the basic post ID, permalink, owner
and timestamp. Carousels require every ordered child, including video thumbnails,
with no contradictory declared count or duplicate child identity; previously
observed child identities keep their order. Missing or mismatched details fail the
logical scrape so ingestion cannot save a cover-only carousel and advance past
unread slides.

`APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN` is a shared ceiling for the logical scrape,
including discovery and details; it is not a new allowance for each phase.
Before details, the scraper waits for the basic run's billing settlement and
reads its authenticated run receipt. Only the remaining budget may fund the
second phase. Unknown charges or less than Apify's minimum $0.005 run allowance
fail closed without another paid start. Both phases and read-only polling use
one absolute lease deadline and the existing durable paid-attempt marker.
`npm run qa:apify-recent-media` verifies these paths with mocked provider runs.

Only provider `childPosts`, `sidecarImages`, or a Sidecar `images` array establish
an ordered slide manifest. Alternate resolutions stay within their slide.
At most 20 slides and eight alternate URLs per slide are retained; the full
declared count remains available even if clipped. URLs are bounded to 2,048
characters. Optional child `mediaType` preserves known videos. Video thumbnails
can support facts visible in that still, but cannot certify unseen video content:
`videoSlideIndexes` keeps source coverage partial. No video transcription occurs.

The caller downloads and normalizes each usable slide, hashes its original
bytes, and independently retains the matching raster before sending it to Luna.
Preparation has three concurrent workers, a 60-second candidate deadline, and
a 24-MiB aggregate normalized-image budget. Failed, inaccessible or over-budget
slides are excluded from the request and remain partial. A model cannot claim
to have read them. `_carouselMedia` and `_imageCoverage` are caller-owned;
provider output cannot supply storage IDs, checksums or completion claims.

The optional `carousel_evidence_v1` contract extends `event_evidence_v2` only for
these new requests. Each occurrence is normalized through the shared existing
planner using its exact row-local caption/alt-text and poster evidence. The
original caption, raw response bytes, source identity and revision remain the
provenance authority. Semantically identical occurrences are collapsed
conservatively; artists may be united only for the same supported occurrence.
Root-wide facts from unrelated slides cannot authorize a row.

Convex validates every retained input against the saved source revision,
declared slide and SHA-256 checksum before recording the immutable analysis.
Approval and public grounding require all input assets, including non-display
slides, to remain retained. Each event displays its own selected retained slide.
Carousel assets use independent source/revision/slide identities and never
attach themselves to existing source-wide images or historical events. Cleanup
protects assets required by current analyses, active workers and retained events.

Cached carousel retries reuse the independently retained assets and immutable
response bytes without another image fetch or paid request. Harmless CDN URL
rotation preserves the proof. Later discovery of additional slides marks a
previous bundle partial without rewriting it. Existing single-image analyses,
completed receipts and published event documents retain their previous behavior;
deployment performs no historical reprocessing, repair or migration.

Known unread, clipped or video slides produce `source_media_partial` with the
existing bounded backoff. Verified extracted occurrences remain valid and may
publish independently. Receipt completeness for extracted rows does not certify
that the whole source was inspected. A source with no usable retained slide is
retryable and does not send a paid extraction request.

Deploy the additive Convex functions/schema before the new web/ingestion build.
Keep the prior main container for web rollback; the optional backend additions
remain compatible with it. Deterministic release gates cover input selection,
proofs, retention, scoped planning, duplicate collapse and legacy preservation.
Real-post evaluation is isolated from ingestion and cannot write events.
