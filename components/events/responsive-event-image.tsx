import type { ImgHTMLAttributes } from "react";
import { getResponsiveEventImageSrcSet, getResponsiveEventImageUrl } from "@/lib/images/responsive-image-url";

type ResponsiveEventImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "srcSet" | "sizes"> & {
  src: string;
  alt: string;
  sizes: string;
  fill?: boolean;
  priority?: boolean;
  version?: string | number;
};

// The event proxy owns its finite width set and format negotiation. Native
// srcset lets browsers choose for their actual slot and DPR without a second
// image optimizer or allowing arbitrary remote transformation URLs.
export function ResponsiveEventImage({
  src, sizes, fill, priority = false, version, style, loading, decoding = "async", fetchPriority, ...props
}: ResponsiveEventImageProps) {
  const srcSet = getResponsiveEventImageSrcSet(src, version);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- First-party bounded image derivatives provide srcset directly.
    <img
      {...props}
      alt={props.alt}
      decoding={decoding}
      fetchPriority={fetchPriority ?? (priority ? "high" : undefined)}
      height={fill ? undefined : props.height}
      loading={priority ? "eager" : loading ?? "lazy"}
      sizes={srcSet ? sizes : undefined}
      src={getResponsiveEventImageUrl(src, 768, version) ?? src}
      srcSet={srcSet}
      style={fill ? { position: "absolute", height: "100%", width: "100%", inset: 0, ...style } : style}
      width={fill ? undefined : props.width}
    />
  );
}
