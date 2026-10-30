import { isPlausibleConvexPublicId } from "../convex/public-id";
import { getEventPrimaryCategory, normalizeEventCategoryKey, type EventCategoryInput, type EventPrimaryCategory } from "../taxonomy/event-categories";

export type DiscoverScope = "all" | EventPrimaryCategory;
export type DiscoverChoice = {
  eventId: string;
  category: EventPrimaryCategory;
  decision: "like" | "skip";
};
export type DiscoverDayChoices = { choices: DiscoverChoice[]; completedScopes: DiscoverScope[]; acknowledgedIds?: string[] };
export type DiscoverSessions = Record<string, DiscoverDayChoices>;
export const DISCOVER_SESSION_KEY = "eventzeka-discover-choices-v1";
export const DISCOVER_SCOPES: readonly DiscoverScope[] = ["all", "club", "live", "culture", "event"];
const emptyDay = (): DiscoverDayChoices => ({ choices: [], completedScopes: [] });

export function getDiscoverCategory(event: Partial<EventCategoryInput> & {primaryCategory?:string}): EventPrimaryCategory {
  return normalizeEventCategoryKey(event.primaryCategory) ?? getEventPrimaryCategory({...event,eventType:event.eventType ?? "event"});
}

export function readDiscoverSessions(raw: string | null): DiscoverSessions {
  if (!raw || raw.length > 1_000_000) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: DiscoverSessions = {};
    for (const [date, day] of Object.entries(value).slice(-32)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day || typeof day !== "object") continue;
      const record = day as { choices?: unknown; completedScopes?: unknown };
      if (!Array.isArray(record.choices)) continue;
      const seen = new Set<string>();
      const choices: DiscoverChoice[] = [];
      for (const item of record.choices.slice(-500)) {
        if (!item || typeof item !== "object" || typeof item.eventId !== "string" || !isPlausibleConvexPublicId(item.eventId) || seen.has(item.eventId) || !["like", "skip"].includes(item.decision) || !DISCOVER_SCOPES.slice(1).includes(item.category)) continue;
        seen.add(item.eventId);
        choices.push({eventId:item.eventId, category:item.category, decision:item.decision});
      }
      const scopes = record.completedScopes;
      const completedScopes = Array.isArray(scopes)
        ? DISCOVER_SCOPES.filter(scope => scopes.includes(scope)) : [];
      const acknowledged = (day as {acknowledgedIds?:unknown}).acknowledgedIds;
      const acknowledgedIds = Array.isArray(acknowledged) ? [...new Set(acknowledged.filter((id):id is string=>typeof id === "string" && isPlausibleConvexPublicId(id)))].slice(-500) : [];
      result[date] = {choices, completedScopes, ...(acknowledgedIds.length ? {acknowledgedIds} : {})};
    }
    return result;
  } catch { return {}; }
}

export function choicesForScope(day: DiscoverDayChoices | undefined, scope: DiscoverScope): DiscoverChoice[] {
  return (day?.choices ?? []).filter(choice => scope === "all" || choice.category === scope);
}

export function recordDiscoverChoice(day: DiscoverDayChoices | undefined, choice: DiscoverChoice): DiscoverDayChoices {
  const current = day ?? emptyDay();
  return {...current, choices:[...current.choices.filter(item => item.eventId !== choice.eventId), choice], ...(current.acknowledgedIds ? {acknowledgedIds:current.acknowledgedIds.filter(id=>choice.decision !== "like" || id !== choice.eventId)} : {})};
}

export function markDiscoverCompletion(day: DiscoverDayChoices, scope: DiscoverScope, scopeIds: readonly string[]): DiscoverDayChoices {
  const seen = new Set(day.choices.map(choice=>choice.eventId));
  if (!scopeIds.length || !scopeIds.every(id=>seen.has(id))) return day;
  return {...day,completedScopes:[...new Set([...day.completedScopes,scope])]};
}

