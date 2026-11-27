import { findPositiveLocativeVenueHandleEvidence, normalizeHandle, toSearchableText } from "./normalization";

type SharedVenue = { applies_to_all?: unknown; source?: unknown; value?: unknown; evidence?: unknown };
type ProgrammeRow = { source_text?: unknown; venue?: unknown };

const physicalRoom = /\b(?:dvoran[aeiu]|galerij[aeiu]|sal[aeiu]|bioskop|pozoriste|hall|gallery|cinema|theatre|theater|stage|room)\b/u;
const dayHeading = /^(?:ponedeljak|utorak|sreda|cetvrtak|petak|subota|nedelja|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+\d/u;

/** A programme explicitly assigns this row to multiple rooms under one location pin. */
export function rowHasMultipleProgrammeRooms(caption: string, rowText: string): boolean {
  if (!caption.includes("📍") || !rowText.trim()) return false;
  const rowLine = rowText.split(/\r?\n/u)
    .filter(line => !line.includes("📍"))
    .map(toSearchableText)
    .find(line => line.length >= 6 && !dayHeading.test(line));
  if (!rowLine) return false;
  let multipleRooms = false;
  for (const rawLine of caption.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const comparable = toSearchableText(line);
    if (line.startsWith("📍")) {
      const rooms = toSearchableText(line.replace(/[&+/]/gu, " i "))
        .split(/\s+(?:i|and)\s+/u).filter(part => physicalRoom.test(part));
      multipleRooms = rooms.length > 1;
    } else if (dayHeading.test(comparable)) {
      multipleRooms = false;
    } else if (multipleRooms && comparable === rowLine) {
      return true;
    }
  }
  return false;
}

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
