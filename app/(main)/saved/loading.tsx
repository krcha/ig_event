import { Bookmark, Loader2 } from "lucide-react";

export default function SavedLoading() {
  return <main aria-busy="true" className="app-page gap-3 sm:gap-4"><section className="hero-panel px-4 py-5 sm:px-6 sm:py-7"><h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight sm:text-4xl"><Bookmark aria-hidden="true" className="h-5 w-5" />Saved</h1><p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />Loading saved items...</p></section></main>;
}
