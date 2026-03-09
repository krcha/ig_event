"use client";

import { useEffect, useState } from "react";

type Venue = {
  id: string;
  name: string;
  instagramHandle: string;
  category: string;
  location: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
};

type VenueListResponse = {
  venues: Venue[];
  error?: string;
};

type VenueImportResponse = {
  ok?: boolean;
  error?: string;
  totalRows?: number;
  validRows?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  skippedMissingHandle?: number;
  skippedMissingName?: number;
  skippedDuplicateHandle?: number;
};

export function VenueManager() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<VenueImportResponse | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importCategory, setImportCategory] = useState("venue");
  const [form, setForm] = useState({
    name: "",
    instagramHandle: "",
    category: "club",
    location: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function loadVenues() {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/venues", { cache: "no-store" });
      const payload = (await response.json()) as VenueListResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load venues.");
      }
      setVenues(payload.venues);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Unknown venue load error.",
      );
      setVenues([]);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadVenues();
  }, []);

  async function createVenue() {
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/venues", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          instagramHandle: form.instagramHandle.trim(),
          category: form.category.trim(),
          location: form.location.trim() || undefined,
          isActive: true,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to create venue.");
      }

      setForm({
        name: "",
        instagramHandle: "",
        category: "club",
        location: "",
      });
      await loadVenues();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Unknown create venue error.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function importVenuesCsv() {
    if (!importFile) {
      setImportError("Choose a CSV file first.");
      return;
    }

    setIsImporting(true);
    setImportError(null);
    setImportSummary(null);
    try {
      const formData = new FormData();
      formData.set("file", importFile);
      formData.set("category", importCategory.trim() || "venue");
      formData.set("isActive", "true");

      const response = await fetch("/api/admin/venues/import", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as VenueImportResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to import CSV.");
      }

      setImportSummary(payload);
      setImportFile(null);
      await loadVenues();
    } catch (caughtError) {
      setImportError(
        caughtError instanceof Error ? caughtError.message : "Unknown CSV import error.",
      );
    } finally {
      setIsImporting(false);
    }
  }

  async function toggleVenueActiveState(venue: Venue) {
    setError(null);
    try {
      const response = await fetch("/api/admin/venues", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: venue.id,
          patch: {
            isActive: !venue.isActive,
          },
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to update venue.");
      }

      await loadVenues();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Unknown update venue error.",
      );
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <h2 className="text-lg font-semibold">Venue Configuration</h2>

      <div className="grid gap-2 sm:grid-cols-2">
        <input
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          placeholder="Venue name"
          value={form.name}
        />
        <input
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          onChange={(event) =>
            setForm((current) => ({ ...current, instagramHandle: event.target.value }))
          }
          placeholder="@instagram_handle"
          value={form.instagramHandle}
        />
        <input
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          onChange={(event) =>
            setForm((current) => ({ ...current, category: event.target.value }))
          }
          placeholder="Category (club, bar, venue, artist)"
          value={form.category}
        />
        <input
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          onChange={(event) =>
            setForm((current) => ({ ...current, location: event.target.value }))
          }
          placeholder="Location (optional)"
          value={form.location}
        />
      </div>

      <button
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isSubmitting}
        onClick={() => void createVenue()}
        type="button"
      >
        {isSubmitting ? "Saving..." : "Add venue"}
      </button>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {isLoading ? <p className="text-sm text-muted-foreground">Loading venues...</p> : null}

      <div className="space-y-2 rounded-md border border-border bg-background/60 p-3">
        <p className="text-sm font-medium">Import venues from CSV</p>
        <p className="text-xs text-muted-foreground">
          Uses `_ap3a` as Instagram handle and `x1lliihq` as place name.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            accept=".csv,text/csv"
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
            type="file"
          />
          <input
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            onChange={(event) => setImportCategory(event.target.value)}
            placeholder="Category for new rows (default: venue)"
            value={importCategory}
          />
        </div>
        <button
          className="rounded-md border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isImporting}
          onClick={() => void importVenuesCsv()}
          type="button"
        >
          {isImporting ? "Importing..." : "Import CSV"}
        </button>
        {importError ? <p className="text-sm text-destructive">{importError}</p> : null}
        {importSummary ? (
          <p className="text-xs text-muted-foreground">
            rows={importSummary.totalRows ?? 0} valid={importSummary.validRows ?? 0} created=
            {importSummary.created ?? 0} updated={importSummary.updated ?? 0} unchanged=
            {importSummary.unchanged ?? 0} skipped_missing_handle=
            {importSummary.skippedMissingHandle ?? 0} skipped_missing_name=
            {importSummary.skippedMissingName ?? 0} skipped_duplicate_handle=
            {importSummary.skippedDuplicateHandle ?? 0}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        {venues.map((venue) => (
          <article className="rounded-md border border-border bg-background p-3" key={venue.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">{venue.name}</p>
                <p className="text-xs text-muted-foreground">
                  @{venue.instagramHandle} · {venue.category}
                  {venue.location ? ` · ${venue.location}` : ""}
                </p>
              </div>
              <button
                className="rounded-md border border-border px-3 py-1 text-xs font-medium"
                onClick={() => void toggleVenueActiveState(venue)}
                type="button"
              >
                {venue.isActive ? "Deactivate" : "Activate"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
