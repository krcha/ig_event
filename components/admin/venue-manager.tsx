"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog, DropdownMenu } from "radix-ui";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  MapPin,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Upload,
  X,
} from "lucide-react";
import {
  CANONICAL_VENUE_CATEGORIES,
  DEFAULT_VENUE_CATEGORY,
} from "@/lib/taxonomy/venue-types";
import { parseVenueHoursJson } from "@/lib/venues/venue-hours-cache";
import { VenueBulkEdit } from "@/components/admin/venue-bulk-edit";

type VenuePublicStatus = "pending" | "published" | "hidden";

type Venue = {
  id: string;
  name: string;
  instagramHandle: string;
  aliases: string[];
  category: string;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
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
  aliasesText: string;
  category: string;
  location: string;
  latitude: string;
  longitude: string;
  manualOpeningHours: string;
  scrapeActive: boolean;
  publicStatus: VenuePublicStatus;
};

type VenueScrapingFilter = "all" | "scraping" | "paused";
type VenuePublicationFilter = "all" | VenuePublicStatus;
type VenueSortMode = "name" | "updated_desc" | "handle";

const PAGE_SIZE = 25;
const INPUT_CLASS = "min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50";
const BUTTON_CLASS = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

const EMPTY_FORM: VenueFormState = {
  name: "",
  instagramHandle: "",
  aliasesText: "",
  category: DEFAULT_VENUE_CATEGORY,
  location: "",
  latitude: "",
  longitude: "",
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
      className={INPUT_CLASS}
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

function parseAliasInput(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((alias) => alias.trim())
    .filter(Boolean);
}

function parseVenueCoordinates(form: VenueFormState): {
  latitude?: number;
  longitude?: number;
} {
  const latitudeText = form.latitude.trim();
  const longitudeText = form.longitude.trim();
  if (!latitudeText && !longitudeText) {
    return {};
  }
  if (!latitudeText || !longitudeText) {
    throw new Error("Enter both latitude and longitude to set a map location.");
  }

  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    (latitude === 0 && longitude === 0)
  ) {
    throw new Error("Enter valid map coordinates: latitude from -90 to 90 and longitude from -180 to 180. The location cannot be 0, 0.");
  }
  return { latitude, longitude };
}

function VenueCoordinateInputs({
  form,
  isEditing = false,
  onChange,
}: {
  form: VenueFormState;
  isEditing?: boolean;
  onChange: (field: "latitude" | "longitude", value: string) => void;
}) {
  const helpId = isEditing ? "edit-venue-map-location-help" : "create-venue-map-location-help";
  return (
    <fieldset className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-medium">Map coordinates</legend>
      <label className="grid gap-1.5 text-sm text-muted-foreground">
        Latitude
        <input
          aria-describedby={helpId}
          className={INPUT_CLASS}
          max={90}
          min={-90}
          onChange={(event) => onChange("latitude", event.target.value)}
          step="any"
          type="number"
          value={form.latitude}
        />
      </label>
      <label className="grid gap-1.5 text-sm text-muted-foreground">
        Longitude
        <input
          aria-describedby={helpId}
          className={INPUT_CLASS}
          max={180}
          min={-180}
          onChange={(event) => onChange("longitude", event.target.value)}
          step="any"
          type="number"
          value={form.longitude}
        />
      </label>
      <p className="text-xs text-muted-foreground sm:col-span-2" id={helpId}>
        {isEditing ? "Leave both blank to keep the current map location." : "Optional. Enter both coordinates to place this venue on the map."}
      </p>
    </fieldset>
  );
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
  const hours = parseVenueHoursJson(venue.hoursJson);
  if (!hours?.weekly.some((day) => day.closed || day.windows.length > 0)) {
    return "Missing";
  }
  if (venue.hoursSource === "manual") {
    return "Manual";
  }
  if (venue.hoursSource === "osm") {
    return "OpenStreetMap";
  }
  if (venue.hoursSource === "none") {
    return "Missing";
  }
  if (venue.hoursSource === "google") {
    return "Google";
  }
  return "Missing";
}

