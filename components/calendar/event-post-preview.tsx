"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ExternalLink, ImageOff, Instagram, LoaderCircle, X } from "lucide-react";
import { ReadMoreText } from "@/components/ui/read-more-text";
import { useCalendarEventPreview } from "@/components/calendar/calendar-event-preview";
import type { PublicEventPostPreview } from "@/lib/events/public-event-post";
import { cn } from "@/lib/utils";

export default function EventPostPreview({ eventId, onClose, title }: {
  eventId: string;
  onClose: () => void;
  title: string;
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
  const actionClass = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-full px-2.5 text-xs font-semibold text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary";

  return (
    <div
      className="relative overflow-hidden border-t border-primary/15 bg-[#0d0f16]"
      data-calendar-event-post={eventId}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
    >
      <button
        aria-label="Close Instagram post"
        className="absolute right-2 top-2 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full border border-border/75 bg-background/90 text-foreground transition hover:bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary md:hidden"
        data-calendar-event-post-close="overlay"
        onClick={onClose}
        type="button"
      ><X aria-hidden="true" className="h-4 w-4" /></button>
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
        <button aria-label="Close Instagram post" className={cn(actionClass, "h-9 w-9 flex-none px-0")} onClick={onClose} type="button">
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {error ? (
        <div className="px-3 pb-3 pt-14 md:pt-0" role="alert">
          <p className="text-sm text-muted-foreground">{error}</p>
          <button className="mt-2 min-h-9 text-xs font-semibold text-primary hover:underline" onClick={retryPost} type="button">Try again</button>
        </div>
      ) : (
        <div className="md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="relative h-[min(calc(38svh_+_66px),calc(18rem_+_66px))] min-h-48 overflow-hidden bg-black/40 md:h-[min(38svh,18rem)]" data-calendar-event-post-image="true">
            {imageUrl && !imageFailed ? (
              <>
                {!imageReady ? <div className="absolute inset-0 flex items-center justify-center text-muted-foreground" role="status"><LoaderCircle aria-hidden="true" className="h-5 w-5 motion-safe:animate-spin" /><span className="sr-only">Loading post image</span></div> : null}
                <Image
                  alt={`Original post image for ${title}`}
                  className={cn("object-contain transition-opacity motion-reduce:transition-none", imageReady ? "opacity-100" : "opacity-0")}
                  decoding="async"
                  fill
                  loading="eager"
                  onError={() => setImageFailed(true)}
                  onLoad={() => setImageReady(true)}
                  sizes="(min-width: 640px) 50vw, 100vw"
                  src={imageUrl}
                  unoptimized
                />
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
                <ImageOff aria-hidden="true" className="h-5 w-5" />
                <p className="text-xs">The original image is unavailable.</p>
                {imageFailed ? <button className="min-h-9 text-xs font-semibold text-primary hover:underline" onClick={retryPost} type="button">Retry image</button> : null}
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-col justify-between px-3 pb-2 pt-3 sm:pt-2">
            {post ? (
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground/75">
                  {post.captionSource === "instagram" ? "Original caption" : "Event description"}
                </p>
                {post.caption ? (
                  <ReadMoreText
                    buttonClassName="text-xs leading-5"
                    collapsedButtonClassName="bg-[#0d0f16]"
                    lines={3}
                    paragraphProps={{ "data-calendar-event-caption-source": post.captionSource ?? "missing" }}
                    text={post.caption}
                    textClassName="break-words text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]"
                  />
                ) : <p className="text-xs leading-5 text-muted-foreground">The original caption is unavailable. You can view the source on Instagram.</p>}
              </div>
            ) : <p className="text-xs leading-5 text-muted-foreground" role="status">Loading original caption...</p>}

            <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-white/[0.06] pt-1.5">
              {post?.instagramPostUrl ? (
                <a className={actionClass} href={post.instagramPostUrl} rel="noopener noreferrer" target="_blank">
                  <Instagram aria-hidden="true" className="h-3.5 w-3.5" /> Instagram
                </a>
              ) : null}
              <Link className={actionClass} data-calendar-event-link="true" href={`/events/${eventId}`} prefetch={false}>
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /> Event details
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
