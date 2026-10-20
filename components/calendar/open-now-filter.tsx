"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

type OpenNowFilterProps = {
  active: boolean;
  href: string;
  initialNow: number;
  appearance?: "default" | "map";
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
        appearance === "map"
          ? cn("h-8 min-h-8 gap-1.5 bg-primary px-2.5 text-[11px] font-medium leading-none text-primary-foreground shadow-lg focus-visible:outline-primary", active
            ? "ring-2 ring-inset ring-primary-foreground/35"
            : "ring-1 ring-inset ring-primary-foreground/10")
          : cn("min-h-8 gap-1.5 px-2.5 text-[11px] font-medium focus-visible:outline-emerald-200", active
            ? "bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/35"
            : "bg-white/[0.045] text-muted-foreground hover:text-foreground"),
      )}
      data-calendar-open-now="true"
      data-calendar-open-now-active={active ? "true" : "false"}
      onClick={() => {
        startTransition(() => router.replace(href, { scroll: false }));
      }}
      type="button"
    >
      {appearance === "map"
        ? <span aria-hidden="true" className="inline-flex size-3 items-center justify-center">{active ? <Check className="size-3" /> : <span className="size-1.5 rounded-full bg-current" />}</span>
        : <span aria-hidden="true" className={cn("size-1.5 rounded-full", active ? "bg-emerald-300" : "bg-current opacity-50")} />}
      <span>Open now</span>
    </button>
  );
}
