import { cn } from "@/lib/utils";

export function EventZekaMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("shrink-0", className)}
      fill="none"
      viewBox="0 0 48 48"
    >
      <ellipse cx="17.5" cy="13" fill="currentColor" rx="5" ry="11" transform="rotate(-16 17.5 13)" />
      <ellipse cx="30.5" cy="13" fill="currentColor" rx="5" ry="11" transform="rotate(16 30.5 13)" />
      <circle cx="24" cy="29" fill="currentColor" r="13" />
      <circle cx="19.25" cy="27" fill="var(--primary)" r="1.35" />
      <circle cx="28.75" cy="27" fill="var(--primary)" r="1.35" />
      <path d="M22 32.2c1.1 1.35 2.9 1.35 4 0" stroke="var(--primary)" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

export function EventZekaBrand({
  compact = false,
  showTagline = false,
}: {
  compact?: boolean;
  showTagline?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span
        className={cn(
          "inline-flex items-center rounded-full bg-primary font-semibold tracking-[-0.01em] text-primary-foreground",
          compact ? "h-9 gap-1.5 px-2.5 text-xs" : "h-9 gap-2 px-3.5 text-sm",
        )}
      >
        <EventZekaMark className={compact ? "h-5 w-5" : "h-5.5 w-5.5"} />
        <span className="whitespace-nowrap">Event Zeka</span>
      </span>
      {showTagline ? (
        <span className="hidden text-sm font-medium text-muted-foreground lg:inline">
          Belgrade, happening now
        </span>
      ) : null}
    </span>
  );
}
