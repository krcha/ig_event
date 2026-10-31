import type { SetSavedEventResult } from "./saved-events-client";

export const GUEST_SAVED_EVENT_PREFIX = "eventzeka:guest-saved:v1:";
export const MAX_GUEST_SAVED_EVENTS = 500;

export type GuestSavedEvent = {
  _id: string;
  title: string;
  date: string;
  venue: string;
  eventType: string;
  time?: string;
  venueId?: string;
  ticketPrice?: string;
  displayTimeLabel?: string;
  displayTimeStart?: string;
  displayTimeEnd?: string;
  displayTimeSource?: string;
};

export type GuestSavedRecord = {
  version: 1;
  event: GuestSavedEvent;
  revision: string;
  ownerId?: string;
};
export type GuestSavedStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const validId = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);

/** Keep only public card fields. Never persist account libraries or source evidence. */
export function guestEventSnapshot(value: unknown): GuestSavedEvent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row._id !== "string" || !validId(row._id) ||
    typeof row.title !== "string" || !row.title.trim() ||
    typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
    typeof row.venue !== "string") return null;
  const event: GuestSavedEvent = {
    _id: row._id, title: row.title.slice(0, 500), date: row.date,
    venue: row.venue.slice(0, 300),
    eventType: String(row.eventType ?? row.primaryCategory ?? "event").slice(0, 100),
  };
  for (const field of ["time", "venueId", "ticketPrice", "displayTimeLabel", "displayTimeStart", "displayTimeEnd", "displayTimeSource"] as const) {
    const content = row[field];
    if (typeof content === "string") event[field] = content.slice(0, 300);
  }
  if (!event.displayTimeLabel && typeof row.timeLabel === "string") event.displayTimeLabel = row.timeLabel.slice(0, 300);
  if (row.timeStatus === "unknown") {
    delete event.time; delete event.displayTimeStart; delete event.displayTimeEnd;
  }
  return event;
}

function readRecord(storage: GuestSavedStorage, eventId: string): GuestSavedRecord | null {
  const raw = storage.getItem(GUEST_SAVED_EVENT_PREFIX + eventId);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const event = guestEventSnapshot(value?.event);
    if (value?.version !== 1 || !event || event._id !== eventId || typeof value.revision !== "string" ||
      (value.ownerId !== undefined && typeof value.ownerId !== "string")) return null;
    return { version: 1, event, revision: value.revision, ...(value.ownerId ? { ownerId: value.ownerId } : {}) };
  } catch { return null; }
}

export function readGuestSavedEvents(storage: GuestSavedStorage, ownerId: string | null = null): GuestSavedRecord[] {
  const records: GuestSavedRecord[] = [];
  for (let i = 0; i < storage.length && records.length < MAX_GUEST_SAVED_EVENTS; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(GUEST_SAVED_EVENT_PREFIX)) continue;
    const record = readRecord(storage, key.slice(GUEST_SAVED_EVENT_PREFIX.length));
    if (record && (!record.ownerId || record.ownerId === ownerId)) records.push(record);
  }
  return records;
}

export function writeGuestSavedEvent(storage: GuestSavedStorage, eventId: string, saved: boolean, value?: unknown): GuestSavedEvent | null {
  if (!validId(eventId)) throw new Error("This event could not be saved.");
  if (!saved) { storage.removeItem(GUEST_SAVED_EVENT_PREFIX + eventId); return null; }
  const event = guestEventSnapshot(value);
  if (!event || event._id !== eventId) throw new Error("Open this event and try saving it again.");
  if (!storage.getItem(GUEST_SAVED_EVENT_PREFIX + eventId) && readGuestSavedEvents(storage).length >= MAX_GUEST_SAVED_EVENTS) {
    throw new Error("Saved is full on this device. Remove an event and try again.");
  }
  // One key per event prevents simultaneous tabs from overwriting unrelated saves.
  const record: GuestSavedRecord = { version: 1, event, revision: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}` };
  storage.setItem(GUEST_SAVED_EVENT_PREFIX + eventId, JSON.stringify(record));
  return event;
}

export function removeGuestSavedEventForOwner(storage: GuestSavedStorage, eventId: string, ownerId: string) {
  const record = readRecord(storage, eventId);
  if (record && (!record.ownerId || record.ownerId === ownerId)) storage.removeItem(GUEST_SAVED_EVENT_PREFIX + eventId);
}

/** Idempotent additive import; keep failed/newer entries and fence account switches. */
export async function syncGuestSavedEvents(
  storage: GuestSavedStorage,
  ownerId: string,
  save: (eventId: string) => Promise<SetSavedEventResult>,
  isCurrentOwner: () => boolean,
  shouldSync: (eventId: string) => boolean = () => true,
): Promise<{ failedEventIds: string[]; savedEventIds: string[] }> {
  const records = readGuestSavedEvents(storage, ownerId);
  const savedEventIds: string[] = [], failedEventIds: string[] = [];
  let cursor = 0;
  async function next() {
    while (cursor < records.length && isCurrentOwner()) {
      const record = records[cursor++];
      const id = record.event._id;
      try {
        if (!shouldSync(id)) continue;
        const latest = readRecord(storage, id);
        if (!latest || latest.revision !== record.revision || (latest.ownerId && latest.ownerId !== ownerId)) continue;
        // Failed imports remain bound to this account, never the next person to log in.
        storage.setItem(GUEST_SAVED_EVENT_PREFIX + id, JSON.stringify({ ...latest, ownerId }));
        if (!isCurrentOwner()) break;
        const result = await save(id);
        if (!isCurrentOwner()) break;
        if (result.success && result.saved === true) {
          const current = readRecord(storage, id);
          if (current?.revision === record.revision && current.ownerId === ownerId) storage.removeItem(GUEST_SAVED_EVENT_PREFIX + id);
          savedEventIds.push(id);
        } else failedEventIds.push(id);
      } catch { failedEventIds.push(id); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, records.length) }, next));
  return { failedEventIds, savedEventIds };
}