export function undoDiscoverChoice(day: DiscoverDayChoices | undefined, scope: DiscoverScope): DiscoverDayChoices {
  const current = day ?? emptyDay();
  const last = choicesForScope(current, scope).at(-1);
  if (!last) return current;
  return {
    ...current,
    choices:current.choices.filter(choice => choice.eventId !== last.eventId),
    completedScopes:current.completedScopes.filter(value => value !== "all" && value !== last.category),
  };
}

export function restartDiscoverScope(day: DiscoverDayChoices | undefined, scope: DiscoverScope): DiscoverDayChoices {
  const current = day ?? emptyDay();
  return {
    ...current,
    choices:current.choices.filter(choice => scope !== "all" && choice.category !== scope),
    completedScopes:current.completedScopes.filter(value => scope !== "all" && value !== "all" && value !== scope),
  };
}

export function completedDiscoverLikes(sessions: DiscoverSessions): string[] {
  return [...new Set(Object.values(sessions).filter(day => day.completedScopes.length > 0)
    .flatMap(day => day.choices.filter(choice => choice.decision === "like").map(choice => choice.eventId)))];
}

export function discoverLikedIds(sessions: DiscoverSessions): string[] {
  return [...new Set(Object.values(sessions).flatMap(day=>day.choices.filter(choice=>choice.decision === "like").map(choice=>choice.eventId)))];
}

export function pendingDiscoverSaveIds(sessions: DiscoverSessions, confirmed: ReadonlySet<string>, attempted: ReadonlySet<string>): string[] {
  const acknowledged = new Set(Object.values(sessions).flatMap(day=>day.acknowledgedIds ?? []));
  return discoverLikedIds(sessions).filter(id=>!acknowledged.has(id) && !confirmed.has(id) && !attempted.has(id));
}

export function getDiscoverGestureAction({x,y,velocity,width,maxDistance,dragging,photo,cancelled=false}: {
  x:number; y:number; velocity:number; width:number; maxDistance:number; dragging:boolean; photo:boolean; cancelled?:boolean;
}): "like" | "skip" | "open" | "cancel" {
  if(cancelled)return "cancel";
  if(Math.abs(y)>16 && Math.abs(y)>Math.abs(x)*1.25)return "cancel";
  if(Math.abs(x)>Math.max(70,width*.23) || (Math.abs(velocity)>.55 && Math.abs(x)>28))return x>0?"like":"skip";
  if(photo && !dragging && maxDistance<=7 && Math.hypot(x,y)<=7)return "open";
  return "cancel";
}

export function discoverSessionStorageKey(userId:string|null):string {
  return `${DISCOVER_SESSION_KEY}:${userId || "guest"}`;
}

export function mergeGuestDiscoverSessions(account:DiscoverSessions,guest:DiscoverSessions):DiscoverSessions {
  const merged = {...account};
  for (const [date,day] of Object.entries(guest)) {
    const own = merged[date], guestIds = new Set(day.choices.map(choice=>choice.eventId));
    merged[date] = {choices:[...(own?.choices ?? []).filter(choice=>!guestIds.has(choice.eventId)),...day.choices],completedScopes:[...new Set([...(own?.completedScopes ?? []),...day.completedScopes])],acknowledgedIds:(own?.acknowledgedIds ?? []).filter(id=>!guestIds.has(id))};
  }
  return merged;
}

export function acknowledgeDiscoverSaves(sessions:DiscoverSessions,eventIds:readonly string[]):DiscoverSessions {
  const confirmed = new Set(eventIds);
  return Object.fromEntries(Object.entries(sessions).map(([date,day])=>[date,{
    ...day,acknowledgedIds:[...new Set([...(day.acknowledgedIds ?? []),...day.choices.filter(choice=>choice.decision === "like" && confirmed.has(choice.eventId)).map(choice=>choice.eventId)])],
  }]));
}
