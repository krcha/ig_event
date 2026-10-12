# First Luna extraction-quality release

This release keeps `gpt-6-luna`, the strict `event_evidence_v2` output contract,
the existing occurrence identity/merge rules, and the exact retained poster
approval protocol. It targets source interpretation and unnecessary review
holds without migrating or reprocessing historical events.

The system prompt removes the duplicate JSON example and repeated instructions.
Its final size is 18,372 characters, down from 27,182. It explicitly scopes poster
rows, performer roles, independently attendable sessions, branch locations,
dates, named programs, admission conditions and genuine event announcements.
DJ slots inside one party remain one occurrence; separate room programs and
repeated museum tours remain distinct.

New provider responses receive the wrapper-owned `event_quality_v1` marker.
An absent marker preserves the interpretation of existing cached v2 JSON;
parsing never upgrades or rewrites those caches. New analyses independently
validate calendar format/month/weekday consistency. A contradictory weekday
holds the occurrence instead of silently changing its date or year. Explicit
tour session clock lists can prove separate starts; entrance/door clocks cannot.

For named cultural branches, the planner binds the actual contiguous dated row
to its preceding source heading. A narrowly recognized model prefix may be
removed only when it exactly names that source branch and section label. The
remaining row must occur in the source under the same branch. Intervening venue
headings, ambiguous repetitions, fabricated rows and tampered derived proofs
are rejected. Identity and venue checks use this independently recovered row.

Exact positively located posting-account handles can prove their physical
venue for new analyses. Casual, negated or competing handle mentions cannot.
This preserves KULT afterparties and Drugstore roundup rows when another venue
appears elsewhere in the post.

Public calendar/detail/directory pages project curated venue labels by venue ID
and retain aliases for search and old links. Filter option values use stable
venue IDs, so different spellings of one place share an option while distinct
branches remain separate. This is a read projection; stored source facts stay
unchanged.

Ordered carousel manifests and completion safeguards are described in
[Instagram image coverage](instagram-image-coverage.md). They report unread
siblings, preserve exact cached analyses/assets/events during CDN refreshes,
and reuse cached results without another paid model request. Full later-slide
analysis still requires a separate retained-asset/proof protocol extension.

The manually labeled real-post evaluation and its remaining review holds are
documented in [the evaluation report](instagram-real-post-evaluation.md).
Evaluations do not write to Convex or publish their planned events. Four new
deterministic release gates cover source calendars, extraction quality, image
coverage and public venue identity. Existing publication, receipt, merge,
retention, auth and release checks remain required.

Deploy the additive Convex schema/functions before a web/ingestion release
that submits optional slide metadata. Use an isolated production build and a
read-only canary before promotion, retain the previous main web release and
the separate social routes, and verify public event parity after promotion.
No migration, ingestion trigger, historical cache replay or event data repair
is part of this release. A web rollback retains the additive backend after
new optional metadata has been written.
