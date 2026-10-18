"use client";

import { useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Check, LoaderCircle, RefreshCw, TriangleAlert, X } from "lucide-react";
import { CANONICAL_VENUE_CATEGORIES } from "@/lib/taxonomy/venue-types";
import {
  executeVenueBulkEdit,
  type VenueBulkPatch,
  type VenueBulkProgress,
  type VenueBulkResult,
  type VenueBulkTarget,
} from "@/lib/admin/venue-bulk-edit";

const KEEP = "keep";
const INPUT_CLASS = "min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50";
const BUTTON_CLASS = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

type FrozenBatch = {
  targets: VenueBulkTarget[];
  patch: VenueBulkPatch;
};

function remainingIds(result: VenueBulkResult): string[] {
  return [...new Set([...result.failures.map((entry) => entry.id), ...result.unattempted.map((entry) => entry.id)])];
}

function patchDescriptions(patch: VenueBulkPatch): Array<[string, string]> {
  return [
    ...(patch.category ? [["Type", patch.category] as [string, string]] : []),
    ...(patch.publicStatus ? [["Publication", patch.publicStatus] as [string, string]] : []),
    ...(typeof patch.scrapeActive === "boolean" ? [["Scraping", patch.scrapeActive ? "Enabled" : "Paused"] as [string, string]] : []),
  ];
}

