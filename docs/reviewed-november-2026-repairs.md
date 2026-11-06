# Reviewed November 2026 event corrections

These corrections address the user's reviewed November 6/7 listings without
changing the automatic duplicate classifier, source extraction contract,
moderation policy, or provider selection.

## Program boundaries

The extraction prompt has four additive examples. A hospitality program may
contain a food special and a later DJ slot; an explicitly shared club night may
contain room-specific programs. Preserve the component times, performers and
room labels in the parent event. A dish price is not admission. Shared date,
venue, account or start time alone never proves one event.

Separately titled works with independent starts remain separate. In particular,
Kolarac's Stablo Masline at 18:30 and Pukotina u ledu at 20:30 remain two
screenings. Programs below physical venue headings belong to those sections:
Sprat and Zaokret on a shared poster are separate venues.

`qa:carousel-extraction` exercises these boundaries through the existing
occurrence planner, including existing independent-room counterexamples. A
private four-call shadow evaluation also submitted original retained media to
the configured extraction provider. It verified the requested Bife, Vrtoglavica,
Sprat/Zaokret and Kolarac grouping. This is prompt guidance and regression
coverage, not model fine-tuning or a guarantee for every future poster.

## Exact reviewed consolidation

`reviewedNovember2026Repairs:getContext` and `:consolidate` are service-only
operator APIs for seven fixed incident groups. They accept a group key rather
than arbitrary event IDs or replacement public facts. The exact reviewed
context fences event, source, occurrence, receipt, venue, sibling and saved
reference revisions. Existing source evidence is retained, selected component
listings are rejected, and saved references move to the retained listing.
Independent receipt siblings and their visibility must remain intact.

The existing reviewed-fold lineage guards protect the resulting bindings from
ordinary replay and generic event edits/merges. The general duplicate rules
remain unchanged. Do not add new incidents to this frozen list as an automatic
deduplication mechanism.

`scripts/repair-reviewed-november-2026.mjs` previews one step and applies it only
with that preview's hash and a new private receipt. It checks the two independent
Kolarac screenings and Saturday's separate Ladidadi program before and after
each write. Re-preview after any uncertain response; never retry blindly.

Venue naming and poster section corrections use the existing version-fenced
venue/update and reviewed source repair APIs. Fazenda keeps the previous label
as an alias. Matrez/Hangar Matrez resolve to the existing Hangar catalog entry.
Zaokret rows are rebound individually, retaining original raw extraction and
all other poster rows. Private before/after receipts and the verified data-only
Convex backup remain outside Git on the production host.

Required gates include `qa:reviewed-november-repairs`,
`qa:reviewed-november-operator`, the existing extraction/provenance/merge gates,
and the full `npm run qa:release` including the production build.
