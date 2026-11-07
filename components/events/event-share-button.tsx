"use client";
import { PublicText, LocalizedElement } from "@/components/i18n/public-text";


import { Copy, Download, LoaderCircle, RefreshCw, Share2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/client";

type SharePreview = { url: string; file: File };

function canShareImage(preview: SharePreview | null): boolean {
  if (!preview || typeof navigator === "undefined" || !navigator.canShare || !navigator.share) return false;
  try { return navigator.canShare({ files: [preview.file] }); }
  catch { return false; }
}

export function EventShareButton({ eventId, title, url }: { eventId: string; title: string; url: string }) {
  const locale = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 28_000);
    let objectUrl: string | undefined;
    let disposed = false;
    setLoading(true);
    setError(null);
    setMessage(null);
    setPreview(null);
    void (async () => {
      try {
        const response = await fetch(`/api/events/${eventId}/export?locale=${locale}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok || !response.headers.get("content-type")?.startsWith("image/jpeg")) {
          throw new Error("Could not prepare the image.");
        }
        const blob = await response.blob();
        if (!blob.size || blob.size > 2_000_000) throw new Error("Image is unavailable.");
        if (disposed || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({
          url: objectUrl,
          file: new File([blob], `eventzeka-${eventId}.jpg`, { type: "image/jpeg" }),
        });
      } catch {
        if (disposed) return;
        if (!controller.signal.aborted) setError("The image is unavailable. You can still copy the event link.");
        else if (dialog.current?.open) setError("Preparing the image took too long. Please try again.");
      } finally {
        clearTimeout(timeout);
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, eventId, attempt, locale]);

  async function copyLink() {
    setMessage(null);
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Event link copied.");
    } catch {
      setMessage("Copy the link below to share this event.");
    }
  }

  async function shareImage() {
    if (!preview || !canShareImage(preview)) return;
    setMessage(null);
    try {
      // The file is prepared before this gesture so mobile share keeps its
      // required user activation. Sharing destinations remain the user's choice.
      await navigator.share({ files: [preview.file], title, text: `${title}\n${url}` });
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === "AbortError") return;
      setMessage("Sharing is unavailable here. Download the image or copy the event link.");
    }
  }

  function showDialog() {
    dialog.current?.showModal();
    setOpen(true);
  }

  const nativeImageShare = canShareImage(preview);

  return (
    <>
      <button className="button-secondary min-h-10 gap-2 px-4 py-0" onClick={showDialog} type="button">
        <Share2 aria-hidden="true" className="h-4 w-4" /><PublicText text={"Share"} /></button>
      <dialog
        aria-labelledby={`share-title-${eventId}`}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-1.5rem)] max-w-lg overflow-y-auto overscroll-contain rounded-3xl border border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/75"
        onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}
        onClose={() => { setOpen(false); setPreview(null); }}
        ref={dialog}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold" id={`share-title-${eventId}`}><PublicText text={"Share this event"} /></h2>
            <p className="mt-1 text-xs text-muted-foreground"><PublicText text={"Story image - 1080 x 1920"} /></p>
          </div>
          <LocalizedElement as="button" aria-label="Close sharing" className="button-secondary h-11 w-11 shrink-0 p-0" onClick={() => dialog.current?.close()} type="button">
            <X aria-hidden="true" className="h-5 w-5" />
          </LocalizedElement>
        </div>
        <div className="space-y-4 p-5">
          <div aria-busy={loading} className="mx-auto flex aspect-[9/16] max-h-[46dvh] min-h-52 items-center justify-center overflow-hidden rounded-xl border border-border bg-card">
            {preview ? (
              // A local object URL is already the final, bounded JPEG.
              // eslint-disable-next-line @next/next/no-img-element
              <img alt={`Share image for ${title}`} className="h-full w-full object-contain" height={1920} src={preview.url} width={1080} />
            ) : loading ? (
              <p className="flex items-center gap-2 px-4 text-sm text-muted-foreground" role="status">
                <LoaderCircle aria-hidden="true" className="h-5 w-5 animate-spin" /><PublicText text={" Preparing image..."} /></p>
            ) : <p className="px-5 text-center text-sm text-muted-foreground"><PublicText text={"Image preview unavailable"} /></p>}
          </div>
          {error ? (
            <div className="space-y-2 text-sm text-muted-foreground" role="status">
              <p><PublicText text={error} /></p>
              <button className="button-secondary min-h-11 gap-2 px-3 py-0 text-xs" onClick={() => setAttempt(value => value + 1)} type="button">
                <RefreshCw aria-hidden="true" className="h-4 w-4" /><PublicText text={" Try image again"} /></button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {nativeImageShare ? (
              <button className="button-primary min-h-11 flex-1 gap-2 px-4 py-0" onClick={() => void shareImage()} type="button">
                <Share2 aria-hidden="true" className="h-4 w-4" /><PublicText text={" Share image"} /></button>
            ) : null}
            {preview ? (
              <LocalizedElement as="a" className={`${nativeImageShare ? "button-secondary" : "button-primary"} min-h-11 flex-1 gap-2 px-4 py-0`} download={preview.file.name} href={preview.url}>
                <Download aria-hidden="true" className="h-4 w-4" /><PublicText text={" Download image"} /></LocalizedElement>
            ) : null}
            <button className="button-secondary min-h-11 flex-1 gap-2 px-4 py-0" onClick={() => void copyLink()} type="button">
              <Copy aria-hidden="true" className="h-4 w-4" /><PublicText text={" Copy link"} /></button>
          </div>
          {message ? <p className="text-sm text-primary" role="status"><PublicText text={message} /></p> : null}
          <label className="block text-xs text-muted-foreground"><PublicText text={"Event link"} /><LocalizedElement as="input" aria-label="Event link" className="mt-2 min-h-11 w-full rounded-xl border border-border bg-card px-3 text-xs text-foreground" onFocus={event => event.currentTarget.select()} readOnly value={url} />
          </label>
        </div>
      </dialog>
    </>
  );
}
