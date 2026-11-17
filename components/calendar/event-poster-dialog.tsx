"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { ExternalLink, ImageOff, Instagram, LoaderCircle, X } from "lucide-react";
import { LocalizedElement, LocalizedLink as Link, PublicText } from "@/components/i18n/public-text";
import { ResponsiveEventImage } from "@/components/events/responsive-event-image";
import type { PublicEventPostPreview } from "@/lib/events/public-event-post";
import styles from "./event-poster-dialog.module.css";

export default function EventPosterDialog({ eventId, title, venue, imageUrl, post, error, onRetry, returnFocus, onClose }: {
  eventId: string;
  title: string;
  venue?: string;
  imageUrl: string | null;
  post: PublicEventPostPreview | null;
  error: string | null;
  onRetry: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [imageReady, setImageReady] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    const opener = returnFocus.current;
    const rowTrigger = opener?.closest("[data-calendar-event-preview-row]")?.querySelector<HTMLButtonElement>("[data-calendar-event-preview-toggle]");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element?.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      (opener?.isConnected ? opener : rowTrigger)?.focus({ preventScroll: true });
    };
  }, [returnFocus]);
  function closeDialog() { dialog.current?.close(); onClose(); }
  function keepModalFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") { event.stopPropagation(); return; }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])")]
      .filter(element => element.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
  }
  return <dialog aria-labelledby={titleId} className={styles.dialog} data-event-poster-dialog={eventId} ref={dialog}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); closeDialog(); }}
    onClose={event => { if (!event.currentTarget.open) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) closeDialog(); }}
    onKeyDown={keepModalFocus}>
    <header className={styles.header}>
      <div><h2 id={titleId}>{title}</h2>{venue ? <p>{venue}</p> : null}</div>
      <LocalizedElement as="button" aria-label="Zatvori detalje" className={styles.close} onClick={closeDialog} ref={closeButton} type="button"><X aria-hidden="true" className="h-5 w-5" /></LocalizedElement>
    </header>
    <div className={styles.content}>
      <div className={styles.media}>
        {imageUrl && !imageFailed ? <>
          {!imageReady ? <div className={styles.imageStatus} role="status"><LoaderCircle aria-hidden="true" className="h-5 w-5 motion-safe:animate-spin" /><span className="sr-only"><PublicText text="Loading post image" /></span></div> : null}
          <ResponsiveEventImage alt={title} className={styles.poster} decoding="async" fill
            onError={() => setImageFailed(true)} onLoad={() => setImageReady(true)} priority
            sizes="(min-width: 1024px) 600px, (min-width: 768px) 60vw, calc(100vw - 24px)" src={imageUrl} />
        </> : <div className={styles.imageStatus}><ImageOff aria-hidden="true" className="h-6 w-6" /><p><PublicText text="The original image is unavailable." /></p>
          {imageFailed ? <button className="button-secondary" onClick={() => { setImageFailed(false); setImageReady(false); }} type="button"><PublicText text="Retry image" /></button> : null}</div>}
      </div>
      <div className={styles.description}>
        {post ? <div>
          <p className="sr-only"><PublicText text={post.captionSource === "instagram" ? "Original caption" : "Event description"} /></p>
          <p className={styles.caption} data-calendar-full-caption-source={post.captionSource ?? "missing"} lang="und">{post.caption || <PublicText text="The original caption is unavailable. You can view the source on Instagram." />}</p>
        </div> : error ? <div role="alert"><p className={styles.caption}><PublicText text={error} /></p><button className="button-secondary mt-3" onClick={onRetry} type="button"><PublicText text="Try again" /></button></div>
          : <p role="status" className={styles.caption}><PublicText text="Loading original caption..." /></p>}
        <div className={styles.actions}>
          {post?.instagramPostUrl ? <LocalizedElement as="a" href={post.instagramPostUrl} rel="noopener noreferrer" target="_blank"><Instagram aria-hidden="true" className="h-4 w-4" /><PublicText text="Instagram" /></LocalizedElement> : null}
          <Link href={`/events/${eventId}`} prefetch={false}><ExternalLink aria-hidden="true" className="h-4 w-4" /><PublicText text="Event details" /></Link>
        </div>
      </div>
    </div>
  </dialog>;
}
