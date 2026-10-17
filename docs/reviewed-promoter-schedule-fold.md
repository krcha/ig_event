# Reviewed promoter and venue schedule fold

`reviewedPromoterScheduleFold:getReviewedPromoterScheduleFoldContext` and
`reviewedPromoterScheduleFold:foldReviewedPromoterScheduleDuplicate` are
service-authenticated operator APIs for one reviewed occurrence represented by
a promoter's single-event post and a physical venue's weekly schedule post.
They do not change automatic deduplication or general venue repair policy.

Read the context with `operationId`, `primaryId`, `duplicateId`,
`targetVenueId`, and `serviceSecret`. It returns `primary` and `duplicate`,
each containing `event`, `sources` (`link`, `receipt`, `occurrence`), bounded
saved references, and audit rows for that operation; `targetVenue` supplies
the catalog revision. Retain the full context privately before writing. Re-read
it after an uncertain acknowledgement to distinguish a committed operation
from a failed precondition. Repeating a committed mutation fails its original
optimistic preconditions instead of applying another fold.

The mutation requires these exact versions from a fresh context:

```ts
const sourceVersion = ({ link, receipt, occurrence }) => ({
  sourceLinkId: link._id,
  sourceLinkUpdatedAt: link.updatedAt,
  receiptId: receipt._id,
  receiptUpdatedAt: receipt.updatedAt,
  sourceOccurrenceId: occurrence._id,
  sourceOccurrenceUpdatedAt: occurrence.updatedAt,
});

const args = {
  operationId,
  primaryId: context.primary.event._id,
  expectedPrimaryUpdatedAt: context.primary.event.updatedAt,
  expectedPrimaryNormalizedFieldsJson:
    context.primary.event.normalizedFieldsJson,
  primarySource: sourceVersion(context.primary.sources[0]),
  duplicateId: context.duplicate.event._id,
  expectedDuplicateUpdatedAt: context.duplicate.event.updatedAt,
  expectedDuplicateNormalizedFieldsJson:
    context.duplicate.event.normalizedFieldsJson,
  duplicateSource: sourceVersion(context.duplicate.sources[0]),
  expectedPrimarySourceHandle,
  expectedScheduleSourceHandle,
  targetVenueId: context.targetVenue._id,
  expectedTargetVenueUpdatedAt: context.targetVenue.updatedAt,
  expectedTargetVenueHandle: context.targetVenue.instagramHandle,
  nextVenue: context.targetVenue.name,
  programTitle,
  nextTitle,
  expectedScheduleRow,
  expectedScheduleCaptionLine,
  nextDescription,
  moderationNote,
  serviceSecret,
};
```

Admission requires two currently grounded approved v2 events with distinct
posts and source identities, the same calendar date, and unknown (`TBD`)
times. Each must have exactly one coherent source link, receipt, and current
first-class occurrence. All six source revisions, both event revisions and
normalized JSON strings, and the public target venue revision are checked.
The schedule account must equal the target venue account; the promoter
account must differ. The saved-reference bound and four-event
affected-representative bound fail closed; publication refresh remains
synchronous inside this transaction.

`programTitle` must equal the existing weekly event title and occur as an
explicit whole-text anchor in the promoter caption. `expectedScheduleRow`
must equal the exact persisted row and the corresponding immutable extraction
schedule entry for this date, contain the program title, and state the matching
day/month. `expectedScheduleCaptionLine` must be an exact caption line for that
day/month containing the promoter account mention. The selected title can be
the original promoter title or the supported program title. A new description
is an explicit human-reviewed field. The promoter's artist array, date, time,
time evidence, source identity, source caption, raw extraction, and media fields
are retained.

The atomic write re-attests only the selected row in each receipt to the final
representative, rejects the weekly duplicate, and moves its complete source
topology to the retained primary URL. Both first-class normalized bindings and
signatures are refreshed. Observed `factsJson` and `canonicalEventJson` remain
unchanged, including those embedded in receipt rows. All other schedule rows
and their satisfaction references remain exact. The operator does not need
to replace a sparse weekly artist claim with invented extraction evidence.

The transaction proves the full final topology, every affected receipt
satisfaction, current grounding, and immutable observed evidence before it can
commit. It moves/deduplicates saved references, refreshes derived states for
both events and remaining receipt representatives, and records audits for
both events. Proven writes preserve the verified topology frontier only if it
was already intact; they cannot certify a pre-existing unverified gap.
The retained primary must finish publishable, and the publication decision and
existing public visibility of each unrelated receipt sibling must be preserved.
An incomplete weekly source aborts the fold instead of hiding the retained URL.

These markers deliberately do not enroll the event in the cross-post campaign
aggregate protocol. Every compatibility link, receipt satisfaction, and current
first-class occurrence is moved to the same canonical representative and has
the same re-attested semantic binding. Ordinary provenance guards therefore
remain applicable to later edits, merges, and retention. There is no retained
legacy-link exception requiring campaign-specific retirement.

Changing a misclassified source account to `promoter` remains a separate
reviewed `instagramSources:setRole` operation with its own expected revision.
The fold does not rename the source account's former venue catalog entry or
alter unrelated events. It also does not infer an event time from a venue's
profile opening hours.
