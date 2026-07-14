import {
  UNKNOWN_EVENT_TIME_LABEL,
  getDisplayEventTime,
  getEventTimeProvenanceLabel,
  resolveEventTimeProvenance,
  type EventTimeProvenanceFields,
} from "@/lib/events/event-time";
import { cn } from "@/lib/utils";

type EventTimeProvenanceTextProps = EventTimeProvenanceFields & {
  className?: string;
  time?: string | null;
};

export function EventTimeProvenanceText({
  className,
  time,
  timeConfidence,
  timeEvidenceText,
  timeSource,
  timeStatus,
}: EventTimeProvenanceTextProps) {
  const provenance = resolveEventTimeProvenance({
    timeConfidence,
    timeEvidenceText,
    timeSource,
    timeStatus,
  });
  const announcedTime = getDisplayEventTime(time);

  if (!announcedTime) {
    return (
      <p
        className={cn("text-xs leading-4 text-muted-foreground", className)}
        data-event-time-provenance="unknown"
      >
        {UNKNOWN_EVENT_TIME_LABEL}
      </p>
    );
  }

  const provenanceLabel = getEventTimeProvenanceLabel(provenance);
  const confidenceLabel =
    provenance.status !== "unknown" && provenance.confidence > 0
      ? `${Math.round(provenance.confidence * 100)}%`
      : null;

  return (
    <p
      className={cn("min-w-0 truncate text-xs leading-4 text-muted-foreground", className)}
      data-event-time-provenance={provenance.status}
      title={
        [
          provenanceLabel,
          confidenceLabel,
          provenance.evidenceText ? `Evidence: ${provenance.evidenceText}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      }
    >
      <span>{provenanceLabel}</span>
      {confidenceLabel ? <span> · {confidenceLabel}</span> : null}
      {provenance.evidenceText ? (
        <span>
          {" · Evidence: "}
          <q>{provenance.evidenceText}</q>
        </span>
      ) : null}
    </p>
  );
}
