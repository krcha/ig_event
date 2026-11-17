let pending: Promise<typeof import("leaflet")> | undefined;

/** Share the map engine between the streaming map shell and route previews. */
export function loadLeaflet(): Promise<typeof import("leaflet")> {
  if (typeof window === "undefined") return Promise.reject(new Error("Maps require a browser."));
  return pending ??= import("leaflet").catch(error => { pending = undefined; throw error; });
}

export function preloadLeaflet(): void {
  if (typeof window !== "undefined") void loadLeaflet().catch(() => undefined);
}
