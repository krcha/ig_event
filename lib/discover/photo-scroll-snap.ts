export function discoverPhotoSnapTarget(scrollY: number, photoTop: number, direction: number, offset = 12): number | null {
  if (direction <= 0 || scrollY < 0 || photoTop <= offset) return null;
  return Math.max(0, Math.round(scrollY + photoTop - offset));
}