function VenueFormFields({
  form,
  isEditing = false,
  onChange,
}: {
  form: VenueFormState;
  isEditing?: boolean;
  onChange: (patch: Partial<VenueFormState>) => void;
}) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <label className="grid gap-1.5 text-sm font-medium">
        Venue name
        <input autoComplete="off" className={INPUT_CLASS} onChange={(event) => onChange({ name: event.target.value })} required value={form.name} />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Instagram handle
        <input autoCapitalize="none" autoComplete="off" className={INPUT_CLASS} onChange={(event) => onChange({ instagramHandle: event.target.value })} placeholder="@instagram_handle" required spellCheck={false} value={form.instagramHandle} />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Type
        <VenueCategorySelect onChange={(category) => onChange({ category })} value={form.category} />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Address
        <input className={INPUT_CLASS} onChange={(event) => onChange({ location: event.target.value })} placeholder="Street, city" value={form.location} />
      </label>
      <VenueCoordinateInputs form={form} isEditing={isEditing} onChange={(field, value) => onChange({ [field]: value })} />
      <label className="grid gap-1.5 text-sm font-medium sm:col-span-2">
        Aliases
        <textarea className={`${INPUT_CLASS} min-h-20 resize-y`} onChange={(event) => onChange({ aliasesText: event.target.value })} placeholder="One name per line" rows={2} value={form.aliasesText} />
      </label>
      {isEditing ? (
        <label className="grid gap-1.5 text-sm font-medium sm:col-span-2">
          Opening hours
          <input className={`${INPUT_CLASS} font-mono`} onChange={(event) => onChange({ manualOpeningHours: event.target.value })} placeholder="Mo-Su 18:00-02:00" value={form.manualOpeningHours} />
          <span className="text-xs font-normal text-muted-foreground">Use opening_hours format. Leave blank to keep saved hours.</span>
        </label>
      ) : null}
      <label className="grid gap-1.5 text-sm font-medium">
        Publication
        <select className={INPUT_CLASS} onChange={(event) => onChange({ publicStatus: event.target.value as VenuePublicStatus })} value={form.publicStatus}>
          <option value="pending">Pending</option>
          <option value="published">Published</option>
          <option value="hidden">Hidden</option>
        </select>
      </label>
      <label className="flex min-h-11 items-center gap-3 self-end rounded-lg border border-input px-3 py-2 text-sm">
        <input checked={form.scrapeActive} className="size-4 accent-primary" onChange={(event) => onChange({ scrapeActive: event.target.checked })} type="checkbox" />
        Scraping enabled
      </label>
    </div>
  );
}

