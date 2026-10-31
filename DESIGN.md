---
name: Event Zeka
description: The approved dark public interface for browsing Belgrade events.
colors:
  primary: "#D5F56B"
  primary-hover: "#C9EB58"
  detail: "#A99BFF"
  background: "#10141F"
  card: "#1B2233"
  raised: "#242D43"
  foreground: "#F4F2EB"
  muted-foreground: "#A8B0C2"
  border: "#34405A"
  input: "#667797"
  category-club: "#A99BFF"
  category-live: "#FF80A1"
  category-culture: "#F6C94C"
  category-event: "#7AD6B0"
typography:
  display:
    fontFamily: '"Space Grotesk", "Event Zeka Cyrillic", sans-serif'
    fontSize: "48px"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  section:
    fontFamily: '"Space Grotesk", "Event Zeka Cyrillic", sans-serif'
    fontSize: "23px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  event-title:
    fontFamily: '"Space Grotesk", "Event Zeka Cyrillic", sans-serif'
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  body:
    fontFamily: '"Space Grotesk", "Event Zeka Cyrillic", sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: '"Space Grotesk", "Event Zeka Cyrillic", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: '"Space Grotesk", "Event Zeka Cyrillic", sans-serif'
    fontSize: "13px"
    fontWeight: 500
rounded:
  base: "0.78rem"
  time: "10px"
  compact-control: "11px"
  control: "12px"
  card: "14px"
  panel: "16px"
  month-dialog: "20px"
  pill: "9999px"
spacing:
  tight: "4px"
  related: "8px"
  control-gap: "10px"
  compact: "12px"
  row: "14px"
  panel: "16px"
  gutter: "24px"
  wide-gutter: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.background}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    textColor: "{colors.foreground}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
  events-search:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "0px 13px"
    height: "48px"
  selected-day:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.background}"
    rounded: "{rounded.control}"
    height: "58px"
  navigation:
    backgroundColor: "{colors.background}"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.panel}"
    padding: "4px 12px"
    height: "50px"
  event-row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.card}"
    padding: "14px"
  inline-post:
    backgroundColor: "{colors.background}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.caption}"
    padding: "12px"
---

# Design System: Event Zeka

## Overview

The public interface uses the user's approved dark palette, Space Grotesk, and supplied Belgrade panorama. Events is compact and organized around choosing a date, narrowing the results, inspecting the original post, and saving an event. Lime marks selection and primary action; lavender supports detail and focus.

Discover keeps its established desktop poster gallery and mobile swipe workflow. Map keeps its existing controls, pins, pan, zoom, and venue rail. Their geometry and interactions remain authoritative while the shared theme and font extend across the public site. This records the implemented application; the earlier standalone HTML proposal is a separate artifact.

**Key Characteristics:**

- Compact navigation, heading, and date strip.
- Dark tonal surfaces with distinct decorative and interactive boundaries.
- Original event imagery and source context.
- Established public browsing, post expansion, and save behavior.

## Colors

The frontmatter is normative. Its identity colors come directly from the approved brief; supplemental surface and boundary colors come from the implementation.

### Primary

Lime `primary` is used for selected dates, primary buttons, active navigation markers, and saved states. Filled lime controls use `background` as their dark foreground. `primary-hover` is the existing primary-button hover state.

### Secondary

Lavender `detail` carries focus, expanded event boundaries, session details, and secondary emphasis. The CSS token `--accent` is the raised dark surface, not lime; use `--primary` for the primary action color.

### Neutral

`background` is the canvas and inset time surface; `card` is the shared control and content surface; `raised` is the focused event-row surface. `foreground` is primary text and `muted-foreground` is supporting copy and placeholders. `border` separates content, while `input` defines stronger interactive edges.

Events retains labelled semantic dots: lavender for club nights, rose for live music, gold for culture, and mint for other events. Existing category badges elsewhere retain their semantic behavior.

**The Boundary Rule.** Keep `input` for Events control boundaries and `border` for decorative grouping; do not collapse the two roles.

## Typography

Space Grotesk is self-hosted in weights 400, 500, 600, and 700. The Event Zeka Cyrillic fallback covers U+0400-04FF. Keep the font files and their licenses in `public/fonts/`; the layout preloads the regular and bold faces.

The frontmatter records the desktop hierarchy. Below 768px the Events heading uses `clamp(31px, 9.6vw, 40px)` and becomes 31px at 350px and below. Section headings become 20px; event titles become 15px and then 14px on the narrowest layout. Search text remains 16px. Time blocks and calendar dates use tabular numerals. Source captions wrap long text without losing their original content.

## Layout

