/** Settle a new guide arrival without overriding subsequent visitor input. */
export function startInstallGuideLanding(heading: HTMLElement, surface: HTMLElement): () => void {
  const document = heading.ownerDocument;
  const view = document.defaultView;
  if (!view || (view.location.hash && view.location.hash !== "#install-guide-title")) return () => {};

  let stopped = false;
  let frame: number | null = null;
  let observer: ResizeObserver | undefined;
  let lastPosition: number | undefined;
  const inputEvents = ["wheel", "touchstart", "pointerdown", "keydown", "popstate"] as const;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (frame !== null) view!.cancelAnimationFrame(frame);
    view!.clearTimeout(timeout);
    observer?.disconnect();
    for (const event of inputEvents) view!.removeEventListener(event, stop, true);
    view!.removeEventListener("load", schedule);
    view!.removeEventListener("pageshow", pageShown);
    view!.removeEventListener("scroll", restoredScroll, true);
  }

  function position() {
    frame = null;
    if (stopped) return;
    if (!heading.isConnected || !surface.isConnected) {
      stop();
      return;
    }
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "start", behavior: "instant" });
    lastPosition = view!.scrollY;
  }

  function schedule() {
    if (stopped) return;
    if (frame !== null) view!.cancelAnimationFrame(frame);
    frame = view!.requestAnimationFrame(position);
  }

  function pageShown(event: PageTransitionEvent) {
    // Returning through BFCache should preserve the visitor's reading position.
    if (event.persisted) stop();
    else schedule();
  }

  function restoredScroll() {
    // Ignore our own resulting scroll, including fractional pixel rounding.
    if (lastPosition !== undefined && Math.abs(view!.scrollY - lastPosition) < 1) return;
    schedule();
  }

  for (const event of inputEvents) view.addEventListener(event, stop, { capture: true, passive: true });
  view.addEventListener("load", schedule);
  view.addEventListener("pageshow", pageShown);
  view.addEventListener("scroll", restoredScroll, { capture: true, passive: true });

  const ResizeObserverClass = (view as Window & typeof globalThis).ResizeObserver;
  if (ResizeObserverClass) {
    observer = new ResizeObserverClass(schedule);
    observer.observe(surface);
  }
  document.fonts?.ready?.then(schedule, () => {});
  const timeout = view.setTimeout(stop, 1500);
  // Next's parent layout handler may scroll after a child's layout effect.
  schedule();
  return stop;
}