export function VenueBulkEdit({
  onBusyChange,
  onComplete,
  onOpenChange,
  open,
  restoreFocus,
  venues,
}: {
  onBusyChange: (busy: boolean) => void;
  onComplete: (remainingVenueIds: string[]) => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  restoreFocus: () => void;
  venues: VenueBulkTarget[];
}) {
  const [category, setCategory] = useState(KEEP);
  const [publication, setPublication] = useState(KEEP);
  const [scraping, setScraping] = useState(KEEP);
  const [batch, setBatch] = useState<FrozenBatch | null>(null);
  const [result, setResult] = useState<VenueBulkResult | null>(null);
  const [progress, setProgress] = useState<VenueBulkProgress | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshSucceeded, setRefreshSucceeded] = useState(true);
  const operationLock = useRef(false);

  const draftPatch: VenueBulkPatch = {
    ...(category !== KEEP ? { category } : {}),
    ...(publication !== KEEP ? { publicStatus: publication as VenueBulkPatch["publicStatus"] } : {}),
    ...(scraping !== KEEP ? { scrapeActive: scraping === "enabled" } : {}),
  };
  const reviewTargets = batch?.targets ?? venues;
  const reviewPatch = batch?.patch ?? draftPatch;
  const descriptions = patchDescriptions(reviewPatch);
  const pendingIds = result ? remainingIds(result) : [];
  const unchangedCount = reviewTargets.filter((venue) => Object.entries(reviewPatch).every(([field, value]) => venue[field as keyof VenueBulkPatch] === value)).length;

  function setOpen(nextOpen: boolean) {
    if (operationLock.current) return;
    if (!nextOpen) {
      setCategory(KEEP);
      setPublication(KEEP);
      setScraping(KEEP);
      setBatch(null);
      setResult(null);
      setProgress(null);
      setError(null);
      setRefreshSucceeded(true);
    }
    onOpenChange(nextOpen);
  }

  function setBusy(busy: boolean) {
    operationLock.current = busy;
    setIsBusy(busy);
    onBusyChange(busy);
  }

  async function refreshResults(nextResult: VenueBulkResult) {
    try {
      const refreshed = await onComplete(remainingIds(nextResult));
      setRefreshSucceeded(refreshed);
    } catch {
      setRefreshSucceeded(false);
    }
  }

  async function applyChanges(retry: boolean) {
    if (operationLock.current || (retry && !refreshSucceeded)) return;
    const frozenBatch: FrozenBatch = batch ?? {
      targets: venues.map(({ id, name, category: venueCategory, publicStatus, scrapeActive }) => ({ id, name, category: venueCategory, publicStatus, scrapeActive })),
      patch: { ...draftPatch },
    };
    if (frozenBatch.targets.length === 0 || Object.keys(frozenBatch.patch).length === 0) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    setBatch(frozenBatch);
    try {
      const missing: VenueBulkResult["failures"] = [];
      let targets = frozenBatch.targets;
      if (retry && result) {
        const currentTargets = new Map(venues.map((venue) => [venue.id, venue]));
        const originalTargets = new Map(frozenBatch.targets.map((venue) => [venue.id, venue]));
        targets = [];
        for (const id of remainingIds(result)) {
          const current = currentTargets.get(id);
          if (current) targets.push({ ...current });
          else missing.push({ id, name: originalTargets.get(id)?.name ?? id, error: "Venue is missing from the refreshed list. Reload before retrying.", unconfirmed: true });
        }
      }
      const attempt = targets.length ? await executeVenueBulkEdit(targets, { ...frozenBatch.patch }, { onProgress: setProgress }) : { total: 0, updatedIds: [], unchangedIds: [], failures: [], unattempted: [] } satisfies VenueBulkResult;
      const nextResult: VenueBulkResult = {
        total: frozenBatch.targets.length,
        updatedIds: [...new Set([...(retry && result ? result.updatedIds : []), ...attempt.updatedIds])],
        unchangedIds: [...new Set([...(retry && result ? result.unchangedIds : []), ...attempt.unchangedIds])],
        failures: [...missing, ...attempt.failures],
        unattempted: attempt.unattempted,
      };
      setResult(nextResult);
      await refreshResults(nextResult);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Bulk update could not be started.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshBeforeRetry() {
    if (operationLock.current || !result) return;
    setBusy(true);
    try {
      await refreshResults(result);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-2xl outline-none" onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }} onEscapeKeyDown={(event) => { if (operationLock.current) event.preventDefault(); }} onInteractOutside={(event) => event.preventDefault()}>
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-3 sm:px-6">
            <Dialog.Title className="text-lg font-semibold">Edit selected venues</Dialog.Title>
            <button aria-label="Close bulk editor" className={`${BUTTON_CLASS} border-transparent px-3`} disabled={isBusy} onClick={() => setOpen(false)} type="button"><X aria-hidden="true" className="size-4" /></button>
          </header>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 sm:p-6">
            {!batch ? (
              <fieldset className="grid gap-4 sm:grid-cols-3" disabled={isBusy}>
                <label className="grid gap-1.5 text-sm font-medium">Type<select className={INPUT_CLASS} onChange={(event) => setCategory(event.target.value)} value={category}><option value={KEEP}>Keep unchanged</option>{CANONICAL_VENUE_CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                <label className="grid gap-1.5 text-sm font-medium">Publication<select className={INPUT_CLASS} onChange={(event) => setPublication(event.target.value)} value={publication}><option value={KEEP}>Keep unchanged</option><option value="pending">Pending</option><option value="published">Published</option><option value="hidden">Hidden</option></select></label>
                <label className="grid gap-1.5 text-sm font-medium">Scraping<select className={INPUT_CLASS} onChange={(event) => setScraping(event.target.value)} value={scraping}><option value={KEEP}>Keep unchanged</option><option value="enabled">Enabled</option><option value="paused">Paused</option></select></label>
              </fieldset>
            ) : null}
            <section className="space-y-3 rounded-xl border border-border p-4">
              <h3 className="text-sm font-medium">{result ? "Requested changes" : "Review changes"}</h3>
              {descriptions.length ? <dl className="space-y-2 text-sm">{descriptions.map(([label, value]) => <div className="flex items-center justify-between gap-4" key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium capitalize">{value}</dd></div>)}</dl> : <p className="text-sm text-muted-foreground">Choose at least one field to change.</p>}
              <details className="border-t border-border pt-2"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{reviewTargets.length} selected venues</summary><ul className="max-h-36 space-y-2 overflow-y-auto pb-2 text-xs text-muted-foreground">{reviewTargets.map((venue) => <li key={venue.id}>{venue.name}</li>)}</ul></details>
              {!batch && descriptions.length > 0 && unchangedCount > 0 ? <p className="text-xs text-muted-foreground">{unchangedCount} already match these changes.</p> : null}
            </section>
            {isBusy ? <div aria-live="polite" className="space-y-2 text-sm"><p className="flex items-center gap-2"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />{progress ? `${progress.completed} of ${progress.total} processed` : "Preparing update..."}</p>{progress && progress.total > 0 ? <progress aria-label="Bulk update progress" className="h-2 w-full accent-primary" max={progress.total} value={progress.completed} /> : null}</div> : null}
            {result ? (
              <section aria-live="polite" className="space-y-3">
                <p className="flex items-center gap-2 text-sm font-medium">{pendingIds.length ? <TriangleAlert aria-hidden="true" className="size-4 text-amber-300" /> : <Check aria-hidden="true" className="size-4 text-emerald-400" />}{pendingIds.length ? "Batch finished with issues" : "Update complete"}</p>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">{[["Updated", result.updatedIds.length], ["Unchanged", result.unchangedIds.length], ["Failed", result.failures.length], ["Not attempted", result.unattempted.length]].map(([label, count]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-semibold tabular-nums">{count}</dd></div>)}</dl>
                {pendingIds.length ? <ul className="max-h-44 space-y-3 overflow-y-auto rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs">{result.failures.map((entry) => <li key={entry.id}><p className="font-medium">{entry.name}</p><p className="mt-1 text-muted-foreground">{entry.unconfirmed ? "Result unconfirmed. " : ""}{entry.error}</p></li>)}{result.unattempted.map((entry) => <li key={entry.id}><p className="font-medium">{entry.name}</p><p className="mt-1 text-muted-foreground">Not attempted: {entry.reason}</p></li>)}</ul> : null}
              </section>
            ) : null}
            {!refreshSucceeded ? <div className="space-y-2 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-sm" role="alert"><p>The venue list could not be refreshed. Refresh before retrying.</p><button className={BUTTON_CLASS} disabled={isBusy} onClick={() => void refreshBeforeRetry()} type="button"><RefreshCw aria-hidden="true" className="size-4" />Refresh venue list</button></div> : null}
            {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm" role="alert">{error}</p> : null}
          </div>
          <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-4 sm:px-6">
            <button className={BUTTON_CLASS} disabled={isBusy} onClick={() => setOpen(false)} type="button">{result ? "Done" : "Cancel"}</button>
            {result ? pendingIds.length > 0 ? <button className={PRIMARY_BUTTON_CLASS} disabled={isBusy || !refreshSucceeded} onClick={() => void applyChanges(true)} type="button">{isBusy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}Retry {pendingIds.length} remaining</button> : null : <button className={PRIMARY_BUTTON_CLASS} disabled={isBusy || descriptions.length === 0 || reviewTargets.length === 0} onClick={() => void applyChanges(false)} type="button">{isBusy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}Apply to {reviewTargets.length} venues</button>}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
