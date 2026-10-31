# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People looking for events in Belgrade browse by date, category, text, place, or map location and keep events for later. A small admin workflow manages event ingestion and moderation. No narrower audience persona is established.

## Product Purpose

Event Zeka is a Belgrade events aggregator. Its public calendar connects events to venue activity and original Instagram sources so visitors can find an event, inspect its details, and save it.

## Operating Context

Public routes include Events and calendar browsing, Discover, Map, Saved, the guest/account profile, venue directory, venue details, and event details. Events offers date, text, category, Open now, and sorting controls. Discover retains its poster gallery and mobile swipe workflow. Map retains venue pins, date filtering, pan, zoom, and location controls.

Guests save locally. The existing sign-in and library flow synchronizes guest choices with the user's account. Authentication and account behavior remain part of the existing application rather than the earlier standalone HTML proposal.

## Capabilities and Constraints

- Preserve the existing Convex APIs and data model, Clerk authentication, OpenAI extraction, and Apify Instagram scraping unless the user explicitly requests a migration.
- Preserve ingestion and moderation semantics: genuine, unique, source-supported events can be approved automatically; extraction confidence alone does not block approval. Exclude non-events and duplicates, retain actual calendar dates, and resolve source contradictions without inventing facts.
- Keep duplicate merging conservative and operator outcomes explicit.
- Preserve original Instagram image/caption/source context and the existing expandable post and Save behavior.
- Open now describes venue operating hours; it does not establish that an event has started. Preserve uncertainty and inferred-time labels.
- Events sorting covers time, later first, title, and venue name. Sort the complete matching set stably before virtualization, using Serbian Latin comparison.
- Release handoff requires `npm run qa:release` and `git diff --check`; build failures are release blockers. Never commit secrets or revert unrelated work.

## Brand Commitments

The existing Event Zeka name and supplied Belgrade panorama are binding assets. The user approved the Space Grotesk identity and six-color dark palette recorded in DESIGN.md. Extend that approved system across public pages while preserving established Discover and Map interactions.

## Evidence on Hand

- `INSTRUCTIONS.md` records product intent, service boundaries, ingestion contracts, and release requirements.
- The implemented Next.js application, public route components, and existing Convex data flow are the product evidence.
- `.impeccable/review/` contains the current responsive Events, Discover, and Map review captures. Development-only browser indicators in captures are not product UI.
- Self-hosted Space Grotesk and Cyrillic fallback files, with their licenses, are in `public/fonts/`; the supplied panorama is in `public/images/`.
- The earlier HTML proposal is a separate review artifact. Its fixed snapshot dates and demo storage namespace are not production contracts.

## Product Principles

- Keep events connected to their actual source and date.
- Preserve honest distinctions between event times, venue hours, and inferred details.
- Make browsing, inspection, and saving work across the existing public routes.
- Keep established account, ingestion, moderation, and service behavior intact during visual changes.
- Base claims and content on existing evidence; do not invent audiences, events, or proof.