Shared navigation is 46px on mobile and 50px on desktop. The Events heading is 124px on mobile and 150px on desktop; the date strip overlaps its bottom by 16px and 20px respectively. Date buttons are 54px and 58px. The supplied panorama remains behind the heading with its implemented masking and opacity.

Events uses a centered 1240px maximum width, desktop side gutters of 32px, mobile gutters of 16px, and narrow-screen gutters of 12px. Search and disclosure controls are 46px on mobile and 48px on desktop. Expanded filters contain exactly two equal-width controls: Open now and sorting. Venue names are part of the main search; there is no separate venue field.

Category tabs follow the toolbar and remain sticky. Event content has a 244px overview rail and 30px gap above 1100px; below that it uses one column. Event headers are at least 94px high on desktop and 104px on mobile. Time blocks, save actions, and chevrons retain separate space. Mobile bottom navigation clearance includes the safe area.

Preserve Discover's four-column desktop gallery and existing mobile swipe geometry. Preserve Map's current responsive rail, control locations, date controls, attribution, and lower-right zoom. Review captures at 320px, 390px, 768px, and 1440px are evidence of the responsive Events composition, not fixed data or content requirements.

## Elevation & Depth

Public hero and glass panels now use the solid card surface with no shadow or backdrop blur. Tonal layering, borders, and the raised event focus state provide hierarchy. Keep poster overlays and the original local treatments where they serve their existing controls.

The month dialog retains its `0 24px 90px rgb(0 0 0 / .6)` shadow and blurred backdrop. Map pins retain `0 4px 14px #0008`; map zoom controls retain their local shadow. Events heading text uses `0 2px 12px var(--background)` over the panorama. Global keyboard focus is a 2px lavender outline with 3px offset; Events search uses a 2px lavender outline with 2px offset. Existing component-specific primary focus outlines remain intact.

## Shapes

Events controls use the control radius and compact mobile variant. Event rows use the card radius, navigation uses softly rounded panels, and time blocks use smaller inset corners. Shared secondary actions retain pill shapes. Discover, map markers, calendar dialogs, and existing source-post controls retain their own established shapes rather than being normalized into Events cards.

## Components

### Navigation and controls

The desktop navigation centers its public links inside the compact outlined panel and uses a lime active underline. Mobile retains the compact brand/profile header and fixed bottom navigation. Selected mobile links use lime with a small marker. Development-only Next.js indicators visible in review captures are not product components.

Search and filter disclosure sit on one row. The disclosure reports `aria-expanded`, controls the two-column panel, and shows an indicator when Open now or a non-default sort is active. The preserved search helper matches event titles, artist names, and venue aliases; it auto-applies after a 300ms debounce. The existing placeholder also mentions genre, without adding a new search field. Preserve the shared date, category, search, Open now, and sorting URL behavior.

### Events sorting and rows

The four sort values are `time`, `late`, `title`, and `venue`, labelled Po vremenu, Kasnije prvo, Po nazivu, and Po imenu mesta. Title and venue sorts use one alphabetical result section. The complete matching set is sorted stably with `sr-Latn` comparison before virtualization; sort order must not depend on which rows are currently rendered.

Rows preserve their time block, title, linked venue, category dot, session and event metadata, Save button, and expand control. Expanded rows use a lavender boundary. Category labels and accessible states supplement color. Open now indicates venue operating hours and never confirms that a programme has begun.

### Original post and Save

Keep the existing inline Instagram accordion, original image/caption fetching, loading and failure states, caption expansion, source link, event-detail link, explicit close, Escape behavior, focus return, and scroll anchoring. Image and caption are side by side on desktop and stacked on mobile. Save remains a separate action; keep the existing guest-local persistence and sign-in synchronization behavior.

### Discover and Map

Apply the shared palette and font while preserving Discover's poster actions, swipe/save/skip/undo/details behavior, and existing motion preferences. Preserve Map's date and Open now filters, location controls, venue pins, popups, pan, zoom, directions, and links to venue/event details. Do not import the old HTML proposal's snapshot dates or demo storage namespace into application contracts.

## Do's and Don'ts

### Do:

- **Do** use the approved palette, self-hosted fonts, and supplied panorama.
- **Do** preserve the compact Events dimensions and equal-width expanded controls.
- **Do** sort the complete result set before virtualization, including venue-name sorting.
- **Do** preserve original post context, time uncertainty, Save, and account synchronization.
- **Do** preserve Discover and Map interactions when changing their theme.

### Don't:

- **Don't** add the prototype's separate venue filter to the implemented Events toolbar.
- **Don't** substitute `--accent` for the lime `--primary` token.
- **Don't** equate venue hours or Open now with a confirmed event start.
- **Don't** treat development indicators or review snapshot dates as product requirements.
- **Don't** replace authentication, data, ingestion, or moderation behavior during visual work.
