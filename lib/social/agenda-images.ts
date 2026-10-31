import { buildPosterArtwork, buildPosterClosing, type PosterInput } from "./poster-renderer.ts";
import { renderMaterialClosingStill, renderMaterialPosterStill } from "./material-scene.ts";

export { AgendaRenderError } from "./agenda-layout.ts";
export type AgendaPosterInput = PosterInput;
export const STORY_HEIGHT = 1920;
export const STORY_CONTENT_OFFSET = 230;
export function buildAgendaPosterSvg(input: AgendaPosterInput): Buffer { return buildPosterArtwork(input).svg; }
export async function renderAgendaPoster(input: AgendaPosterInput): Promise<Buffer> {
  return renderMaterialPosterStill(input);
}
export function buildClosingCarouselSvg(publishDate?: string): Buffer { return buildPosterClosing(publishDate).svg; }
export async function renderClosingCarouselSlide(publishDate?: string): Promise<Buffer> {
  return renderMaterialClosingStill(publishDate);
}
