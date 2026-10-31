# Admin analytics surface

Mode: Operate. Route: `/admin/analytics`.

This extends the existing Event Zeka admin panel. Its dark canvas, violet primary
colour, sans-serif typography, admin tabs, spacing, and existing navigation are
the visual authority. The supplied frame.baby screenshot specifies the analytics
content and reading order: summary, activity, historical traffic, geography,
devices, sources, and click performance. No global design system is replaced.

## Direction contract

THESIS: Make the owner's traffic readable in one pass, with exact date controls,
distinct visitor counts, and visibly separate live and historical periods.

OWN-WORLD: Use the existing near-black canvas and card surfaces, violet for page
views, cyan for clicks, quiet one-pixel borders, and compact tabular numerals.
The reference's analytics structure inherits Event Zeka's established theme.

STORY: The owner chooses dates, reads totals and the trend, identifies countries,
devices, and acquisition sources, then exports aggregate statistics if needed.
Loading, zero visits, missing country data, errors, and retry are explicit.

FIRST VIEWPORT: Existing admin heading and navigation, date presets and custom
dates, four summary columns, last-hour activity, and the start of the selected
period's chart. Mobile keeps two summary columns and stacks supporting sections.
Historical charts and the map expose counts on hover/focus; keyboard arrows
inspect chart points without adding hundreds of tab stops.

FORM: The user's screenshot fixes the analytics composition. This is a code-first
extension of an established admin surface, with no concept tournament or new
identity. Seed: none (specified extension).

FINISH: Review rendered desktop/mobile, populated/empty/error states, date and
grouping controls, CSV, owner access, backend collection/reporting, and the
repository's complete release gate. Preserve the incumbent design system.
