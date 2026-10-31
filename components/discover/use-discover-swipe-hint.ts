"use client";

import { useEffect, useRef, type RefObject } from "react";

/** Demonstrate the swipe once per visit, yielding immediately to any input. */
export function useDiscoverSwipeHint(stage: RefObject<HTMLElement | null>, enabled: boolean) {
  const played = useRef(false);

  useEffect(() => {
    if (!enabled || played.current || !stage.current) return;
    const surface = stage.current;
    const card = surface.querySelector<HTMLElement>('[data-layer="0"]');
    if (!card) return;
    played.current = true;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches || document.visibilityState === "hidden") return;

    const animation = card.animate([
      { transform: "translateX(0) rotate(0deg)", offset: 0 },
      { transform: "translateX(-16px) rotate(-1.6deg)", offset: .3 },
      { transform: "translateX(14px) rotate(1.4deg)", offset: .68 },
      { transform: "translateX(0) rotate(0deg)", offset: 1 },
    ], { duration: 1000, delay: 450, easing: "ease-in-out" });
    const stop = () => animation.cancel();
    const visibility = () => { if (document.visibilityState === "hidden") stop(); };
    surface.addEventListener("pointerdown", stop, { capture: true, once: true });
    surface.addEventListener("keydown", stop, { capture: true, once: true });
    document.addEventListener("visibilitychange", visibility);
    motion.addEventListener("change", stop, { once: true });
    return () => {
      stop();
      surface.removeEventListener("pointerdown", stop, true);
      surface.removeEventListener("keydown", stop, true);
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", stop);
    };
  }, [enabled, stage]);
}
