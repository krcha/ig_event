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

export function VenueManager() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
