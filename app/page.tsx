import EventsBrowsePage from "./(main)/events-browse-page";

// The calendar is backed by external Convex reads. A persisted Next.js route
// cache can outlive ingestion updates and keep serving old event counts, so keep
// the page dynamic and rely on the bounded in-process event loader cache instead.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default EventsBrowsePage;
