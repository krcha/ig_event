"use client";
import { LocalizedElement, PublicText } from "@/components/i18n/public-text";


import { LocalizedLink as Link } from "@/components/i18n/public-text";
import { useEffect, useState } from "react";
import { Clock3, ExternalLink, ImageOff, Instagram, LoaderCircle, X } from "lucide-react";
import { ReadMoreText } from "@/components/ui/read-more-text";
import { ResponsiveEventImage } from "@/components/events/responsive-event-image";
import { useCalendarEventPreview } from "@/components/calendar/calendar-event-preview";
import type { PublicEventPostPreview } from "@/lib/events/public-event-post";
import { cn } from "@/lib/utils";
import { EventTravel } from "@/components/travel/event-travel";
import { YandexTaxiButton } from "@/components/travel/yandex-taxi-button";
import styles from "./event-post-preview.module.css";

export default function EventPostPreview({ eventId, onClose, title, venueHoursLabel, venueLatitude, venueLongitude, venueName }: {
  eventId: string;
  onClose: () => void;
  title: string;
  venueHoursLabel?: string | null;
  venueLatitude?: number;
  venueLongitude?: number;
  venueName?: string;
}) {
  const { load } = useCalendarEventPreview();
  const [post, setPost] = useState<PublicEventPostPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [imageReady, setImageReady] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  function retryPost() {
    setPost(null);
    setError(null);
    setImageReady(false);
    setImageFailed(false);
    setAttempt((value) => value + 1);
  }

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    load(eventId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPost(result);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "The post could not be loaded.");
      }
    });
    return () => controller.abort();
  }, [attempt, eventId, load]);

  const handle = post?.instagramHandle ? `@${post.instagramHandle.replace(/^@/, "")}` : "Instagram post";
  // The first-party proxy independently checks public eligibility. Starting it
  // alongside caption loading avoids a second network round trip after a tap.
  const imageUrl = post ? post.imageUrl : `/api/discover/images/${encodeURIComponent(eventId)}`;
  const actionClass = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-semibold text-foreground transition hover:bg-white/[0.07] focus-visible:outline-2 focus-visible:outline-primary";

  return (
    <div
      className={styles.post}
      data-calendar-event-post={eventId}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
    >
      {imageUrl && !imageFailed ? <div aria-hidden="true" className={styles.backdrop} style={{ backgroundImage: `url("/api/discover/images/${encodeURIComponent(eventId)}?w=192")` }} /> : null}
      <LocalizedElement as="button"
        aria-label="Close Instagram post"
        className={cn(styles.close, "inline-flex h-11 w-11 items-center justify-center rounded-full text-foreground transition hover:bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:hidden")}
        data-calendar-event-post-close="overlay"
        onClick={onClose}
        type="button"
      ><X aria-hidden="true" className="h-4 w-4" /></LocalizedElement>
      <div className="hidden min-w-0 items-center justify-between gap-2 px-3 py-2 md:flex" data-calendar-event-post-heading="true">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.035] text-foreground">
            <Instagram aria-hidden="true" className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold text-foreground">{handle}</span>
            {post ? <span className="block truncate text-[11px] text-muted-foreground">{post.venue}</span> : null}
          </span>
        </div>
        <LocalizedElement as="button" aria-label="Close Instagram post" className={cn(actionClass, "h-9 w-9 flex-none px-0")} onClick={onClose} type="button">
          <X aria-hidden="true" className="h-4 w-4" />
        </LocalizedElement>
      </div>

      {error ? (
        <div className="px-3 pb-3 pt-14 md:pt-0" role="alert">
          <p className="text-sm text-muted-foreground"><PublicText text={error} /></p>
          <button className="mt-2 min-h-9 text-xs font-semibold text-primary hover:underline" onClick={retryPost} type="button"><PublicText text={"Try again"} /></button>
        </div>
      ) : (
        <div className={styles.layout}>
          <div className={styles.image} data-calendar-event-post-image="true">
            {venueHoursLabel ? <p className={styles.hours} data-calendar-event-post-hours="true"><Clock3 aria-hidden="true" className="h-3.5 w-3.5" /><span><PublicText text={`Radno vreme mesta: ${venueHoursLabel === "Open 24 hours" ? "24 h" : venueHoursLabel}`} /></span></p> : null}
            {imageUrl && !imageFailed ? (
              <>
                {!imageReady ? <div className="absolute inset-0 flex items-center justify-center text-muted-foreground" role="status"><LoaderCircle aria-hidden="true" className="h-5 w-5 motion-safe:animate-spin" /><span className="sr-only"><PublicText text={"Loading post image"} /></span></div> : null}
                <ResponsiveEventImage
                  alt={`Original post image for ${title}`}
                  className={cn(styles.poster, "transition-opacity motion-reduce:transition-none", imageReady ? "opacity-100" : "opacity-0")}
                  decoding="async"
                  loading="eager"
                  onError={() => setImageFailed(true)}
                  onLoad={() => setImageReady(true)}
                  sizes="(min-width: 768px) 50vw, 100vw"
                  src={imageUrl}
                />
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
                <ImageOff aria-hidden="true" className="h-5 w-5" />
                <p className="text-xs"><PublicText text={"The original image is unavailable."} /></p>
                {imageFailed ? <button className="min-h-9 text-xs font-semibold text-primary hover:underline" onClick={retryPost} type="button"><PublicText text={"Retry image"} /></button> : null}
              </div>
            )}
          </div>
          <div className={styles.body}>
            {post ? (
              <div>
                <p className="sr-only">
                  <PublicText text={post.captionSource === "instagram" ? "Original caption" : "Event description"} />
                </p>
                {post.caption ? (
                  <ReadMoreText
                    buttonClassName="min-h-6 text-xs leading-5"
                    collapsedButtonClassName={styles.readMore}
                    lines={2}
                    paragraphProps={{ "data-calendar-event-caption-source": post.captionSource ?? "missing" }}
                    text={post.caption}
                    textClassName="break-words text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]"
                  />
                ) : <p className="text-xs leading-5 text-muted-foreground"><PublicText text={"The original caption is unavailable. You can view the source on Instagram."} /></p>}
              </div>
            ) : <p className="text-xs leading-5 text-muted-foreground" role="status"><PublicText text={"Loading original caption..."} /></p>}

            <EventTravel className={styles.travel} venueLatitude={venueLatitude} venueLongitude={venueLongitude} venueName={venueName ?? post?.venue} showTaxi={false} />
            <div className={styles.actions}>
              {post?.instagramPostUrl ? (
                <LocalizedElement as="a" className={actionClass} href={post.instagramPostUrl} rel="noopener noreferrer" target="_blank">
                  <Instagram aria-hidden="true" className="h-3.5 w-3.5" /><PublicText text={" Instagram"} /></LocalizedElement>
              ) : null}
              <Link className={actionClass} data-calendar-event-link="true" href={`/events/${eventId}`} prefetch={false}>
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /><PublicText text={" Event details"} /></Link>
              {typeof venueLatitude === "number" && typeof venueLongitude === "number" ? <div className={styles.taxi}><YandexTaxiButton latitude={venueLatitude} longitude={venueLongitude} venueName={venueName ?? post?.venue} /></div> : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
