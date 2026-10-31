"use client";

import { useEffect, type RefObject } from "react";
import { discoverPhotoSnapTarget } from "@/lib/discover/photo-scroll-snap";

/** The first downward scroll aligns the photo; scrolling upward releases it. */
export function useDiscoverPhotoSnap(photo: RefObject<HTMLElement | null>, enabled: boolean, rootClass: string) {
  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    let previousY = window.scrollY, snapped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { clearTimeout(timer); root.classList.remove(rootClass); };
    const scroll = () => {
      const currentY = window.scrollY, beforeY = previousY;
      previousY = currentY;
      clearTimeout(timer);
      if (currentY < beforeY || currentY <= 0) { cancel(); snapped = false; return; }
      if (snapped || !photo.current || currentY <= beforeY) return;
      const target = discoverPhotoSnapTarget(beforeY, photo.current.getBoundingClientRect().top + currentY-beforeY, 1);
      // Crossing the header, including a touch flick, stops first at the photo.
      if (target !== null) timer = setTimeout(() => {
        snapped = true;
        root.classList.add(rootClass);
        const instant = window.scrollY > target || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: target, behavior: instant ? "instant" : "smooth" });
      }, 110);
    };
    window.addEventListener("scroll", scroll, { passive: true });
    return () => { cancel(); window.removeEventListener("scroll", scroll); };
  }, [enabled, photo, rootClass]);
}
