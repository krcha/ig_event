# Instagram carousel extraction and image coverage

New posts with an explicit multi-slide manifest send up to 20 independently
retained slide images to one `gpt-6-luna` Responses request. The joint request
groups repeated flyers and complementary lineup slides into occurrences, while
each returned row carries its own date, time, venue, category, price, conflicts,
poster slide indexes and exact text fragments. Separate dates, sessions, rooms
and physical branches retain separate occurrence identities.

The scraper defaults to `APIFY_DATA_DETAIL_LEVEL=detailedData`: the basic package
omits child posts in current production datasets. Both template env files use
detailed data; production must explicitly override any older basic-data env
setting. Apify charges extra for detailed results. Existing per-run charge caps,
post limits, durable paid-request receipts and budget controls remain enforced.
An explicit `basicData` override remains supported for operators.

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
