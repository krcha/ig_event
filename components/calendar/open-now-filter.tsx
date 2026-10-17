"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { cn } from "@/lib/utils";

type OpenNowFilterProps = {
  active: boolean;
  href: string;
  initialNow: number;
};

export function OpenNowFilter({ active, href }: OpenNowFilterProps) {
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
        "inline-flex min-h-8 flex-none items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition hover:opacity-90",
        active
          ? "bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/35"
          : "bg-white/[0.045] text-muted-foreground hover:text-foreground",
      )}
      data-calendar-open-now="true"
      data-calendar-open-now-active={active ? "true" : "false"}
      onClick={() => {
        startTransition(() => router.replace(href, { scroll: false }));
      }}
      type="button"
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", active ? "bg-emerald-300" : "bg-current opacity-50")} />
      <span>Open now</span>
    </button>
  );
}
