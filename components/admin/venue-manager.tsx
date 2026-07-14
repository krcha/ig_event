"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CANONICAL_VENUE_CATEGORIES,
  DEFAULT_VENUE_CATEGORY,
} from "@/lib/taxonomy/venue-types";

type VenuePublicStatus = "pending" | "published" | "hidden";

type Venue = {
  id: string;
  name: string;
  instagramHandle: string;
  category: string;
  location: string | null;
  hoursSource: "google" | "manual" | "none" | "osm" | null;
  hoursJson: string | null;
  hoursFetchedAt: number | null;
  hoursExpiresAt: number | null;
  hoursError: string | null;
  scrapeActive: boolean;
  publicStatus: VenuePublicStatus;
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

type VenueFormState = {
  name: string;
  instagramHandle: string;
  category: string;
  location: string;
  manualOpeningHours: string;
  scrapeActive: boolean;
  publicStatus: VenuePublicStatus;
};

type VenueScrapingFilter = "all" | "scraping" | "paused";
type VenuePublicationFilter = "all" | VenuePublicStatus;
type VenueSortMode = "name" | "updated_desc" | "handle";

const EMPTY_FORM: VenueFormState = {
  name: "",
  instagramHandle: "",
  category: DEFAULT_VENUE_CATEGORY,
  location: "",
  manualOpeningHours: "",
  scrapeActive: true,
  publicStatus: "pending",
};

function VenueCategorySelect({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <select
      className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
      onChange={(event) => onChange(event.target.value)}
      value={value || DEFAULT_VENUE_CATEGORY}
    >
      {CANONICAL_VENUE_CATEGORIES.map((category) => (
        <option key={category} value={category}>
          {category}
        </option>
      ))}
    </select>
  );
}

function normalizeHandleInput(value: string): string {
  return value.replace(/^@+/, "").trim().toLowerCase();
}

function formatDateTime(value: number): string {
  return new Date(value).toLocaleString();
}

function formatOptionalDateTime(value: number | null): string | null {
  return value ? formatDateTime(value) : null;
}

function getManualOpeningHoursInput(venue: Venue): string {
  if (venue.hoursSource !== "manual" || !venue.hoursJson) {
    return "";
  }

  try {
    const parsed = JSON.parse(venue.hoursJson) as { raw?: { opening_hours?: unknown } };
    return typeof parsed.raw?.opening_hours === "string" ? parsed.raw.opening_hours : "";
  } catch {
    return "";
  }
}

function getVenueHoursLabel(venue: Venue): string {
  if (venue.hoursSource === "manual") {
    return "Manual hours";
  }
  if (venue.hoursSource === "osm") {
    return "OSM hours";
  }
  if (venue.hoursSource === "none") {
    return "No OSM hours";
  }
  if (venue.hoursSource === "google") {
    return "Google hours";
  }
  return "Hours missing";
}

function searchableText(value: string): string {
  return value.toLowerCase().trim();
}

export function VenueManager() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<VenueImportResponse | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importCategory, setImportCategory] = useState<string>(DEFAULT_VENUE_CATEGORY);
  const [createForm, setCreateForm] = useState<VenueFormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingVenueId, setEditingVenueId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<VenueFormState>(EMPTY_FORM);
  const [busyVenueId, setBusyVenueId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [scrapingFilter, setScrapingFilter] = useState<VenueScrapingFilter>("all");
  const [publicationFilter, setPublicationFilter] =
    useState<VenuePublicationFilter>("all");
  const [sortMode, setSortMode] = useState<VenueSortMode>("updated_desc");

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
          name: createForm.name.trim(),
          instagramHandle: normalizeHandleInput(createForm.instagramHandle),
          category: createForm.category.trim(),
          location: createForm.location.trim() || undefined,
          scrapeActive: createForm.scrapeActive,
          publicStatus: createForm.publicStatus,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to create venue.");
      }

      setCreateForm(EMPTY_FORM);
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
      formData.set("category", importCategory || DEFAULT_VENUE_CATEGORY);
      formData.set("scrapeActive", "true");
      formData.set("publicStatus", "pending");

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

  function startEditing(venue: Venue) {
    setEditingVenueId(venue.id);
    setEditForm({
      name: venue.name,
      instagramHandle: venue.instagramHandle,
      category: venue.category,
      location: venue.location ?? "",
      manualOpeningHours: getManualOpeningHoursInput(venue),
      scrapeActive: venue.scrapeActive,
      publicStatus: venue.publicStatus,
    });
  }

  function cancelEditing() {
    setEditingVenueId(null);
    setEditForm(EMPTY_FORM);
  }

  async function updateVenue(venueId: string) {
    setBusyVenueId(venueId);
    setError(null);
    try {
      const response = await fetch("/api/admin/venues", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: venueId,
          patch: {
            name: editForm.name.trim(),
            instagramHandle: normalizeHandleInput(editForm.instagramHandle),
            category: editForm.category.trim(),
            location: editForm.location.trim() || undefined,
            scrapeActive: editForm.scrapeActive,
            publicStatus: editForm.publicStatus,
            ...(editForm.manualOpeningHours.trim()
              ? { manualOpeningHours: editForm.manualOpeningHours.trim() }
              : {}),
          },
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to update venue.");
      }
      cancelEditing();
      await loadVenues();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Unknown update venue error.",
      );
    } finally {
      setBusyVenueId(null);
    }
  }

  async function updateVenueLifecycle(
    venue: Venue,
    patch: Partial<Pick<Venue, "scrapeActive" | "publicStatus">>,
  ) {
    setBusyVenueId(venue.id);
    setError(null);
    try {
      const response = await fetch("/api/admin/venues", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: venue.id,
          patch,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to update venue lifecycle.");
      }
      await loadVenues();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unknown venue lifecycle update error.",
      );
    } finally {
      setBusyVenueId(null);
    }
  }

  async function clearVenueHours(venue: Venue) {
    setBusyVenueId(venue.id);
    setError(null);
    try {
      const response = await fetch("/api/admin/venues", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: venue.id,
          patch: {
            clearVenueHours: true,
          },
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to clear venue hours.");
      }
      await loadVenues();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unknown clear venue hours error.",
      );
    } finally {
      setBusyVenueId(null);
    }
  }

  async function deleteVenue(venue: Venue) {
    const confirmed = window.confirm(
      `Remove ${venue.name} (@${venue.instagramHandle}) from the venue list?`,
    );
    if (!confirmed) {
      return;
    }

    setBusyVenueId(venue.id);
    setError(null);
    try {
      const response = await fetch("/api/admin/venues", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: venue.id }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to remove venue.");
      }
      if (editingVenueId === venue.id) {
        cancelEditing();
      }
      await loadVenues();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Unknown delete venue error.",
      );
    } finally {
      setBusyVenueId(null);
    }
  }

  const filteredVenues = useMemo(() => {
    const query = searchableText(searchQuery);
    const next = venues.filter((venue) => {
      if (scrapingFilter === "scraping" && !venue.scrapeActive) {
        return false;
      }
      if (scrapingFilter === "paused" && venue.scrapeActive) {
        return false;
      }
      if (publicationFilter !== "all" && venue.publicStatus !== publicationFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = searchableText(
        [
          venue.name,
          venue.instagramHandle,
          venue.category,
          venue.location ?? "",
          venue.hoursSource ?? "",
        ].join(" "),
      );
      return haystack.includes(query);
    });

    next.sort((left, right) => {
      if (sortMode === "name") {
        return left.name.localeCompare(right.name);
      }
      if (sortMode === "handle") {
        return left.instagramHandle.localeCompare(right.instagramHandle);
      }
      return right.updatedAt - left.updatedAt;
    });

    return next;
  }, [publicationFilter, scrapingFilter, searchQuery, sortMode, venues]);

  const stats = useMemo(
    () => ({
      total: venues.length,
      scraping: venues.filter((venue) => venue.scrapeActive).length,
      published: venues.filter((venue) => venue.publicStatus === "published").length,
      filtered: filteredVenues.length,
    }),
    [filteredVenues.length, venues],
  );

  return (
    <section className="space-y-6 rounded-3xl border border-border bg-card p-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-border bg-background/80 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Total venues</p>
          <p className="mt-2 text-3xl font-semibold">{stats.total}</p>
        </div>
        <div className="rounded-2xl border border-border bg-background/80 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Scraping</p>
          <p className="mt-2 text-3xl font-semibold">{stats.scraping}</p>
        </div>
        <div className="rounded-2xl border border-border bg-background/80 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Published</p>
          <p className="mt-2 text-3xl font-semibold">{stats.published}</p>
        </div>
        <div className="rounded-2xl border border-border bg-background/80 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Visible now</p>
          <p className="mt-2 text-3xl font-semibold">{stats.filtered}</p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="space-y-4 rounded-2xl border border-border bg-background/70 p-4">
          <div>
            <h2 className="text-lg font-semibold">Add venue</h2>
            <p className="text-sm text-muted-foreground">
              Canonical venue names here are reused during AI normalization.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <input
              className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="Venue name"
              value={createForm.name}
            />
            <input
              className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
              onChange={(event) =>
                setCreateForm((current) => ({
                  ...current,
                  instagramHandle: event.target.value,
                }))
              }
              placeholder="@instagram_handle"
              value={createForm.instagramHandle}
            />
            <VenueCategorySelect
              onChange={(category) => setCreateForm((current) => ({ ...current, category }))}
              value={createForm.category}
            />
            <input
              className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, location: event.target.value }))
              }
              placeholder="Location (optional)"
              value={createForm.location}
            />
            <label className="flex items-center gap-2 rounded-xl border border-input px-3 py-2 text-sm">
              <input
                checked={createForm.scrapeActive}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    scrapeActive: event.target.checked,
                  }))
                }
                type="checkbox"
              />
              Scraping enabled
            </label>
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              Publication
              <select
                className="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    publicStatus: event.target.value as VenuePublicStatus,
                  }))
                }
                value={createForm.publicStatus}
              >
                <option value="pending">Pending review</option>
                <option value="published">Published</option>
                <option value="hidden">Hidden</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSubmitting}
              onClick={() => void createVenue()}
              type="button"
            >
              {isSubmitting ? "Saving..." : "Add venue"}
            </button>
            <button
              className="rounded-xl border border-border px-4 py-2 text-sm font-medium"
              onClick={() => setCreateForm(EMPTY_FORM)}
              type="button"
            >
              Reset
            </button>
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-border bg-background/70 p-4">
          <div>
            <h2 className="text-lg font-semibold">Import CSV</h2>
            <p className="text-sm text-muted-foreground">
              Uses `_ap3a` as Instagram handle and `x1lliihq` as place name.
            </p>
          </div>
          <div className="grid gap-3">
            <input
              accept=".csv,text/csv"
              className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
              onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
              type="file"
            />
            <VenueCategorySelect onChange={setImportCategory} value={importCategory} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-xl border border-border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isImporting}
              onClick={() => void importVenuesCsv()}
              type="button"
            >
              {isImporting ? "Importing..." : "Import CSV"}
            </button>
          </div>
          {importError ? <p className="text-sm text-destructive">{importError}</p> : null}
          {importSummary ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                ["Rows", importSummary.totalRows ?? 0],
                ["Valid", importSummary.validRows ?? 0],
                ["Created", importSummary.created ?? 0],
                ["Updated", importSummary.updated ?? 0],
                ["Unchanged", importSummary.unchanged ?? 0],
                ["Skipped dupes", importSummary.skippedDuplicateHandle ?? 0],
              ].map(([label, value]) => (
                <div className="rounded-xl border border-border p-3" key={label}>
                  <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                    {label}
                  </p>
                  <p className="mt-1 text-xl font-semibold">{value}</p>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>

      <section className="space-y-4 rounded-2xl border border-border bg-background/70 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Venue list</h2>
            <p className="text-sm text-muted-foreground">
              Search, edit, activate, or delete venues used by normalization.
            </p>
          </div>
          <button
            className="rounded-xl border border-border px-4 py-2 text-sm font-medium"
            onClick={() => void loadVenues()}
            type="button"
          >
            Refresh list
          </button>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_160px_170px_180px]">
          <input
            className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search by name, handle, category, or location"
            value={searchQuery}
          />
          <select
            aria-label="Scraping filter"
            className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
            onChange={(event) => setScrapingFilter(event.target.value as VenueScrapingFilter)}
            value={scrapingFilter}
          >
            <option value="all">All scraping</option>
            <option value="scraping">Scraping</option>
            <option value="paused">Paused</option>
          </select>
          <select
            aria-label="Publication filter"
            className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
            onChange={(event) =>
              setPublicationFilter(event.target.value as VenuePublicationFilter)
            }
            value={publicationFilter}
          >
            <option value="all">All publication</option>
            <option value="pending">Pending</option>
            <option value="published">Published</option>
            <option value="hidden">Hidden</option>
          </select>
          <select
            className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
            onChange={(event) => setSortMode(event.target.value as VenueSortMode)}
            value={sortMode}
          >
            <option value="updated_desc">Recently updated</option>
            <option value="name">Name A-Z</option>
            <option value="handle">Handle A-Z</option>
          </select>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {isLoading ? <p className="text-sm text-muted-foreground">Loading venues...</p> : null}

        {!isLoading && filteredVenues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No venues match the current filters.</p>
        ) : null}

        <div className="space-y-3">
          {filteredVenues.map((venue) => {
            const isEditing = editingVenueId === venue.id;
            const isBusy = busyVenueId === venue.id;
            return (
              <article
                className="rounded-2xl border border-border bg-card/90 p-4"
                key={venue.id}
              >
                {isEditing ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-2">
                      <input
                        className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
                        onChange={(event) =>
                          setEditForm((current) => ({ ...current, name: event.target.value }))
                        }
                        placeholder="Venue name"
                        value={editForm.name}
                      />
                      <input
                        className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
                        onChange={(event) =>
                          setEditForm((current) => ({
                            ...current,
                            instagramHandle: event.target.value,
                          }))
                        }
                        placeholder="@instagram_handle"
                        value={editForm.instagramHandle}
                      />
                      <VenueCategorySelect
                        onChange={(category) => setEditForm((current) => ({ ...current, category }))}
                        value={editForm.category}
                      />
                      <input
                        className="rounded-xl border border-input bg-background px-3 py-2 text-sm"
                        onChange={(event) =>
                          setEditForm((current) => ({ ...current, location: event.target.value }))
                        }
                        placeholder="Location"
                        value={editForm.location}
                      />
                      <input
                        className="rounded-xl border border-input bg-background px-3 py-2 text-sm md:col-span-2"
                        onChange={(event) =>
                          setEditForm((current) => ({
                            ...current,
                            manualOpeningHours: event.target.value,
                          }))
                        }
                        placeholder="Manual opening_hours, e.g. Mo-Su 18:00-02:00"
                        value={editForm.manualOpeningHours}
                      />
                      <label className="flex items-center gap-2 rounded-xl border border-input px-3 py-2 text-sm">
                        <input
                          checked={editForm.scrapeActive}
                          onChange={(event) =>
                            setEditForm((current) => ({
                              ...current,
                              scrapeActive: event.target.checked,
                            }))
                          }
                          type="checkbox"
                        />
                        Scraping enabled
                      </label>
                      <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                        Publication
                        <select
                          className="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground"
                          onChange={(event) =>
                            setEditForm((current) => ({
                              ...current,
                              publicStatus: event.target.value as VenuePublicStatus,
                            }))
                          }
                          value={editForm.publicStatus}
                        >
                          <option value="pending">Pending review</option>
                          <option value="published">Published</option>
                          <option value="hidden">Hidden</option>
                        </select>
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isBusy}
                        onClick={() => void updateVenue(venue.id)}
                        type="button"
                      >
                        {isBusy ? "Saving..." : "Save changes"}
                      </button>
                      <button
                        className="rounded-xl border border-border px-4 py-2 text-sm font-medium"
                        onClick={cancelEditing}
                        type="button"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-base font-semibold">{venue.name}</p>
                        <span
                          className={`rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide ${
                            venue.scrapeActive
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-slate-200 text-slate-700"
                          }`}
                        >
                          Scraping: {venue.scrapeActive ? "enabled" : "paused"}
                        </span>
                        <span className="rounded-full bg-blue-100 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-blue-800">
                          Publication: {venue.publicStatus}
                        </span>
                        <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {venue.category}
                        </span>
                        <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {getVenueHoursLabel(venue)}
                        </span>
                      </div>
                      <div className="space-y-1 text-sm text-muted-foreground">
                        <p>@{venue.instagramHandle}</p>
                        {venue.location ? <p>{venue.location}</p> : null}
                        {formatOptionalDateTime(venue.hoursFetchedAt) ? (
                          <p>Hours checked {formatOptionalDateTime(venue.hoursFetchedAt)}</p>
                        ) : null}
                        {venue.hoursError ? <p>{venue.hoursError}</p> : null}
                        <p>Updated {formatDateTime(venue.updatedAt)}</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <a
                        className="rounded-xl border border-border px-3 py-2 text-sm font-medium"
                        href={`https://www.instagram.com/${venue.instagramHandle}/`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Open Instagram
                      </a>
                      <button
                        className="rounded-xl border border-border px-3 py-2 text-sm font-medium"
                        onClick={() => startEditing(venue)}
                        type="button"
                      >
                        Edit
                      </button>
                      {venue.hoursSource && venue.hoursSource !== "none" ? (
                        <button
                          className="rounded-xl border border-border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={isBusy}
                          onClick={() => void clearVenueHours(venue)}
                          type="button"
                        >
                          Clear hours
                        </button>
                      ) : null}
                      <button
                        className="rounded-xl border border-border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isBusy}
                        onClick={() =>
                          void updateVenueLifecycle(venue, {
                            scrapeActive: !venue.scrapeActive,
                          })
                        }
                        type="button"
                      >
                        {venue.scrapeActive ? "Pause scraping" : "Enable scraping"}
                      </button>
                      <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                        Publication
                        <select
                          className="rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60"
                          disabled={isBusy}
                          onChange={(event) =>
                            void updateVenueLifecycle(venue, {
                              publicStatus: event.target.value as VenuePublicStatus,
                            })
                          }
                          value={venue.publicStatus}
                        >
                          <option value="pending">Pending</option>
                          <option value="published">Published</option>
                          <option value="hidden">Hidden</option>
                        </select>
                      </label>
                      <button
                        className="rounded-xl border border-destructive px-3 py-2 text-sm font-medium text-destructive disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isBusy}
                        onClick={() => void deleteVenue(venue)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}
