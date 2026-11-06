"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { Download, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useEventsUi } from "@/components/calendar/events-ui-provider";
import {
  getInstallDayKey,
  INSTALL_PROMPT_STORAGE_KEY,
  INSTALL_PROMPT_VISIBLE_MS,
  isInstallPromptRoute,
  shouldShowInstallPrompt,
} from "@/lib/install/prompt-policy";
import styles from "./install-prompt.module.css";

function readLastShownDay(): string | null {
  try { return window.localStorage.getItem(INSTALL_PROMPT_STORAGE_KEY); }
  catch { return null; }
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function hasProtectedInteraction(): boolean {
  const focused = document.activeElement;
  return Boolean(
    (focused instanceof HTMLElement && (focused.isContentEditable
      || /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)))
    || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [data-calendar-event-preview-row][data-expanded="true"], [data-calendar-event-post]')
    || document.body.style.overflow === "hidden",
  );
}

export function InstallPrompt() {
  const pathname = usePathname();
  const { filtersOpen } = useEventsUi();
  const [isOpen, setIsOpen] = useState(false);
  const [bottomOffset, setBottomOffset] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const context = useRef({ pathname, filtersOpen });
  const prompt = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const dismiss = useCallback(() => {
    const hadFocus = prompt.current?.contains(document.activeElement);
    setIsOpen(false);
    setAnnouncement("");
    if (hadFocus && previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const timeout = window.setTimeout(dismiss, INSTALL_PROMPT_VISIBLE_MS);
    return () => window.clearTimeout(timeout);
  }, [isOpen, dismiss]);

  useLayoutEffect(() => {
    context.current = { pathname, filtersOpen };
    if (!isInstallPromptRoute(pathname) || filtersOpen) setIsOpen(false);
  }, [pathname, filtersOpen]);

  useEffect(() => {
    const entryDay = getInstallDayKey();
    let hasShown = readLastShownDay() === entryDay;
    if (hasShown || isStandalone()) return;

    let disposed = false;
    let activeMs = 0;
    let hasBrowsed = false;
    let pointerDown = false;
    let lastScrollAt = -Infinity;
    let lastTick = performance.now();
    let claimInFlight = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    function stopTimer() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    }

    function canShow(): boolean {
      return !disposed && shouldShowInstallPrompt({
        entryDay,
        currentDay: getInstallDayKey(),
        lastShownDay: readLastShownDay(),
        activeMs,
        hasBrowsed,
        isVisible: document.visibilityState === "visible",
        isBlocked: context.current.filtersOpen || hasProtectedInteraction()
          || pointerDown || performance.now() - lastScrollAt < 500,
        isStandalone: isStandalone(),
        hasShown,
        pathname: context.current.pathname,
      });
    }

    function reveal() {
      if (!canShow()) return;
      hasShown = true;
      // Record the impression, not dismissal, so a reload cannot repeat it today.
      try { window.localStorage.setItem(INSTALL_PROMPT_STORAGE_KEY, entryDay); }
      catch { /* The current document still remembers the display. */ }
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setIsOpen(true);
      setAnnouncement("Instaliraj EventZeka App. Predlog se zatvara za 10 sekundi. Uputstvo je uvek dostupno na stranici profila.");
      stopTimer();
    }

    async function claimDisplay() {
      if (claimInFlight || !canShow()) return;
      claimInFlight = true;
      try {
        // Serialize simultaneous tabs where supported; storage events cover fallback browsers.
        if (navigator.locks?.request) {
          await navigator.locks.request(INSTALL_PROMPT_STORAGE_KEY, { ifAvailable: true }, lock => {
            if (lock) reveal();
          });
        } else reveal();
      } catch {
        reveal();
      } finally {
        claimInFlight = false;
      }
    }

    function browse(event: Event) {
      hasBrowsed = true;
      if (event.type === "pointerdown") pointerDown = true;
      if (event.type === "scroll") lastScrollAt = performance.now();
    }
    function endPointer() { pointerDown = false; }
    function visibilityChanged() {
      lastTick = performance.now();
      if (document.visibilityState !== "visible") pointerDown = false;
    }
    function storageChanged(event: StorageEvent) {
      if (event.key !== INSTALL_PROMPT_STORAGE_KEY || event.newValue !== entryDay) return;
      hasShown = true;
      stopTimer();
      setIsOpen(false);
    }

    document.addEventListener("pointerdown", browse, { passive: true });
    document.addEventListener("keydown", browse, { passive: true });
    document.addEventListener("scroll", browse, { passive: true, capture: true });
    window.addEventListener("pointerup", endPointer, { passive: true });
    window.addEventListener("pointercancel", endPointer, { passive: true });
    window.addEventListener("blur", endPointer);
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("storage", storageChanged);
    timer = setInterval(() => {
      const now = performance.now();
      if (document.visibilityState === "visible" && isInstallPromptRoute(context.current.pathname)) {
        activeMs += Math.max(0, Math.min(now - lastTick, 1000));
      }
      lastTick = now;
      void claimDisplay();
    }, 250);

    return () => {
      disposed = true;
      stopTimer();
      document.removeEventListener("pointerdown", browse);
      document.removeEventListener("keydown", browse);
      document.removeEventListener("scroll", browse, true);
      window.removeEventListener("pointerup", endPointer);
      window.removeEventListener("pointercancel", endPointer);
      window.removeEventListener("blur", endPointer);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("storage", storageChanged);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const displayMode = window.matchMedia("(display-mode: standalone)");
    function hideWhenProtected() {
      if (isStandalone() || document.visibilityState !== "visible" || hasProtectedInteraction()) {
        setIsOpen(false);
        setAnnouncement("");
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") dismiss();
    }
    const observer = new MutationObserver(hideWhenProtected);
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["open", "aria-modal", "data-expanded", "style"],
    });
    document.addEventListener("focusin", hideWhenProtected);
    document.addEventListener("visibilitychange", hideWhenProtected);
    document.addEventListener("keydown", escape);
    displayMode.addEventListener("change", hideWhenProtected);
    hideWhenProtected();
    return () => {
      observer.disconnect();
      displayMode.removeEventListener("change", hideWhenProtected);
      document.removeEventListener("focusin", hideWhenProtected);
      document.removeEventListener("visibilitychange", hideWhenProtected);
      document.removeEventListener("keydown", escape);
    };
  }, [isOpen, dismiss]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const navigation = document.querySelector<HTMLElement>(".mobile-nav-shell");
    function measure() {
      const visible = navigation && navigation.getClientRects().length > 0;
      setBottomOffset(visible ? Math.max(16, window.innerHeight - navigation.getBoundingClientRect().top + 8) : 24);
    }
    measure();
    const observer = navigation ? new ResizeObserver(measure) : null;
    if (navigation) observer?.observe(navigation);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [isOpen]);

  const showPanel = isOpen && isInstallPromptRoute(pathname) && !filtersOpen;
  const position = {
    "--install-prompt-duration": `${INSTALL_PROMPT_VISIBLE_MS}ms`,
    ...(bottomOffset === null ? {} : { "--install-prompt-bottom": `${bottomOffset}px` }),
  } as CSSProperties;

  return (
    <>
      <span className="sr-only" lang="sr-Latn" role="status" aria-live="polite">{announcement}</span>
      {showPanel ? (
        <aside className={styles.prompt} style={position} ref={prompt} lang="sr-Latn" aria-labelledby="install-prompt-title" data-install-prompt>
          <button className={styles.close} type="button" onClick={dismiss} aria-label="Zatvori predlog za instalaciju" data-analytics="install-prompt-dismiss">
            <X aria-hidden="true" size={18} />
          </button>
          <div className={styles.intro}>
            <Image className={styles.icon} src="/event-zeka-icon-192.png" alt="" width={64} height={64} />
            <div className={styles.copy}>
              <h2 id="install-prompt-title" className={styles.title}>EventZeka <span>App</span></h2>
              <p className={styles.description}>App za događaje u Beogradu</p>
            </div>
          </div>
          <a className={styles.install} href="/install#install-guide-title" data-analytics="install-prompt-guide" onClick={dismiss}>
            Instaliraj EventZeka App <Download aria-hidden="true" size={19} />
          </a>
          <button className={styles.later} type="button" onClick={dismiss} data-analytics="install-prompt-later">Ne sada</button>
          <div aria-hidden="true" className={styles.countdown} data-install-countdown><span /></div>
        </aside>
      ) : null}
    </>
  );
}
