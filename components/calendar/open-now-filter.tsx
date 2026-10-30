"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { Check, Clock3, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type OpenNowFilterProps = {
  active: boolean;
  href: string;
  initialNow: number;
  appearance?: "default" | "map" | "chip";
};

export function OpenNowFilter({ active, href, appearance = "default" }: OpenNowFilterProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!active) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout>;
    let stopped = false;

    const updateClock = (refreshResults: boolean) => {
      const currentNow = Date.now();
      if (refreshResults && document.visibilityState !== "hidden") {
        startTransition(() => router.refresh());
      }
      clearTimeout(timeout);
      if (!stopped) {
        timeout = setTimeout(() => updateClock(true), 60_000 - (currentNow % 60_000) + 25);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        updateClock(true);
      }
    };

    updateClock(false);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopped = true;
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, router]);

  return (
    <button
      aria-busy={pending}
      aria-label="Open now"
      aria-pressed={active}
      className={cn(
        "inline-flex flex-none items-center whitespace-nowrap rounded-full transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4",
        appearance === "chip"
          ? cn("h-9 min-h-9 gap-1.5 border px-2.5 text-xs font-semibold leading-none", active
            ? "border-[#082C1B]/20 bg-[#7DD3A8] text-[#082C1B] focus-visible:outline-[#7DD3A8]"
            : "border-input bg-card text-foreground hover:border-primary/35 focus-visible:outline-primary")
          : appearance === "map"
          ? cn("h-8 min-h-8 gap-1.5 px-2.5 text-[11px] font-medium leading-none shadow-lg", active
            ? "bg-[#7DD3A8] text-[#082C1B] ring-2 ring-inset ring-[#082C1B]/20 focus-visible:outline-[#7DD3A8]"
            : "bg-primary text-primary-foreground ring-1 ring-inset ring-primary-foreground/10 focus-visible:outline-primary")
          : cn("min-h-11 gap-2 px-3.5 text-xs font-semibold leading-none shadow-[0_4px_16px_-7px_rgba(139,134,251,0.8)]", active
            ? "bg-[#7DD3A8] text-[#082C1B] ring-2 ring-inset ring-[#082C1B]/20 shadow-[0_4px_16px_-7px_rgba(125,211,168,0.7)] focus-visible:outline-[#7DD3A8]"
            : "bg-primary text-primary-foreground ring-1 ring-inset ring-primary-foreground/15 focus-visible:outline-primary"),
        pending && "cursor-wait",
      )}
      data-calendar-open-now="true"
      data-calendar-open-now-active={active ? "true" : "false"}
      onClick={() => {
        let targetHref = href;
        if (appearance === "chip") {
          const target = new URL(href, window.location.origin);
          const current = new URL(window.location.href);
          for (const key of ["hide", "q", "venue", "sort"]) {
            const value = current.searchParams.get(key);
            if (value) target.searchParams.set(key, value);
            else target.searchParams.delete(key);
          }
          targetHref = `${target.pathname}${target.search}`;
        }
        startTransition(() => router.replace(targetHref, { scroll: false }));
      }}
      type="button"
    >
      <span aria-hidden="true" className={cn("inline-flex flex-none items-center justify-center", appearance === "default" ? "size-4" : "size-3")}>
        {pending ? (
          <Loader2 className="size-full animate-spin motion-reduce:animate-none" />
        ) : active ? (
          <Check className="size-full" />
        ) : appearance === "map" ? (
          <span className="size-1.5 rounded-full bg-current" />
        ) : (
          <Clock3 className="size-full" />
        )}
      </span>
      <span>Open now</span>
    </button>
  );
}
