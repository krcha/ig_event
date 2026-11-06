import { getCalendarDateKeyInTimeZone } from "../events/nightlife-date";

export const INSTALL_PROMPT_STORAGE_KEY = "eventzeka.install.lastShownDay.v1";
export const INSTALL_PROMPT_DELAY_MS = 10_000;

const INSTALL_PROMPT_ROUTES = new Set(["/", "/events", "/calendar", "/discover"]);

export type InstallPromptState = {
  entryDay: string;
  currentDay: string;
  lastShownDay: string | null;
  activeMs: number;
  hasBrowsed: boolean;
  isVisible: boolean;
  isBlocked: boolean;
  isStandalone: boolean;
  hasShown: boolean;
  pathname: string | null;
};

export function getInstallDayKey(now: Date = new Date()): string {
  // Installation uses the calendar day, without the events' 07:00 rollover.
  return getCalendarDateKeyInTimeZone(now);
}

export function isInstallPromptRoute(pathname: string | null): boolean {
  return pathname !== null && INSTALL_PROMPT_ROUTES.has(pathname);
}

export function shouldShowInstallPrompt(state: InstallPromptState): boolean {
  return isInstallPromptRoute(state.pathname)
    && state.isVisible
    && !state.isBlocked
    && !state.isStandalone
    && !state.hasShown
    && state.hasBrowsed
    && Number.isFinite(state.activeMs)
    && state.activeMs >= INSTALL_PROMPT_DELAY_MS
    && state.currentDay === state.entryDay
    && state.lastShownDay !== state.entryDay;
}
