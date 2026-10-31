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

    const timing = { duration: 2000, delay: 450, easing: "ease-in-out" };
    const animations = [card.animate([
      { transform: "translateX(0) rotate(0deg)", offset: 0 },
      { transform: "translateX(-20px) rotate(-2deg)", offset: .3 },
      { transform: "translateX(18px) rotate(1.8deg)", offset: .68 },
      { transform: "translateX(0) rotate(0deg)", offset: 1 },
    ], timing)];
    for (const [decision, start, peak, end] of [
      ["skip", .08, .3, .48],
      ["like", .48, .68, .92],
    ] as const) {
      const stamp = card.querySelector<HTMLElement>(`[data-stamp="${decision}"]`);
      if (stamp) animations.push(stamp.animate([
        { opacity: 0, offset: 0 },
        { opacity: 0, offset: start },
        { opacity: .4, offset: peak },
        { opacity: 0, offset: end },
        { opacity: 0, offset: 1 },
      ], timing));
    }
    const stop = () => animations.forEach(animation => animation.cancel());
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
