import { findPositiveLocativeVenueHandleEvidence, normalizeHandle } from "./normalization";

type SharedVenue = { applies_to_all?: unknown; source?: unknown; value?: unknown; evidence?: unknown };
type ProgrammeRow = { source_text?: unknown; venue?: unknown };

export function programmeWithdrawnOrMoved(text: string) {
  return /(?:cancel(?:led|ed|lation)|postponed|rescheduled|relocated|moved to|otkaz[au]|odlo[žz]|pomeren|preme[šs]ten|nov[ao] lokacij|promena lokacij|gostujemo|отказ[ау]|одлож|померен|премештен|гостујемо)/iu.test(text);
}

/** A single shared venue for a promoter's separately named, dated caption rows. */
export function hasSharedCaptionVenue(options: {
  caption: string; handle: string; venue: string; shared: SharedVenue | null; rows: readonly (ProgrammeRow | null)[];
}) {
  const { caption, handle, venue, shared, rows } = options;
  if (!venue || !handle || programmeWithdrawnOrMoved(caption) || shared?.applies_to_all !== true || shared.source !== "caption" ||
      shared.value !== venue || typeof shared.evidence !== "string" || !shared.evidence.trim() ||
      rows.length < 2 || rows.length > 64 || !rows.every(row => row?.venue === venue && typeof row.source_text === "string" &&
        row.source_text.trim() && caption.includes(row.source_text))) return false;
  const quote = shared.evidence.trim();
  const lines = caption.split(/\r?\n/u).map(line => line.trim()).filter(line => line && !/^(?:#[\p{L}\p{N}_]+\s*)+$/u.test(line));
  const footer = lines.at(-1) ?? "";
  if ((footer !== quote && !(footer.startsWith(quote) && /^[\s.!\p{Extended_Pictographic}\uFE0F]+$/u.test(footer.slice(quote.length)))) ||
      /📍|@|(?<![\p{L}\p{N}])(?:venue|location|adresa|lokacija|kod|at|vidimo se|u|na|in)(?![\p{L}\p{N}])/iu.test(lines.slice(0, -1).join("\n"))) return false;
  const handles = [...footer.matchAll(/@([a-z0-9_.]+)/giu)];
  return handles.length === 1 && normalizeHandle(handles[0]![1]!.replace(/\.+$/u, "")) === handle &&
    Boolean(findPositiveLocativeVenueHandleEvidence({ evidenceText: footer, handle, venueNames: [venue] }));
}
