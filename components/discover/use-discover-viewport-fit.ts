"use client";

import { useLayoutEffect, type RefObject } from "react";

/** Fit from a stable document baseline, including chrome mounted after streaming. */
export function useDiscoverViewportFit(stage: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const surface = stage.current;
    if (!enabled || !surface) return;
    let disposed = false;
    let frame: number | null = null;
    let settlingFrames = 2;
    const observed = new Set<Element>();
    const resize = new ResizeObserver(schedule);

    function fit() {
      if (disposed || !surface) return;
      const main = surface.closest("main");
      const toolbar = document.querySelector<HTMLElement>(".mobile-topbar");
      const navigation = document.querySelector<HTMLElement>(".mobile-nav-shell");
      const controls = main ? [...main.children].filter(element => !element.contains(surface)) : [];
      for (const element of [toolbar, navigation, ...controls]) {
        if (element && !observed.has(element)) { resize.observe(element); observed.add(element); }
      }
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      // A streamed toolbar can exist with a zero-size box before hydration.
      // Its top coordinate is not a usable lower boundary at that point.
      const measuredNavigationHeight = navigation?.getBoundingClientRect().height ?? 0;
      const navigationHeight = measuredNavigationHeight > 0 ? measuredNavigationHeight : 88;
      const documentTop = surface.getBoundingClientRect().top + window.scrollY;
      const height = `${Math.max(240, Math.floor(viewportHeight - navigationHeight - documentTop - 18))}px`;
      if (surface.style.getPropertyValue("--discover-stage-height") !== height) {
        surface.style.setProperty("--discover-stage-height", height);
      }
    }
    function schedule() {
      if (disposed || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        fit();
        if (settlingFrames-- > 0) schedule();
      });
    }

    fit();
    schedule();
    // Header/nav can arrive in a later streamed Suspense boundary. Rebind the
    // size observer when nodes mount; their position can change without resizing.
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    document.fonts?.ready.then(schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    document.addEventListener("load", schedule, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
      document.removeEventListener("load", schedule, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [enabled, stage]);
}
