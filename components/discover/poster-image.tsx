"use client";

import Image, { type ImageProps } from "next/image";
import type { ReactNode } from "react";
import { useState } from "react";

type PosterImageProps = Omit<ImageProps, "alt" | "onError"> & {
  alt: string;
  fallback: ReactNode;
};

export function PosterImage({ alt, fallback, src, ...props }: PosterImageProps) {
  const [hasFailed, setHasFailed] = useState(false);

  if (!src || hasFailed) {
    return <>{fallback}</>;
  }

  return (
    <Image
      {...props}
      alt={alt}
      src={src}
      onError={() => {
        setHasFailed(true);
      }}
    />
  );
}
