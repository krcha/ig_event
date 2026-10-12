# Instagram image coverage

The current extraction pipeline analyzes one successfully decoded source image
per post revision. Its saved source URL, SHA-256 checksum, retained media asset,
and publication evidence still attest that exact image. This release adds
truthful coverage diagnostics; it does not analyze every carousel slide.

The scraper retains an ordered `imageSlides` manifest only when the provider
explicitly supplies child posts, sidecar images, or a sidecar's `images` array.
Each slide groups up to eight alternate URLs, with at most 20 retained slides and
2,048 characters per diagnostic URL. `imageSlideCount` retains the provider's
full declared count even when the manifest is clipped. HD images, thumbnails,
`image_versions2`, and old flat URL arrays alone never establish extra slides.
The existing candidate priority stays unchanged for old provider shapes.

The acquisition manifest is optional source metadata. It does not change the
source fingerprint, invalidate legacy analysis bytes, or rewrite existing
approved events. Deploy the additive Convex schema and functions before the web
and ingestion code that submits these optional fields. No migration is needed.
Later observations retain the largest known count and already observed slide
URLs; an unknown or truncated provider response cannot erase known siblings.

Only new wrapper-stamped `event_quality_v1` analyses use `_imageCoverage` for
source completion. The wrapper derives it from the actual selected source URL;
the analysis mutation independently compares it with the persisted manifest and
the already validated image URL/checksum pair. A model cannot certify unread
slides by claiming full coverage. Legacy cached analyses retain their previous
completion behavior.
Upsert, claim, processing completion, and pipeline checks recompute coverage
against current observations and the exact saved analyzed-image URL. Discovery
of a second slide therefore makes an old one-slide complete result partial
without changing its raw bytes or source revision. A current new-policy cache
also survives rotation of candidate CDN URLs; these metadata changes do not
invalidate the independently retained poster or create another paid analysis.
Caption, alt text, location, post type, and posting-time changes still advance
the source revision through the existing invalidation policy.

When known sibling slides remain unread, the post receives
`retryable_failure` / `source_media_partial` with the existing bounded backoff.
It does not block unrelated paid source fetches. Verified extracted occurrences
and their receipt remain valid, so an attested first-slide event can still be
published. Receipt completeness for known extracted rows does not certify that
the whole carousel was read. Cached retries reuse the saved analysis; a satisfied
receipt exits before provider execution. Other persistence failures keep their
own error details.

The remaining carousel work is a separate protocol extension: retain independent
assets and checksums for a bounded set of actual slides, bind every model input
and event evidence to those assets, update approval/grounding/receipt checks,
and preserve the existing single-image proofs. Removing the current first-image
break would bypass these guarantees. Until that work ships, independently
announced events available only on later slides may be missed and are explicitly
reported as partial source coverage.

`scripts/qa-instagram-image-coverage.mjs` runs without provider calls. It exercises
provider/domain/persistence boundaries and registered mutations with two
independent Saturday/Sunday slide programs, alternate resolutions, clipped and
ambiguous manifests, legacy cache preservation, exact input binding, false
completion rejection, cached retries, and preserved event/receipt references.