function VenueDialog({
  busy = false,
  children,
  onOpenChange,
  open,
  restoreFocus,
  title,
}: {
  busy?: boolean;
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  restoreFocus: () => void;
  title: string;
}) {
  return (
    <Dialog.Root onOpenChange={(nextOpen) => { if (!busy) onOpenChange(nextOpen); }} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-2xl outline-none"
          onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-3 sm:px-6">
            <Dialog.Title className="min-w-0 truncate text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close aria-label="Close dialog" className={`${BUTTON_CLASS} shrink-0 border-transparent px-3`} disabled={busy}>
              <X aria-hidden="true" className="size-4" />
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function searchableText(value: string): string {
  return value.toLowerCase().trim();
}

export function VenueManager() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
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
  const [page, setPage] = useState(1);
  const [selectedVenueIds, setSelectedVenueIds] = useState<Set<string>>(new Set());
  const [isBulkEditOpen, setIsBulkEditOpen] = useState(false);
  const [isBulkEditing, setIsBulkEditing] = useState(false);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);

  function setImportDialogOpen(open: boolean) {
    if (isImporting) return;
    setIsImportOpen(open);
    if (!open) {
      setImportFile(null);
      setImportError(null);
      setImportSummary(null);
    }
  }

  function restoreDialogFocus() {
    if (dialogTriggerRef.current?.isConnected) {
      dialogTriggerRef.current.focus();
    } else {
      searchRef.current?.focus();
    }
  }

  async function loadVenues(options: { preserveOnError?: boolean } = {}): Promise<boolean> {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/venues", { cache: "no-store" });
      const payload = (await response.json()) as VenueListResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load venues.");
      }
      setVenues(payload.venues);
      return true;
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Unknown venue load error.",
      );
      if (!options.preserveOnError) setVenues([]);
      return false;
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadVenues();
  }, []);

  async function createVenue() {
    setIsSubmitting(true);
    setFormError(null);
    setSuccess(null);
    try {
      const coordinates = parseVenueCoordinates(createForm);
      const response = await fetch("/api/admin/venues", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: createForm.name.trim(),
          instagramHandle: normalizeHandleInput(createForm.instagramHandle),
          aliases: parseAliasInput(createForm.aliasesText),
          category: createForm.category.trim(),
          location: createForm.location.trim() || undefined,
          ...coordinates,
          scrapeActive: createForm.scrapeActive,
          publicStatus: createForm.publicStatus,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to create venue.");
      }

      setCreateForm(EMPTY_FORM);
      setIsCreateOpen(false);
      setSuccess("Venue added.");
      await loadVenues();
    } catch (caughtError) {
      setFormError(
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
    setSuccess(null);
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
      if (importFileInputRef.current) {
        importFileInputRef.current.value = "";
      }
      setSuccess("CSV import completed.");
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
    setFormError(null);
    setEditingVenueId(venue.id);
    setEditForm({
      name: venue.name,
      instagramHandle: venue.instagramHandle,
      aliasesText: venue.aliases.join("\n"),
      category: venue.category,
      location: venue.location ?? "",
      latitude: venue.latitude == null ? "" : String(venue.latitude),
      longitude: venue.longitude == null ? "" : String(venue.longitude),
      manualOpeningHours: getManualOpeningHoursInput(venue),
      scrapeActive: venue.scrapeActive,
      publicStatus: venue.publicStatus,
    });
  }

  function cancelEditing() {
    setEditingVenueId(null);
    setEditForm(EMPTY_FORM);
    setFormError(null);
  }

  async function updateVenue(venueId: string) {
    setBusyVenueId(venueId);
    setFormError(null);
    setSuccess(null);
    try {
      const coordinates = parseVenueCoordinates(editForm);
      const response = await fetch("/api/admin/venues", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: venueId,
          patch: {
            name: editForm.name.trim(),
            instagramHandle: normalizeHandleInput(editForm.instagramHandle),
            aliases: parseAliasInput(editForm.aliasesText),
            category: editForm.category.trim(),
            location: editForm.location.trim() || undefined,
            ...coordinates,
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
      setSuccess("Venue saved.");
      await loadVenues();
    } catch (caughtError) {
      setFormError(
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
    setSuccess(null);
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
      setSuccess(`${venue.name} updated.`);
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
    setFormError(null);
    setSuccess(null);
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
      if (editingVenueId === venue.id) {
        setEditForm((current) => ({ ...current, manualOpeningHours: "" }));
      }
      setSuccess(`Hours cleared for ${venue.name}.`);
      await loadVenues();
    } catch (caughtError) {
      const setHoursError = editingVenueId === venue.id ? setFormError : setError;
      setHoursError(
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
    setSuccess(null);
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
      setSuccess(`${venue.name} hidden and scraping paused.`);
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
          ...venue.aliases,
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

  const pageCount = Math.max(1, Math.ceil(filteredVenues.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const firstRow = (currentPage - 1) * PAGE_SIZE;
  const visibleVenues = filteredVenues.slice(firstRow, firstRow + PAGE_SIZE);
  const editingVenue = venues.find((venue) => venue.id === editingVenueId);
  const isMutating = Boolean(busyVenueId) || isSubmitting || isImporting || isBulkEditing;
  const hasFilters = Boolean(searchQuery) || scrapingFilter !== "all" || publicationFilter !== "all";
  const selectedVenues = venues.filter((venue) => selectedVenueIds.has(venue.id));
  const selectedVisibleCount = visibleVenues.filter((venue) => selectedVenueIds.has(venue.id)).length;
  const allVisibleSelected = visibleVenues.length > 0 && selectedVisibleCount === visibleVenues.length;

  function toggleVenueSelection(venueId: string) {
    setSelectedVenueIds((current) => {
      const next = new Set(current);
      if (next.has(venueId)) next.delete(venueId);
      else next.add(venueId);
      return next;
    });
  }

  function toggleVisibleSelection() {
    setSelectedVenueIds((current) => {
      const next = new Set(current);
      for (const venue of visibleVenues) {
        if (allVisibleSelected) next.delete(venue.id);
        else next.add(venue.id);
      }
      return next;
    });
  }

  function resetFilters() {
    setSearchQuery("");
    setScrapingFilter("all");
    setPublicationFilter("all");
    setPage(1);
    setSelectedVenueIds(new Set());
  }

  return (
    <section aria-label="Venue management" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div aria-live="polite" className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
          <span><strong className="font-semibold tabular-nums text-foreground">{stats.total}</strong> venues</span>
          <span><span className="mr-1.5 inline-block size-1.5 rounded-full bg-emerald-400" /><strong className="font-medium tabular-nums text-foreground">{stats.scraping}</strong> scraping</span>
          <span><strong className="font-medium tabular-nums text-foreground">{stats.published}</strong> published</span>
        </div>
        <div className="flex items-center gap-2">
          <button className={BUTTON_CLASS} disabled={isMutating} onClick={(event) => { dialogTriggerRef.current = event.currentTarget; setImportDialogOpen(true); }} type="button">
            <Upload aria-hidden="true" className="size-4" /> Import CSV
          </button>
          <button className={PRIMARY_BUTTON_CLASS} disabled={isMutating} onClick={(event) => { dialogTriggerRef.current = event.currentTarget; setFormError(null); setIsCreateOpen(true); }} type="button">
            <Plus aria-hidden="true" className="size-4" /> Add venue
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="grid grid-cols-2 gap-3 border-b border-border p-4 lg:grid-cols-[minmax(180px,1fr)_145px_150px_175px_44px]">
          <label className="relative col-span-2 block lg:col-span-1">
            <span className="sr-only">Search venues</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
            <input className={`${INPUT_CLASS} pl-9 pr-10`} disabled={isBulkEditing} onChange={(event) => { setSearchQuery(event.target.value); setPage(1); setSelectedVenueIds(new Set()); }} placeholder="Search venues..." ref={searchRef} type="search" value={searchQuery} />
          </label>
          <label className="grid gap-1">
            <span className="sr-only">Scraping filter</span>
            <select aria-label="Scraping filter" className={INPUT_CLASS} disabled={isBulkEditing} onChange={(event) => { setScrapingFilter(event.target.value as VenueScrapingFilter); setPage(1); setSelectedVenueIds(new Set()); }} value={scrapingFilter}>
              <option value="all">All scraping</option>
              <option value="scraping">Scraping</option>
              <option value="paused">Paused</option>
            </select>
          </label>
          <label className="grid gap-1">
            <span className="sr-only">Publication filter</span>
            <select aria-label="Publication filter" className={INPUT_CLASS} disabled={isBulkEditing} onChange={(event) => { setPublicationFilter(event.target.value as VenuePublicationFilter); setPage(1); setSelectedVenueIds(new Set()); }} value={publicationFilter}>
              <option value="all">All publication</option>
              <option value="pending">Pending</option>
              <option value="published">Published</option>
              <option value="hidden">Hidden</option>
            </select>
          </label>
          <label className="grid gap-1">
            <span className="sr-only">Sort venues</span>
            <select aria-label="Sort venues" className={INPUT_CLASS} onChange={(event) => { setSortMode(event.target.value as VenueSortMode); setPage(1); }} value={sortMode}>
              <option value="updated_desc">Recently updated</option>
              <option value="name">Name A-Z</option>
              <option value="handle">Handle A-Z</option>
            </select>
          </label>
          <button aria-label="Refresh venues" className={`${BUTTON_CLASS} w-11 justify-self-end px-3`} disabled={isLoading || isMutating} onClick={() => void loadVenues()} title="Refresh venues" type="button">
            <RefreshCw aria-hidden="true" className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {error ? (
          <div className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-sm" role="alert">
            <p>{error}</p>
            <button className={BUTTON_CLASS} disabled={isLoading || isMutating} onClick={() => void loadVenues()} type="button">Retry</button>
          </div>
        ) : null}
        {success && !error ? (
          <div className="flex items-center justify-between gap-3 border-b border-border bg-emerald-400/5 px-4 py-2 text-sm" role="status">
            <p className="flex items-center gap-2"><Check aria-hidden="true" className="size-4 text-emerald-400" />{success}</p>
            <button aria-label="Dismiss notification" className={`${BUTTON_CLASS} border-transparent px-3`} onClick={() => setSuccess(null)} type="button"><X aria-hidden="true" className="size-4" /></button>
          </div>
        ) : null}
        {hasFilters ? (
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 text-xs text-muted-foreground">
            <span><strong className="font-medium text-foreground">{stats.filtered}</strong> of {stats.total} venues</span>
            <button className="min-h-11 px-2 font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={resetFilters} type="button">Clear filters</button>
          </div>
        ) : null}

        {selectedVenueIds.size > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/20 bg-primary/5 px-4 py-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <p aria-live="polite" className="text-sm font-medium"><span className="tabular-nums">{selectedVenueIds.size}</span> selected</p>
              {selectedVenueIds.size < filteredVenues.length ? <button className="min-h-11 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" disabled={isLoading || isMutating} onClick={() => setSelectedVenueIds(new Set(filteredVenues.map((venue) => venue.id)))} type="button">Select all {filteredVenues.length} matching</button> : null}
            </div>
            <div className="flex items-center gap-2">
              <button className={BUTTON_CLASS} disabled={isLoading || isMutating} onClick={() => setSelectedVenueIds(new Set())} type="button">Clear selection</button>
              <button className={PRIMARY_BUTTON_CLASS} disabled={isLoading || isMutating || selectedVenues.length === 0} onClick={(event) => { dialogTriggerRef.current = event.currentTarget; setIsBulkEditOpen(true); }} type="button">Edit selected</button>
            </div>
          </div>
        ) : null}

        <div aria-busy={isLoading} aria-label="Venues table, scroll horizontally to see all columns" className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" role="region" tabIndex={0}>
          <table className="w-full min-w-[1120px] border-collapse text-left text-sm">
            <caption className="sr-only">Venues with Instagram, type, location, hours, publication and scraping controls.</caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                <th className="sticky left-0 z-10 w-[240px] min-w-[240px] bg-card px-4 py-1 font-medium" scope="col">
                  <label className="inline-flex min-h-11 cursor-pointer items-center gap-3">
                    <input aria-label="Select all venues on this page" checked={allVisibleSelected} className="size-4 accent-primary" disabled={isLoading || isMutating || visibleVenues.length === 0} onChange={toggleVisibleSelection} ref={(node) => { if (node) node.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected; }} type="checkbox" />
                    Venue
                  </label>
                </th>
                <th className="px-3 py-3 font-medium" scope="col">Instagram</th>
                <th className="px-3 py-3 font-medium" scope="col">Type</th>
                <th className="w-[19%] min-w-[170px] px-3 py-3 font-medium" scope="col">Location</th>
                <th className="px-3 py-3 font-medium" scope="col">Hours</th>
                <th className="px-3 py-3 font-medium" scope="col">Publication</th>
                <th className="px-3 py-3 font-medium" scope="col">Scraping</th>
                <th className="z-10 bg-card px-3 py-3 text-right font-medium md:sticky md:right-0" scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && venues.length === 0 ? (
                <tr><td className="h-52 px-4 text-center text-muted-foreground" colSpan={8}><span className="inline-flex items-center gap-2"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Loading venues...</span></td></tr>
              ) : null}
              {!isLoading && visibleVenues.length === 0 ? (
                <tr>
                  <td className="h-52 px-4 text-center" colSpan={8}>
                    <p className="font-medium">{error ? "Venues could not be loaded." : hasFilters ? "No matching venues" : "No venues yet"}</p>
                    {hasFilters ? <button className="mt-2 min-h-11 px-3 text-sm text-primary hover:underline" onClick={resetFilters} type="button">Clear filters</button> : null}
                  </td>
                </tr>
              ) : null}
              {visibleVenues.map((venue) => {
                const isBusy = busyVenueId === venue.id;
                const hasCoordinates = venue.latitude != null && venue.longitude != null && Number.isFinite(venue.latitude) && Number.isFinite(venue.longitude) && Math.abs(venue.latitude) <= 90 && Math.abs(venue.longitude) <= 180 && (venue.latitude !== 0 || venue.longitude !== 0);
                const hasHours = getVenueHoursLabel(venue) !== "Missing";
                return (
                  <tr aria-busy={isBusy} aria-selected={selectedVenueIds.has(venue.id)} className="group border-b border-border/70 last:border-b-0 hover:bg-muted/35 aria-selected:bg-primary/5" key={venue.id}>
                    <th className="sticky left-0 z-[1] bg-card px-4 py-2.5 font-normal group-hover:bg-muted" scope="row">
                      <div className="flex items-center gap-1">
                        <label className="-ml-3 inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center"><input aria-label={`Select ${venue.name}`} checked={selectedVenueIds.has(venue.id)} className="size-4 accent-primary" disabled={isLoading || isMutating} onChange={() => toggleVenueSelection(venue.id)} type="checkbox" /></label>
                        <div className="min-w-0"><p className="max-w-[180px] truncate font-medium text-foreground" title={venue.name}>{venue.name}</p>
                          {venue.aliases.length ? <p className="mt-1 max-w-[180px] truncate text-xs text-muted-foreground" title={venue.aliases.join(", ")}>{venue.aliases.join(", ")}</p> : null}</div>
                      </div>
                    </th>
                    <td className="px-3 py-2.5">
                      <a aria-label={`Open @${venue.instagramHandle} on Instagram`} className="inline-flex min-h-11 max-w-[170px] items-center gap-1.5 text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`https://www.instagram.com/${venue.instagramHandle}/`} rel="noreferrer" target="_blank" title={`@${venue.instagramHandle}`}>
                        <span className="truncate">@{venue.instagramHandle}</span><ExternalLink aria-hidden="true" className="size-3 shrink-0" />
                      </a>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs capitalize text-muted-foreground">{venue.category}</td>
                    <td className="px-3 py-2.5">
                      {hasCoordinates ? (
                        <a aria-label={`View ${venue.name} on Google Maps`} className="inline-flex min-h-11 max-w-[210px] items-center gap-1.5 text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`https://www.google.com/maps/search/?api=1&query=${venue.latitude},${venue.longitude}`} rel="noreferrer" target="_blank" title={venue.location ?? `${venue.latitude}, ${venue.longitude}`}>
                          <MapPin aria-hidden="true" className="size-3.5 shrink-0 text-emerald-400" /><span className="truncate">{venue.location || "On map"}</span>
                        </a>
                      ) : (
                        <div className="grid gap-1">
                          {venue.location ? <span className="max-w-[210px] truncate text-xs text-muted-foreground" title={venue.location}>{venue.location}</span> : null}
                          <span className="text-xs text-amber-300/90">Map missing</span>
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span className={`text-xs ${hasHours ? "text-muted-foreground" : "text-amber-300/90"}`} title={venue.hoursError || (formatOptionalDateTime(venue.hoursFetchedAt) ? `Checked ${formatOptionalDateTime(venue.hoursFetchedAt)}` : undefined)}>{getVenueHoursLabel(venue)}</span>
                      {venue.hoursError ? <span className="mt-1 block text-[11px] text-amber-300/90">Check failed</span> : null}
                    </td>
                    <td className="px-3 py-2.5">
                      <select aria-label={`Publication for ${venue.name}`} className={`${INPUT_CLASS} min-w-[116px] ${venue.publicStatus === "published" ? "text-emerald-300" : venue.publicStatus === "pending" ? "text-amber-200" : "text-muted-foreground"}`} disabled={isMutating || isLoading} onChange={(event) => void updateVenueLifecycle(venue, { publicStatus: event.target.value as VenuePublicStatus })} value={venue.publicStatus}>
                        <option value="pending">Pending</option><option value="published">Published</option><option value="hidden">Hidden</option>
                      </select>
                    </td>
                    <td className="px-3 py-2.5">
                      <button aria-checked={venue.scrapeActive} aria-label={`Scraping for ${venue.name}`} className="flex min-h-11 min-w-[88px] items-center gap-2 rounded-lg text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50" disabled={isMutating || isLoading} onClick={() => void updateVenueLifecycle(venue, { scrapeActive: !venue.scrapeActive })} role="switch" type="button">
                        <span aria-hidden="true" className={`flex h-5 w-8 shrink-0 items-center rounded-full px-0.5 transition-colors ${venue.scrapeActive ? "bg-emerald-500/70" : "bg-muted-foreground/30"}`}><span className={`size-4 rounded-full bg-white shadow-sm transition-transform ${venue.scrapeActive ? "translate-x-3" : "translate-x-0"}`} /></span>
                        {venue.scrapeActive ? "On" : "Paused"}
                      </button>
                    </td>
                    <td className="z-[1] bg-card px-3 py-2.5 group-hover:bg-muted md:sticky md:right-0">
                      <div className="flex items-center justify-end gap-1">
                        <button aria-label={`Edit ${venue.name}`} className={BUTTON_CLASS} disabled={isMutating || isLoading} onClick={(event) => { dialogTriggerRef.current = event.currentTarget; startEditing(venue); }} type="button">Edit</button>
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger aria-label={`More actions for ${venue.name}`} className={`${BUTTON_CLASS} border-transparent px-3`} disabled={isMutating || isLoading}>
                            {isBusy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <MoreHorizontal aria-hidden="true" className="size-4" />}
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content align="end" className="z-50 min-w-44 rounded-xl border border-border bg-popover p-1 text-sm text-popover-foreground shadow-xl" sideOffset={5}>
                              {venue.hoursSource && venue.hoursSource !== "none" ? <DropdownMenu.Item className="flex min-h-11 cursor-pointer items-center rounded-lg px-3 outline-none focus:bg-accent" onSelect={() => void clearVenueHours(venue)}>Clear hours</DropdownMenu.Item> : null}
                              <DropdownMenu.Item className="flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-red-400 outline-none focus:bg-destructive/10" onSelect={() => void deleteVenue(venue)}>Delete venue</DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
          <p aria-live="polite" className="text-xs tabular-nums text-muted-foreground">
            {filteredVenues.length ? `${firstRow + 1}-${Math.min(firstRow + PAGE_SIZE, filteredVenues.length)} of ${filteredVenues.length}` : "0 venues"}
          </p>
          <nav aria-label="Venue pagination" className="flex items-center gap-2">
            <button aria-label="Previous page" className={`${BUTTON_CLASS} px-3`} disabled={currentPage === 1} onClick={() => setPage(Math.max(1, currentPage - 1))} type="button"><ChevronLeft aria-hidden="true" className="size-4" /></button>
            <span className="min-w-20 text-center text-xs tabular-nums text-muted-foreground">Page {currentPage} of {pageCount}</span>
            <button aria-label="Next page" className={`${BUTTON_CLASS} px-3`} disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)} type="button"><ChevronRight aria-hidden="true" className="size-4" /></button>
          </nav>
        </footer>
      </div>

      <VenueBulkEdit onBusyChange={setIsBulkEditing} onComplete={async (remainingIds) => { setSelectedVenueIds(new Set(remainingIds)); return loadVenues({ preserveOnError: true }); }} onOpenChange={setIsBulkEditOpen} open={isBulkEditOpen} restoreFocus={restoreDialogFocus} venues={selectedVenues} />

      <VenueDialog busy={isSubmitting} onOpenChange={setIsCreateOpen} open={isCreateOpen} restoreFocus={restoreDialogFocus} title="Add venue">
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void createVenue(); }}>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 sm:p-6">
            <fieldset disabled={isSubmitting}><VenueFormFields form={createForm} onChange={(patch) => setCreateForm((current) => ({ ...current, ...patch }))} /></fieldset>
            {formError ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm" role="alert">{formError}</p> : null}
          </div>
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-4 sm:px-6">
            <button className={BUTTON_CLASS} disabled={isSubmitting} onClick={() => { setCreateForm(EMPTY_FORM); setFormError(null); }} type="button">Reset</button>
            <div className="flex gap-2"><button className={BUTTON_CLASS} disabled={isSubmitting} onClick={() => setIsCreateOpen(false)} type="button">Cancel</button><button className={PRIMARY_BUTTON_CLASS} disabled={isSubmitting} type="submit">{isSubmitting ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}{isSubmitting ? "Saving..." : "Add venue"}</button></div>
          </footer>
        </form>
      </VenueDialog>

      <VenueDialog busy={Boolean(busyVenueId)} onOpenChange={(open) => { if (!open) cancelEditing(); }} open={Boolean(editingVenueId)} restoreFocus={restoreDialogFocus} title="Edit venue">
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); if (editingVenueId) void updateVenue(editingVenueId); }}>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 sm:p-6">
            <fieldset disabled={Boolean(busyVenueId)}><VenueFormFields form={editForm} isEditing onChange={(patch) => setEditForm((current) => ({ ...current, ...patch }))} /></fieldset>
            {editingVenue ? (
              <div className="space-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p>Saved hours: <span className="text-foreground">{getVenueHoursLabel(editingVenue)}</span>{formatOptionalDateTime(editingVenue.hoursFetchedAt) ? ` · Checked ${formatOptionalDateTime(editingVenue.hoursFetchedAt)}` : ""}</p>
                  {editingVenue.hoursSource && editingVenue.hoursSource !== "none" ? <button className={BUTTON_CLASS} disabled={Boolean(busyVenueId)} onClick={() => void clearVenueHours(editingVenue)} type="button">Clear saved hours</button> : null}
                </div>
                {editingVenue.hoursError ? <p className="text-amber-300/90">{editingVenue.hoursError}</p> : null}
                <p>Updated {formatDateTime(editingVenue.updatedAt)}</p>
              </div>
            ) : null}
            {formError ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm" role="alert">{formError}</p> : null}
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-4 sm:px-6">
            <button className={BUTTON_CLASS} disabled={Boolean(busyVenueId)} onClick={cancelEditing} type="button">Cancel</button>
            <button className={PRIMARY_BUTTON_CLASS} disabled={Boolean(busyVenueId)} type="submit">{busyVenueId ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}{busyVenueId ? "Saving..." : "Save changes"}</button>
          </footer>
        </form>
      </VenueDialog>

      <VenueDialog busy={isImporting} onOpenChange={setImportDialogOpen} open={isImportOpen} restoreFocus={restoreDialogFocus} title="Import CSV">
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void importVenuesCsv(); }}>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 sm:p-6">
            <fieldset className="space-y-4" disabled={isImporting}>
              <label className="grid gap-2 text-sm font-medium">CSV file<input accept=".csv,text/csv" className={`${INPUT_CLASS} file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:text-foreground`} onChange={(event) => { setImportFile(event.target.files?.[0] ?? null); setImportSummary(null); setImportError(null); }} ref={importFileInputRef} type="file" /></label>
              <p className="text-xs text-muted-foreground">CSV columns: <code className="text-foreground">_ap3a</code> (Instagram), <code className="text-foreground">x1lliihq</code> (venue name).</p>
              <label className="grid gap-2 text-sm font-medium">Default type<VenueCategorySelect onChange={setImportCategory} value={importCategory} /></label>
            </fieldset>
            {importError ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm" role="alert">{importError}</p> : null}
            {importSummary ? (
              <div className="rounded-lg border border-border p-4" role="status">
                <p className="mb-3 flex items-center gap-2 text-sm font-medium"><Check aria-hidden="true" className="size-4 text-emerald-400" />Import complete</p>
                <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs">
                  {[
                    ["Rows", importSummary.totalRows ?? 0],
                    ["Valid", importSummary.validRows ?? 0],
                    ["Created", importSummary.created ?? 0],
                    ["Updated", importSummary.updated ?? 0],
                    ["Unchanged", importSummary.unchanged ?? 0],
                    ["Duplicate handles", importSummary.skippedDuplicateHandle ?? 0],
                    ["Missing handle", importSummary.skippedMissingHandle ?? 0],
                    ["Missing name", importSummary.skippedMissingName ?? 0],
                  ].map(([label, value]) => <div className="flex items-center justify-between gap-2" key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>)}
                </dl>
              </div>
            ) : null}
          </div>
          <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-4 sm:px-6">
            <button className={BUTTON_CLASS} disabled={isImporting} onClick={() => setImportDialogOpen(false)} type="button">{importSummary ? "Done" : "Cancel"}</button>
            <button className={PRIMARY_BUTTON_CLASS} disabled={isImporting || !importFile} type="submit">{isImporting ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Upload aria-hidden="true" className="size-4" />}{isImporting ? "Importing..." : "Import CSV"}</button>
          </footer>
        </form>
      </VenueDialog>
    </section>
  );
}
