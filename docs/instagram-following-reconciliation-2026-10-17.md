# Instagram following reconciliation, 2026-10-17

The user requested comparing every account followed by `@eventzeka` with the
complete venue inventory and adding missing profiles. The comparison includes
pending and hidden venue records, normalized canonical handles, aliases,
provider identities and existing source records.

## Current-source evidence

One fresh following-provider run returned 590 unique valid accounts for
`eventzeka`. Run `jhE2Ly64VOh5BgH5F`, dataset `6UnGTg8HrsLnMewQZ`, completed
successfully with an actual charge of USD 0.413. It used a 2,000-item limit,
USD 1.50 hard charge cap and 300-second timeout. All dataset items were read.
The actor nevertheless ended without a continuation token before reaching the
Instagram following counter. No paid retry or post-detail scrape was launched.

The authenticated owner profile showed 680 following after a fresh reload;
anonymous public metadata still showed 684. The provider response was therefore
retained as incomplete. Read-only owner-browser Following observations supplement
the current provider records. Historical October 15 data was used only to choose
comparison/search candidates, never to fabricate current list membership.

At operation planning, 501 distinct accounts had been observed in the current
owner-browser Following list or settled Following search results. Their union
with the 590 current provider rows contains 679 confirmed current accounts.
This input was sufficient to verify every proposed creation before applying it.
Final read-only tail verification subsequently identified `ljubavnica_bar`,
already an existing published venue with paused scraping. Its exact Following
row link was verified at `2026-10-17T20:14:37.063Z`. The final union of 590 current
provider accounts and 593 directly observed UI accounts contains 680 distinct
current handles, matching the independently refreshed owner counter at
`2026-10-17T20:15:30.955Z`. The intersection contains 503 accounts, with 90 seen
only through the UI and 87 only through the current provider response. This is
combined current-source coverage, not a claim that all 680 rows were read in the
browser. No historical membership was used to fill the list.

The final comparison has 674 exact canonical-handle matches, one provider-alias
match and the five reviewed potential duplicates below; no current handle is
left unreviewed. Ljubavnica's record and pause require no additional write.
`irishpubcrazyhorse` remains a historical account outside the verified current
set; its existing venue and source are preserved by this add-only operation.
Exact punctuation searches sometimes returned false negatives; broader searches
and exact row links were checked before drawing conclusions. No account was
followed, unfollowed or messaged.

Final combined 680-handle snapshot SHA-256:
`ab4be558acae7399422660308dcf7b5c7f49d3a4455ddf50fd99213594001c6f`.
The frozen 679-handle apply input remains unchanged for auditability. Both the
complete final proof and original operation evidence are retained privately.

## Reviewed additions

`data/instagram-following-additions-reviewed-2026-10-17.json` records the exact
52 proposed profile creations, one proven provider-account affiliation, five
withheld potential duplicates, review URLs and evidence hashes. Every proposed
creation is independently present in the confirmed current evidence.

The 644 existing venue records include all lifecycle states. There are 58
confirmed current handles without an exact canonical venue handle:

- 52 distinct account/profile entries use the existing discovery defaults:
  `publicStatus: pending`, `scrapeActive: true`, `category: venue`.
- `funkandsoulfrancuska` belongs to the existing Francuska 6 venue. Its exact
  current owner address and phone match the stored Google business feature.
  A manual Instagram provider identity links it to the existing venue; this
  does not assert that the old Instagram account was renamed.
- `baraka_bg`, `dvoristance.bar`, `ameliecafe.bg`, `buducnost.belgrade` and
  `fomo__festival` remain unresolved potential duplicates. Their existing
  source records remain available, and no duplicate canonical venue is made.

The 52 account entries include 25 physical-venue candidates, 13 event brands,
six promoters, two performers, one media account and five unclassified accounts.
Pending status avoids presenting those research classifications as published
physical businesses. Centre Culturel de Serbie is in Paris and is explicitly
marked accordingly in the review. No map points or visitor hours are inferred.
The distinct Radar parent profile uses the source-supported name `Radar Belgrade`
to avoid colliding with its related record-label profile's canonical name.

## Production operation and verification

The private reviewed operator and receipts are stored in
`/root/ig_event-release-artifacts/following-reconcile-20261017/` on the existing
production VPS. The directory is mode 0700 and files are mode 0600.

The operator uses the deployed `venues:createVenue`,
`instagramSources:backfillFromVenues` and `venueIdentities:upsertIdentity`
functions. Its preview freezes the exact database, reviewed-data hash, backend
fingerprint and protected-service identities and start times. The apply rejects
a changed database rather than blindly retrying a partly applied operation.

The source backfill is restricted to the exact new pending venue records. Before
creation, a nonterminal pagination cursor is retained immediately before the
last old venue. After creation, the exact last old ID is rechecked; the following
page must contain exactly the newly created IDs. Both preview and apply use the
same bounded cursor and item/read limits. Only five missing source records may
be inserted, each as active with role `unknown`. Existing source rows cannot be
reconciled through the pending venue tail. The existing `after.belgrade`
canonical record and its paused scrape state remain unchanged.

No global following synchronization is submitted. Existing activations, pauses,
roles, fetch checkpoints, following timestamps and following-sync state are
preserved. No historical-post bootstrap is triggered; regular ingestion keeps
the existing 24-hour policy. Production data updates are consumed live, without
a web or backend redeployment.

The apply completed at `2026-10-17T20:08:28.694406Z`:

| Data | Before | After |
| --- | ---: | ---: |
| Venue/profile records, all states | 644 | 696 |
| Pending profiles | 56 | 108 |
| Explicit Instagram source records | 693 | 698 |
| Active explicit sources | 674 | 679 |
| Venue identity claims | 1,386 | 1,491 |

All 52 creates, five missing-source inserts and the one provider alias passed
immediate readback checks. Every pre-existing venue, source and identity row
remained byte-for-byte unchanged. The 105 new identity claims were bounded and
checked against the exact newly created venues and the reviewed provider alias.
The following-sync state, deployed backend fingerprint and seven protected
service identities, start times and mounts also remained unchanged.

Reviewed operation dataset SHA-256:
`be1af6ce418b95fff55ba9abc7f08366d08bbaf445aa3bdbef711eb7c5a7c5b2`.

Public verification at `2026-10-17T20:08:57.056Z` confirmed 578 existing published
profiles, 290 known schedules, 193 missing map points and 288 missing schedules.
All 52 new pending profiles are excluded from the public API as intended.
`https://eventzeka.com/api/health` returned HTTP 200. The current web container
remains `ig-event-web-schema-hours-4718382`; no redeployment was necessary.

`npm run qa:release` passed, including the production build.
Repository hygiene and `git diff --check` passed. The reviewed manifest includes
the exact newly created venue IDs and the production readback summary. Raw
provider/browser exports, full before/after snapshots and credentials are not
committed.
